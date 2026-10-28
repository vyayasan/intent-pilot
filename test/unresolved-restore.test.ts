import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConsoleApi, demoCases, type CaseState } from "../src/console/api.js";
import { openStateStore, resolveStateTarget, SqliteStore } from "../src/console/state.js";
import { AuditLog } from "../src/audit/audit.js";

const NOW = new Date("2026-10-06T09:00:00Z");
const mk = (opts: Record<string, unknown>, seedCases?: CaseState[]) => {
  const audit = new AuditLog(undefined, () => NOW);
  const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases, ...opts } as never);
  const post = (path: string, body: unknown) =>
    api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
  return { api, audit, post };
};
const PA = { requestId: "case_acme:in-policy:0", kind: "in-policy", cardId: "card_123", amount: 984, currency: "USD", merchant: "Acme Analytics", startedAt: "2026-10-28T09:34:17Z" };

describe("unresolved-authorization restore at boot", () => {
  it("restores the lock into a surviving case and refuses purchases until reconcile - never auto-reconciles", async () => {
    const dir = mkdtempSync("/tmp/intentpay-restore-");
    const f = `${dir}/restore.json`;
    writeFileSync(f, JSON.stringify({ unresolved: [{ caseId: "case_acme", pendingAuthorization: PA }] }));
    // Give the case an approval, card and intent through the normal flow, then "crash".
    const seed = demoCases();
    const first = mk({}, seed);
    const ap = await (await first.post("/api/approve", { caseId: "case_acme" })).json();
    const cc = await first.post("/api/create-card", { approval: ap.approval });
    expect(cc.status).toBe(200);
    // Boot a fresh process over the surviving case with the preserved unresolved export.
    const { api, audit, post } = mk({ unresolvedRestoreFile: f }, seed);
    const list = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    const acme = list.cases.find((x: { kase: { id: string } }) => x.kase.id === "case_acme");
    expect(acme.pendingAuthorization.requestId).toBe("case_acme:in-policy:0");
    expect(acme.pendingAuthorization.reconciledAt).toBeUndefined(); // restore never reconciles
    const r = await post("/api/simulate", { caseId: "case_acme", kind: "in-policy" });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("authorization_unresolved");
    expect(audit.list().some((e) => e.kind === "unresolved_authorization_restored" && e.detail.requestId === PA.requestId)).toBe(true);
  });

  it("keeps a loud tombstone when the case did not survive, surfaced in /api/cases", async () => {
    const dir = mkdtempSync("/tmp/intentpay-restore-");
    const f = `${dir}/restore.json`;
    writeFileSync(f, JSON.stringify({ unresolved: [{ caseId: "case_gone", pendingAuthorization: { ...PA, requestId: "case_gone:in-policy:0" } }] }));
    const { api, audit } = mk({ unresolvedRestoreFile: f });
    const list = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    expect(list.restoredUnresolved).toEqual([{ caseId: "case_gone", requestId: "case_gone:in-policy:0", cardId: "card_123", kind: "orphan" }]);
    expect(audit.list().some((e) => e.kind === "unresolved_authorization_tombstone")).toBe(true);
  });

  it("an unreadable restore file fails CLOSED like corrupt state", async () => {
    const dir = mkdtempSync("/tmp/intentpay-restore-");
    const f = `${dir}/restore.json`;
    writeFileSync(f, "{ not json");
    const { api, post } = mk({ unresolvedRestoreFile: f });
    const list = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    expect(list.stateCorrupted).toBe(true);
    const r = await post("/api/approve", { caseId: "case_acme" });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("state_corrupted");
  });

  it("a reconciled export entry restores nothing", async () => {
    const dir = mkdtempSync("/tmp/intentpay-restore-");
    const f = `${dir}/restore.json`;
    writeFileSync(f, JSON.stringify({ unresolved: [{ caseId: "case_acme", pendingAuthorization: { ...PA, reconciledAt: "2026-10-28T10:00:00Z" } }] }));
    const { api } = mk({ unresolvedRestoreFile: f });
    const list = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    const acme = list.cases.find((x: { kase: { id: string } }) => x.kase.id === "case_acme");
    expect(acme.pendingAuthorization).toBeUndefined();
  });

  it("export-unresolved preserves the full lock payload, nonces, holder, outbox and audit - atomic, manifest-verified, key-free", async () => {
    const dir = mkdtempSync("/tmp/intentpay-export-");
    const stateFile = `${dir}/state.json`;
    const auditFile = `${dir}/audit.jsonl`;
    // Build a state file that holds one unresolved attempt, via the normal locked flow.
    const audit1 = new AuditLog(auditFile, () => NOW);
    const api1 = createConsoleApi({ gateway: undefined, key: "k", approver: "sandi", now: () => NOW, audit: audit1, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], stateFile, stateEngine: "json" } as never);
    audit1.append("marker_for_export", { n: 1 });
    const post1 = (path: string, body: unknown) =>
      api1(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
    const approved = await (await post1("/api/approve", { caseId: "case_acme" })).json();
    await post1("/api/create-card", { approval: approved.approval });
    // The sim gateway cannot fail on demand; inject the unresolved record through the state file instead.
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.cases[0].pendingAuthorization = PA;
    writeFileSync(stateFile, JSON.stringify(state));
    const out = `${dir}/export.json`;
    const stdout = execFileSync("npx", ["tsx", "scripts/export-unresolved.ts", out], { env: { ...process.env, INTENTPAY_STATE_FILE: stateFile, INTENTPAY_STATE_ENGINE: "json", INTENTPAY_AUDIT_FILE: auditFile, INTENTPAY_ENV: "test" } }).toString();
    const body = readFileSync(out, "utf8");
    const sha = createHash("sha256").update(body).digest("hex");
    expect(stdout).toContain(`sha256 ${sha}`); // printed hash matches the actual bytes
    const manifest = readFileSync(`${out}.sha256`, "utf8"); // persisted manifest (round-8 D)
    expect(manifest).toContain(sha);
    expect(manifest).toContain("export.json");
    const parsed = JSON.parse(body);
    expect(parsed.unresolved).toHaveLength(1);
    expect(parsed.unresolved[0].pendingAuthorization).toEqual(PA); // full payload, not a projection
    expect(parsed.unresolved[0].cardId).toBeDefined();
    expect(parsed.unresolved[0].caseId).toBe("case_acme");
    expect(parsed.usedNonces.length).toBeGreaterThan(0); // consumed approval nonces preserved
    expect(parsed.auditJsonl).toContain("marker_for_export"); // audit bytes included coherently
    expect(parsed.exclusions.join(" ")).toMatch(/privateKeyPem/); // exclusions documented
    expect(body).not.toMatch(/PRIVATE KEY/); // signing material NEVER exported
    expect(body).not.toContain(state.approverKey.privateKeyPem.slice(0, 40));
  });

  it("export refuses a corrupted store atomically: no output, no manifest, non-zero exit", () => {
    const dir = mkdtempSync("/tmp/intentpay-export-");
    const stateFile = `${dir}/state.json`;
    writeFileSync(stateFile, "{ not json");
    const out = `${dir}/export.json`;
    let code = 0;
    try { execFileSync("npx", ["tsx", "scripts/export-unresolved.ts", out], { env: { ...process.env, INTENTPAY_STATE_FILE: stateFile, INTENTPAY_STATE_ENGINE: "json", INTENTPAY_ENV: "test" }, stdio: "pipe" }); } catch (e) { code = (e as { status: number }).status; }
    expect(code).not.toBe(0);
    expect(existsSync(out)).toBe(false); // no partial artifact: nothing a teardown could trust
    expect(existsSync(`${out}.sha256`)).toBe(false);
    expect(existsSync(`${out}.tmp`)).toBe(false);
  });

  it("sqlite export is read-only: never takes, breaks or leaks the live writer lease", () => {
    const dir = mkdtempSync("/tmp/intentpay-export-");
    const dbPath = `${dir}/console-state.db`;
    const writer = openStateStore(dbPath, "sqlite") as SqliteStore;
    writer.save({ cases: [{ kase: { id: "case_acme", vendor: "Acme" }, card: { id: "card_123", status: "FROZEN" }, pendingAuthorization: PA, log: [] }], usedNonces: [["n1", 1]], notifications: [], approverKey: { privateKeyPem: "k", keyId: "f" }, holderId: "h_1" });
    const out1 = `${dir}/e1.json`;
    const out2 = `${dir}/e2.json`;
    const env = { ...process.env, INTENTPAY_STATE_FILE: dbPath, INTENTPAY_ENV: "test" }; // no engine: .db autodetects
    // Export WHILE the writer holds its live lease - twice, back to back.
    execFileSync("npx", ["tsx", "scripts/export-unresolved.ts", out1], { env });
    execFileSync("npx", ["tsx", "scripts/export-unresolved.ts", out2], { env });
    const p1 = JSON.parse(readFileSync(out1, "utf8"));
    expect(p1.unresolved[0].pendingAuthorization.requestId).toBe(PA.requestId);
    expect(p1.holderId).toBe("h_1");
    // The writer lease is untouched: the console keeps saving without any recovery step.
    writer.save({ cases: [], usedNonces: [], notifications: [], approverKey: { privateKeyPem: "k", keyId: "f" }, holderId: "h_1" });
    writer.close();
    // And no lease leaked: a fresh writer boots immediately, no 30-minute TTL wait.
    const next = openStateStore(dbPath, "sqlite");
    (next as SqliteStore).close();
  });

  it("resolveStateTarget: one shared resolution for server and export, extension autodetect", () => {
    expect(resolveStateTarget({ INTENTPAY_STATE_FILE: "x.db" } as never)).toEqual({ stateFile: "x.db", stateEngine: "sqlite", auditFile: "audit.jsonl" });
    expect(resolveStateTarget({ INTENTPAY_STATE_FILE: "x.json" } as never)).toEqual({ stateFile: "x.json", stateEngine: "json", auditFile: "audit.jsonl" });
    expect(resolveStateTarget({ INTENTPAY_STATE_FILE: "x.db", INTENTPAY_STATE_ENGINE: "json" } as never).stateEngine).toBe("json"); // explicit wins
    expect(resolveStateTarget({ INTENTPAY_ENV: "production" } as never)).toEqual({ stateFile: "console-state.db", stateEngine: "sqlite", auditFile: "audit.jsonl" });
    expect(resolveStateTarget({} as never)).toEqual({ stateFile: "console-state.json", stateEngine: "json", auditFile: "audit.jsonl" });
    expect(resolveStateTarget({ INTENTPAY_AUDIT_FILE: "custom.log" } as never).auditFile).toBe("custom.log");
  });
});
