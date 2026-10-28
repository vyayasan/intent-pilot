/**
 * Durable console state behind a StateStore interface.
 *
 * JsonFileStore: the original demo engine - atomic tmp+rename writes of one JSON aggregate.
 * SqliteStore (node:sqlite, experimental in this runtime): WAL journal + synchronous=FULL,
 * single-transaction commits of the aggregate with json_valid CHECK constraints. Wins over
 * tmp+rename: concurrent-writer safety (file locking, not best-effort), a real corruption
 * check (integrity_check on open), and no torn tmp files after kill -9. The aggregate payload
 * is still one JSON document per entity kind - full relational normalization is deferred and
 * tracked in docs/PRODUCTION.md (G4).
 *
 * node:sqlite prints an ExperimentalWarning; it is pinned to this runtime's Node and covered by
 * round-trip + corruption tests, and the engine is selectable (json stays the demo default).
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface PersistedState {
  cases: unknown;
  usedNonces: [string, number][];
  notifications: unknown;
  approverKey: { privateKeyPem: string; keyId: string };
  /** The console's single logical cardholder at the provider - durable so a restart reuses it
   *  instead of creating a duplicate (round-3 N2). */
  holderId?: string | null;
}

export type LoadResult = PersistedState | "corrupted" | null; // null = no state yet

export interface StateStore {
  readonly kind: string;
  load(): LoadResult;
  save(state: PersistedState): void;
}

export class JsonFileStore implements StateStore {
  readonly kind = "json";
  constructor(private path: string) {}
  load(): LoadResult {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PersistedState>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.cases)) return "corrupted";
      return {
        cases: parsed.cases,
        usedNonces: Array.isArray(parsed.usedNonces) ? (parsed.usedNonces as [string, number][]) : [],
        notifications: parsed.notifications ?? [],
        approverKey: (parsed.approverKey as PersistedState["approverKey"]) ?? { privateKeyPem: "", keyId: "" },
        holderId: typeof parsed.holderId === "string" ? parsed.holderId : null
      };
    } catch { return "corrupted"; }
  }
  save(state: PersistedState): void {
    // The file holds the approver private key: 0600 always (review: credential file perms).
    writeFileSync(this.path + ".tmp", JSON.stringify(state), { mode: 0o600 });
    renameSync(this.path + ".tmp", this.path);
    try { chmodSync(this.path, 0o600); } catch { /* best effort on exotic filesystems */ }
  }
}

export class SqliteLeaseError extends Error {}

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/**
 * Single-writer lease: one console process owns the state file. Two consoles whole-aggregate
 * saving against one file would silently LOSE UPDATES (last whole-state write wins) even though
 * sqlite serialises each commit - so a second opener with a live foreign lease is refused at
 * open (fail-closed, boot stops), a save after losing the lease throws, and close() releases.
 * A crashed owner leaves its lease behind: it goes stale after leaseTtlMs (default 30 min) and
 * may be taken over, or an operator clears it with SqliteStore.breakLease(path) after confirming
 * the process is dead (docs/RECOVERY.md).
 */
export class SqliteStore implements StateStore {
  /** Mark this store corrupt from outside (e.g. an un-migratable legacy file) - fail-closed. */
  markCorrupt(reason: string): void { this.corrupt = true; this.corruptReason = reason; try { this.db?.close(); } catch { /* noop */ } }

