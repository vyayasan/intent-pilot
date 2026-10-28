// Round-2 independent-review regressions: R1 atomic lease acquire, R3 NAT64/6to4 embedded
// IPv4 in the SSRF guard, R4 WAL/SHM 0600 + idle lease heartbeat, R2 positive-acceptance
// receipt schema. The R1 probe races the REAL SqliteStore from two child processes (the
// reviewer's probe raced a verbatim copy of the old code - that confirmed the bug, this
// proves the fix in the actual class).
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isPrivateIp } from "../src/net/ssrf.js";
import { SqliteStore, SqliteLeaseError } from "../src/console/state.js";
import { HttpMailTransport, AmbiguousMailFailure } from "../src/notify/transport.js";
import { Outbox } from "../src/notify/outbox.js";

describe("R1: concurrent lease acquire is atomic (real SqliteStore, two processes)", () => {
  const CHILD = `import { SqliteStore } from "./src/console/state.ts";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// tsx --eval: argv = [node, path, startAt, dir, index]
const [path, startAt, dir, index] = [process.argv[1], Number(process.argv[2]), process.argv[3], Number(process.argv[4])];
const done = () => { try { writeFileSync(join(dir, "attempted-" + index), "1"); } catch {} };
setTimeout(async () => {
  try { const s = new SqliteStore(path);
    if (s.load() === "corrupted") { done(); console.log("ERR:store-corrupt:" + String(s.corruptReason ?? "no-reason").slice(0, 120)); process.exit(0); } // a store that failed to open must never count as holding the lease
    done();
    // Hold until the sibling has ATTEMPTED (bounded): overlap is guaranteed by construction, so a
    // delayed sibling spawn can never acquire after we close and fake a race failure.
    const deadline = Date.now() + 8000;
    while (!existsSync(join(dir, "attempted-" + (1 - index))) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    s.close(); console.log("ACQUIRED"); process.exit(0); }
  catch (e) { done(); console.log(e && e.constructor && e.constructor.name === "SqliteLeaseError" ? "REFUSED" : "ERR:" + String(e).slice(0, 80)); process.exit(0); }
}, Math.max(0, startAt - Date.now()));`;
  const run = (path: string, startAt: number, dir: string, index: number) => new Promise<string>((res) => {
    // 25s kill backstop: the child self-releases after 8s, so this only fires on a hung spawn.
    execFile("npx", ["tsx", "--eval", CHILD, path, String(startAt), dir, String(index)], { encoding: "utf8", cwd: process.cwd(), timeout: 25000, killSignal: "SIGKILL" }, (e, so) => res((so ?? "").trim() || "ERR:no-output"));
  });

  it("two synced openers never both acquire", async () => {
    let both = 0, refusedPairs = 0, errs: string[] = [];
    for (let round = 0; round < 8; round++) {
      const dir = mkdtempSync(join(tmpdir(), "lease-race-")); // per-round: fresh db + attempt markers
      const p = join(dir, "state.db");
      const startAt = Date.now() + 1500; // best-effort sync; overlap is guaranteed by the hold, not the barrier
      const [a, b] = await Promise.all([run(p, startAt, dir, 0), run(p, startAt, dir, 1)]);
      for (const r of [a, b]) if (r.startsWith("ERR")) errs.push(r);
      if (a === "ACQUIRED" && b === "ACQUIRED") both++;
      if ((a === "REFUSED") !== (b === "REFUSED") || (a === "REFUSED" && b === "REFUSED")) refusedPairs++;
    }
    expect(errs).toEqual([]);
    expect(both, "RACE: two live processes both hold the lease").toBe(0);
    expect(refusedPairs).toBe(8);
  }, 120_000);
});

describe("R3: NAT64 / 6to4 translation prefixes cannot smuggle private IPv4", () => {
  it("embedded private v4 is private; embedded public v4 is public", () => {
    // NAT64 well-known prefix 64:ff9b::/96
    expect(isPrivateIp("64:ff9b::a01:101")).toBe(true);        // 10.1.1.1
    expect(isPrivateIp("64:ff9b::10.1.1.1")).toBe(true);
    expect(isPrivateIp("64:ff9b::7f00:1")).toBe(true);         // 127.0.0.1
    expect(isPrivateIp("64:ff9b::808:808")).toBe(false);       // 8.8.8.8
    // 6to4 2002::/16 embeds the v4 in bits 16..48
    expect(isPrivateIp("2002:a01:101::1")).toBe(true);         // 10.1.1.1
    expect(isPrivateIp("2002:7f00:1::1")).toBe(true);          // 127.0.0.1
    expect(isPrivateIp("2002:c0a8:101::1")).toBe(true);        // 192.168.1.1
    expect(isPrivateIp("2002:808:808::1")).toBe(false);        // 8.8.8.8
  });
});

describe("R4: sqlite file hygiene + idle lease heartbeat", () => {
  it("WAL and SHM files are 0600 after writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lease-perms-"));
    const p = join(dir, "state.db");
    const s = new SqliteStore(p);
    s.save({ cases: [], usedNonces: [], notifications: [], approverKey: null } as never);
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(statSync(p + suffix).mode & 0o777, `mode of ${suffix || "db"}`).toBe(0o600);
    }
    s.close();
  });

  it("an idle but LIVE owner keeps its lease (heartbeat), a second opener is still refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lease-idle-"));
    const p = join(dir, "state.db");
    const a = new SqliteStore(p, 1500); // TTL 1.5s, heartbeat every 500ms
    await new Promise((r) => setTimeout(r, 2200)); // idle beyond the old staleness window
    expect(() => new SqliteStore(p, 1500)).toThrow(SqliteLeaseError); // live owner must NOT be broken
    // and the owner can still save
    a.save({ cases: [], usedNonces: [], notifications: [], approverKey: null } as never);
    a.close();
    const b = new SqliteStore(p, 1500); // after a clean close the lease is free
    b.close();
  }, 20_000);
});

describe("R2: only a strict positive-acceptance receipt proves mail delivery", () => {
  const serve = async (body: string): Promise<{ url: string; close: () => void }> => {
    const srv: Server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(body));
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}/send`, close: () => srv.close() };
  };

  it("2xx with readable-but-arbitrary JSON is AMBIGUOUS, not sent", async () => {
    const { url, close } = await serve(JSON.stringify({ ok: true, id: "m1" }));
    try {
      const rec = new Outbox().emit("purchase_cleared", { caseId: "case_acme", vendor: "Acme Analytics", recipient: "sandi@vyayasan.com", detail: { amount: 100, currency: "USD", cap: 100 } });
      await expect(new HttpMailTransport(url).send(rec)).rejects.toThrow(AmbiguousMailFailure);
    } finally { close(); }
  });

  it("2xx with {\"accepted\": true, \"id\"} proves delivery", async () => {
    const { url, close } = await serve(JSON.stringify({ accepted: true, id: "m2" }));
    try {
      const rec = new Outbox().emit("purchase_cleared", { caseId: "case_acme", vendor: "Acme Analytics", recipient: "sandi@vyayasan.com", detail: { amount: 100, currency: "USD", cap: 100 } });
      const r = await new HttpMailTransport(url).send(rec);
      expect(r.providerId).toBe("m2");
    } finally { close(); }
  });
});
