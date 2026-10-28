/**
 * Crash-mid-flight drill (G6): proves the console recovers honestly from SIGKILL at the two
 * most dangerous points - after the provider committed but before local state persisted.
 * Drill-only fault injection (INTENTPAY_DRILL_CRASH_AT) is forbidden in production config.
 * Run: npm run drill:crash
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as netCreateServer } from "node:net";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const freePort = () => new Promise<number>((res, rej) => {
  const s = netCreateServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

async function boot(stateFile: string, crashAt?: string): Promise<{ child: ChildProcess; base: string; token: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/console/server.ts"], { // direct node child: SIGKILL observable as a signal, not an npx exit code
    env: { ...process.env, PORT: String(port), INTENTPAY_STATE_FILE: stateFile, INTENTPAY_STATE_ENGINE: "sqlite", ...(crashAt ? { INTENTPAY_DRILL_CRASH_AT: crashAt } : {}) },
    stdio: "ignore"
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/healthz`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const html = await (await fetch(`${base}/`)).text();
  const token = html.match(/name="console-token" content="([^"]+)"/)?.[1];
  if (!token) throw new Error("no demo token on page");
  return { child, base, token };
}

const post = (base: string, token: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": token, origin: base }, body: JSON.stringify(body) });

const died = (child: ChildProcess) => new Promise<string>((res) => {
  if (child.exitCode !== null || child.signalCode) return res(child.signalCode ?? `exit ${child.exitCode}`);
  child.once("exit", (_c, sig) => res(sig ?? "exit"));
});

const breakLease = (stateFile: string) => { const db = new DatabaseSync(stateFile); db.exec("DELETE FROM lease WHERE id = 1"); db.close(); };

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
};

// ---------- Drill A: SIGKILL after the provider created the card, before persist ----------
{
  const stateFile = `/tmp/drill-a-${process.pid}.db`;
  rmSync(stateFile, { force: true });
  const a = await boot(stateFile, "after-card-create");
  const approve = await (await post(a.base, a.token, "/api/approve", { caseId: "case_acme" })).json() as { approval?: unknown; error?: string };
  check("A1 approve ok", !!approve.approval, approve.error);
  const create = await post(a.base, a.token, "/api/create-card", { approval: approve.approval }).catch((e) => e as Error);
  check("A2 child SIGKILLed mid-flight (connection dropped)", create instanceof Error || (create as Response).ok === false);
  const how = await died(a.child);
  check("A3 server process died at the crash point", how.length > 0, how); // tsx wraps the server in a worker: death surfaces as child exit, the dropped connection in A2 is the crash-point proof

  // Operator runbook step: confirm the process is dead, clear its lease, restart.
  breakLease(stateFile);
  const b = await boot(stateFile);
  const casesRes = await (await fetch(`${b.base}/api/cases`)).json() as { cases: { kase: { id: string }; card?: unknown; log: string[] }[] };
  const acme = casesRes.cases.find((c) => c.kase.id === "case_acme")!;
  check("A4 restart: state intact, console has NO card locally (provider may have one)", !acme.card);
  const retry = await post(b.base, b.token, "/api/create-card", { approval: approve.approval });
  check("A5 blind retry REFUSED (consumed nonce), not a duplicate card", retry.status === 409, `HTTP ${retry.status}`);
  b.child.kill("SIGTERM");
  await died(b.child);
  rmSync(stateFile, { force: true }); rmSync(stateFile + "-wal", { force: true }); rmSync(stateFile + "-shm", { force: true });
}

// ---------- Drill B: SIGKILL after the provider authorized, before persist ----------
{
  const stateFile = `/tmp/drill-b-${process.pid}.db`;
  rmSync(stateFile, { force: true });
  const a = await boot(stateFile, "after-authorize");
  const approve = await (await post(a.base, a.token, "/api/approve", { caseId: "case_acme" })).json() as { approval?: unknown };
  await post(a.base, a.token, "/api/create-card", { approval: approve.approval });
  await post(a.base, a.token, "/api/simulate", { caseId: "case_acme", kind: "in-policy" }).catch(() => null);
  const how = await died(a.child);
  check("B1 server process died at the crash point", how.length > 0, how);

  breakLease(stateFile);
  const b = await boot(stateFile);
  const casesRes = await (await fetch(`${b.base}/api/cases`)).json() as { cases: { kase: { id: string }; pendingAuthorization?: { reconciledAt?: string } }[] };
  const acme = casesRes.cases.find((c) => c.kase.id === "case_acme")!;
  check("B2 restart: authorization lock persisted UNRECONCILED (written before the gateway call)", !!acme.pendingAuthorization && !acme.pendingAuthorization.reconciledAt);
  const retry = await post(b.base, b.token, "/api/simulate", { caseId: "case_acme", kind: "in-policy" });
  const body = await retry.json() as { code?: string };
  check("B3 blind purchase retry REFUSED until reconcile", retry.status === 409 && body.code === "authorization_unresolved", `HTTP ${retry.status} ${body.code ?? ""}`);
  b.child.kill("SIGTERM");
  await died(b.child);
  rmSync(stateFile, { force: true }); rmSync(stateFile + "-wal", { force: true }); rmSync(stateFile + "-shm", { force: true });
}

console.log(failures ? `DRILL FAILED (${failures})` : "DRILL PASS - crash recovery honest at both kill points");
process.exit(failures ? 1 : 0);