  readonly kind = "sqlite";
  readonly owner = randomUUID();
  private db: DatabaseSync = null as unknown as DatabaseSync;
  constructor(private path: string, private leaseTtlMs = DEFAULT_LEASE_TTL_MS) {
    // Concurrent fresh-file creation (two boots inside the same millisecond) can make the setup
    // statements throw SQLITE_BUSY/SQLITE_LOCKED even with busy_timeout: the other process holds
    // the init lock. Busy is TRANSIENT, never corruption (flake named in review round-5:
    // ERR:store-corrupt from the R1 race probe) - retry the open with backoff before failing closed.
    const OPEN_ATTEMPTS = 8;
    for (let attempt = 1; ; attempt++) {
      const busy = this.tryOpen();
      if (!busy) return;
      if (attempt >= OPEN_ATTEMPTS) return; // the last tryOpen left the corrupt marker set
      const waitMs = 150 * attempt;
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* bounded synchronous backoff before re-opening */ }
      this.corrupt = false; this.corruptReason = undefined;
    }
  }

  /** One open+setup attempt. Returns true when the failure was a transient busy/locked error
   *  (worth retrying); false when the store is ready or corrupt for a non-busy reason. */
  private tryOpen(): boolean {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.path);
      // Busy timeout FIRST (round-2 R1): even journal_mode/WAL setup takes the write lock, so a
      // contended opener must wait rather than throw SQLITE_BUSY into the corruption path.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL CHECK (json_valid(v))) WITHOUT ROWID");
      db.exec("CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, heartbeat TEXT NOT NULL)");
      const check = db!.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      if (check.integrity_check !== "ok") { db.close(); throw new Error(`sqlite integrity_check: ${check.integrity_check}`); }
      this.chmodFiles(this.path); // state holds the approver private key; WAL/SHM pages can too (round-2 R4)
      this.acquireLease(db!);
    } catch (e) {
      // A lease refusal is not corruption: it must stop the boot with its own clear error.
      if (e instanceof SqliteLeaseError) { try { db?.close(); } catch { /* noop */ } throw e; }
      const msg = e && typeof e === "object" && "message" in e ? String((e as Error).message) : String(e);
      try { (db! as DatabaseSync | undefined)?.close(); } catch { /* already closed */ }
      if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(msg)) return true; // transient: caller retries
      // An unreadable/corrupt database must fail closed at the console layer, not silently reset.
      this.corrupt = true;
      this.db = null as unknown as DatabaseSync;
      this.corruptReason = msg.slice(0, 200);
      return false;
    }
    this.db = db!;
    this.corrupt = false;
    // Idle-heartbeat (round-2 R4): the lease previously renewed only on save, so an idle live
    // owner went stale and a second opener could break a LIVE lease -> two writers. Renew at
    // 1/3 of the TTL; losing the update means we lost the lease and must refuse saves.
    this.heartbeatTimer = setInterval(() => {
      try {
        const r = this.db.prepare("UPDATE lease SET heartbeat = ? WHERE id = 1 AND owner = ?").run(new Date().toISOString(), this.owner);
        if (r.changes !== 1) this.leaseLost = true;
      } catch { this.leaseLost = true; }
    }, Math.max(1000, Math.floor(this.leaseTtlMs / 3)));
    this.heartbeatTimer.unref();
    return false;
  }
  private leaseLost = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private chmodFiles(base: string): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { if (existsSync(base + suffix)) chmodSync(base + suffix, 0o600); } catch { /* best effort */ }
    }
  }
  private corrupt = false;
  corruptReason?: string; // public for post-mortem logging (review round-5 flake); never proof of the failure class on its own
  private closed = false;

  private acquireLease(db: DatabaseSync): void {
    // BEGIN IMMEDIATE takes the write lock up front (round-2 R1): two racing openers serialise
    // here, so the check-and-insert can never both pass (the old SELECT-then-INSERT raced 2/60).
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT owner, heartbeat FROM lease WHERE id = 1").get() as { owner: string; heartbeat: string } | undefined;
      const fresh = row && Date.now() - new Date(row.heartbeat).getTime() < this.leaseTtlMs;
      if (row && fresh && row.owner !== this.owner) {
        db.exec("ROLLBACK");
        try { db.close(); } catch { /* noop */ }
        throw new SqliteLeaseError(`state file is owned by another live console process (lease heartbeat ${row.heartbeat}) - refusing to run as a second writer; if that process is dead, clear the lease (docs/RECOVERY.md)`);
      }
      db.prepare("INSERT INTO lease (id, owner, heartbeat) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, heartbeat = excluded.heartbeat")
        .run(this.owner, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      if (e instanceof SqliteLeaseError) throw e;
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  }

  /** Operator recovery: clear a dead owner's lease. Confirm the process is REALLY dead first. */
  static breakLease(path: string): void {
    const db = new DatabaseSync(path);
    db.exec("DELETE FROM lease WHERE id = 1");
    db.close();
  }

  load(): LoadResult {
    if (this.corrupt) return "corrupted";
    try {
      const rows = this.db.prepare("SELECT k, v FROM state").all() as { k: string; v: string }[];
      if (!rows.length) return null;
      const map = Object.fromEntries(rows.map((r) => [r.k, JSON.parse(r.v)]));
      if (!("holderId" in map)) map.holderId = null;
      if (!Array.isArray(map.cases)) return "corrupted";
      return {
        cases: map.cases,
        usedNonces: Array.isArray(map.usedNonces) ? map.usedNonces : [],
        notifications: map.notifications ?? [],
        approverKey: map.approverKey ?? { privateKeyPem: "", keyId: "" }
      };
    } catch { return "corrupted"; }
  }

  save(state: PersistedState): void {
    if (this.corrupt) throw new Error(`state store is corrupt (${this.corruptReason ?? "unknown"}); refusing writes`);
    if (this.closed) throw new Error("state store is closed");
    if (this.leaseLost) throw new SqliteLeaseError("write lease lost (idle heartbeat update failed) - another console process owns this state file; refusing to save");
    // One transaction for the whole aggregate: either every entity kind commits or none does.
    // The lease heartbeat renews in the SAME transaction - a 0-row update means we lost the
    // lease (another process took over) and this save must fail, not silently fork state.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lease = this.db.prepare("UPDATE lease SET heartbeat = ? WHERE id = 1 AND owner = ?").run(new Date().toISOString(), this.owner);
      if (lease.changes !== 1) throw new SqliteLeaseError("write lease lost - another console process owns this state file; refusing to save");
      const put = this.db.prepare("INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
      put.run("cases", JSON.stringify(state.cases));
      put.run("usedNonces", JSON.stringify(state.usedNonces));
      put.run("notifications", JSON.stringify(state.notifications));
      put.run("approverKey", JSON.stringify(state.approverKey));
      put.run("holderId", JSON.stringify(state.holderId ?? null));
      this.db.exec("COMMIT");
      this.chmodFiles(this.path);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    if (this.corrupt || this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try { this.db.prepare("DELETE FROM lease WHERE id = 1 AND owner = ?").run(this.owner); } catch { /* best effort */ }
    this.db.close();
  }
}

/**
 * Pick the store for a state path. sqlite when INTENTPAY_STATE_ENGINE=sqlite (production default
 * via server.ts) or the path ends .db/.sqlite; json otherwise. Migrates a legacy JSON file into
 * a fresh sqlite database once (renamed to .migrated-json afterwards, never deleted).
 */
export function openStateStore(path: string, engine?: "json" | "sqlite"): StateStore {
  const useSqlite = engine === "sqlite" || (!engine && /\.(db|sqlite)$/.test(path));
  if (!useSqlite) return new JsonFileStore(path);
  const store = new SqliteStore(path);
  const legacy = path.replace(/\.(db|sqlite)$/, "") + ".json";
  if (existsSync(legacy)) {
    const probe = store.load();
    if (probe === null) {
      const json = new JsonFileStore(legacy).load();
      if (json === "corrupted") {
        // A corrupt legacy file must NEVER become a clean start (review F4): its locks and
        // nonces are unrecoverable by us, so the store reports corruption and the console
        // fails closed until an operator resolves the file.
        store.markCorrupt(`legacy JSON state at ${legacy} is corrupt and cannot be migrated`);
      } else if (json) {
        store.save(json);
        renameSync(legacy, legacy + ".migrated");
      }
    }
  }
  return store;
}
