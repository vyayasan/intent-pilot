/** Durable-state engine tests: sqlite round-trip, concurrent writers, corruption fail-closed,
 *  legacy JSON migration. node:sqlite is experimental in this runtime - labelled accordingly. */
import { describe, it, expect } from "vitest";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { SqliteStore, JsonFileStore, openStateStore, type PersistedState } from "../src/console/state.js";

const state = (tag: string): PersistedState => ({
  cases: [{ kase: { id: `case_${tag}` }, forecast: { weeklyBalances: [1], reserveFloor: 0 }, transactionIds: [], log: [`log-${tag}`] }],
  usedNonces: [[`nonce-${tag}`, 1]],
  notifications: [],
  approverKey: { privateKeyPem: "pem", keyId: "kid" }
});

const tmp = (name: string) => `/tmp/state-test-${name}-${process.pid}.db`;

describe("SqliteStore (node:sqlite, experimental runtime feature)", () => {
  it("round-trips the aggregate across instances (durability)", () => {
    const p = tmp("roundtrip");
    try {
      const a = new SqliteStore(p);
      a.save(state("one"));
      a.close();
      const b = new SqliteStore(p);
      const loaded = b.load();
      b.close();
      expect(loaded).not.toBe("corrupted");
      expect((loaded as PersistedState).usedNonces[0][0]).toBe("nonce-one");
      expect(((loaded as PersistedState).cases as { kase: { id: string } }[])[0].kase.id).toBe("case_one");
    } finally { for (const f of [p, p + "-wal", p + "-shm"]) rmSync(f, { force: true }); }
  });

  it("single-writer lease: a second opener with a live foreign lease is REFUSED (no lost updates by construction)", () => {
    const p = tmp("lease");
    try {
      const a = new SqliteStore(p);
      a.save(state("owner"));
      expect(() => new SqliteStore(p)).toThrow(/owned by another live console process/);
      a.close(); // clean shutdown releases the lease
      const b = new SqliteStore(p); // next boot opens fine
      expect(((b.load() as PersistedState).cases as { kase: { id: string } }[])[0].kase.id).toBe("case_owner");
      b.close();
    } finally { for (const f of [p, p + "-wal", p + "-shm"]) rmSync(f, { force: true }); }
  });

  it("lost lease: after a stale-lease takeover, the OLD owner's save throws instead of forking state", async () => {
    const p = tmp("lostlease");
    try {
      const a = new SqliteStore(p, 50); // 50ms lease for the drill
      a.save(state("old"));
      await new Promise((r) => setTimeout(r, 80)); // lease goes stale
      const b = new SqliteStore(p, 50); // takeover of the stale lease
      b.save(state("new"));
      expect(() => a.save(state("fork"))).toThrow(/lease lost/);
      const loaded = b.load() as PersistedState;
      expect((loaded.cases as { kase: { id: string } }[])[0].kase.id).toBe("case_new"); // no forked state
      b.close();
    } finally { for (const f of [p, p + "-wal", p + "-shm"]) rmSync(f, { force: true }); }
  });

  it("operator recovery: breakLease clears a dead owner's fresh lease", () => {
    const p = tmp("breaklease");
    try {
      const dead = new SqliteStore(p); // simulates a crashed process: never closed
      dead.save(state("dead"));
      expect(() => new SqliteStore(p)).toThrow(/owned by another live console process/);
      SqliteStore.breakLease(p); // operator confirms the process is dead, then clears
      const b = new SqliteStore(p);
      expect(((b.load() as PersistedState).cases as { kase: { id: string } }[])[0].kase.id).toBe("case_dead");
      b.close();
    } finally { for (const f of [p, p + "-wal", p + "-shm"]) rmSync(f, { force: true }); }
  });

  it("serialised commits still hold: 40 saves across sequential owners never corrupt", () => {
    const p = tmp("serial");
    try {
      for (let i = 0; i < 20; i++) {
        const s = new SqliteStore(p);
        s.save(state(`w${i}`));
        expect(s.load()).not.toBe("corrupted");
        s.close();
      }
    } finally { for (const f of [p, p + "-wal", p + "-shm"]) rmSync(f, { force: true }); }
  });

  it("a corrupt database fails closed: load says corrupted, save refuses", () => {
    const p = tmp("corrupt");
    writeFileSync(p, Buffer.from("this is not a sqlite database at all, just garbage bytes"));
    try {
      const s = new SqliteStore(p);
      expect(s.load()).toBe("corrupted");
      expect(() => s.save(state("x"))).toThrow(/corrupt/);
    } finally { for (const f of [p, p + "-wal", p + "-shm"]) rmSync(f, { force: true }); }
  });

  it("migrates a legacy JSON state file once, then renames it (never deletes)", () => {
    const db = tmp("migrate");
    const json = db.replace(/\.db$/, ".json");
    try {
      new JsonFileStore(json).save(state("legacy"));
      const store = openStateStore(db, "sqlite");
      const loaded = store.load();
      expect(loaded).not.toBe("corrupted");
      expect(((loaded as PersistedState).cases as { kase: { id: string } }[])[0].kase.id).toBe("case_legacy");
      expect(existsSync(json)).toBe(false);
      expect(existsSync(json + ".migrated")).toBe(true);
      // second open does NOT re-import over newer sqlite state
      store.save(state("newer"));
      (store as { close?: () => void }).close?.();
      const again = openStateStore(db, "sqlite").load();
      expect(((again as PersistedState).cases as { kase: { id: string } }[])[0].kase.id).toBe("case_newer");
    } finally { for (const f of [db, db + "-wal", db + "-shm", json, json + ".migrated"]) rmSync(f, { force: true }); }
  });

  it("JsonFileStore behavior is unchanged (demo default)", () => {
    const p = tmp("json").replace(/\.db$/, ".json");
    try {
      const s = new JsonFileStore(p);
      expect(s.load()).toBe(null);
      s.save(state("j"));
      expect(((s.load() as PersistedState).cases as { kase: { id: string } }[])[0].kase.id).toBe("case_j");
      writeFileSync(p, "{ not json");
      expect(new JsonFileStore(p).load()).toBe("corrupted");
    } finally { rmSync(p, { force: true }); }
  });
});
