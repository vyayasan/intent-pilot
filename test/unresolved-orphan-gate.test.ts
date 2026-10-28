import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createConsoleApi, demoCases, type CaseState } from "../src/console/api.js";
import { AuditLog } from "../src/audit/audit.js";

const NOW = new Date("2026-10-06T09:00:00Z");
const PA = { requestId: "case_gone:in-policy:0", kind: "in-policy", cardId: "card_orphan", amount: 984, currency: "USD", merchant: "Acme Analytics", startedAt: "2026-10-28T09:34:17Z" };
const mk = (restoreEntries: unknown[], seedCases?: CaseState[]) => {
  const dir = mkdtempSync("/tmp/intentpay-orphan-");
  const f = `${dir}/restore.json`;
  writeFileSync(f, JSON.stringify({ unresolved: restoreEntries }));
  const audit = new AuditLog(undefined, () => NOW);
  const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases, unresolvedRestoreFile: f, operatorToken: "op" } as never);
  const post = (path: string, body: unknown) =>
    api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
  const cases = async () => (await (await api(new Request("http://localhost:3000/api/cases"))).json());
  return { api, audit, post, cases };
};
const ORPHAN = { caseId: "case_gone", pendingAuthorization: PA };

describe("orphan unresolved gate (round-8 A)", () => {
  it("an orphan blocks every new-purchase path until resolved - reads stay open", async () => {
    const { post, cases } = mk([ORPHAN]);
    for (const [path, body] of [
      ["/api/approve", { caseId: "case_acme" }],
      ["/api/simulate", { caseId: "case_acme", kind: "in-policy" }],
      ["/api/change-terms", { caseId: "case_acme", rawTerms: "new terms $5/mo" }],
    ] as const) {
      const r = await post(path, body);
      expect(r.status).toBe(409);
      const d = await r.json();
      expect(d.code).toBe("orphan_authorization_unresolved");
      expect(d.orphans[0].requestId).toBe(PA.requestId);
    }
    // create-card is gated too: approve a forged path is impossible, so check the gate fires first.
    const cc = await post("/api/create-card", { approval: { caseId: "case_acme", nonce: "x", sig: "y" } });
    expect(cc.status).toBe(409);
    expect((await cc.json()).code).toBe("orphan_authorization_unresolved");
    // Reads are unaffected.
    const list = await cases();
    expect(list.restoredUnresolved).toHaveLength(1);
  });

  it("never auto-attaches to a same-vendor case: vendor is not identity", async () => {
    // Seed a DIFFERENT live case from the same vendor as the orphaned attempt.
    const seed = demoCases();
    seed[0].kase = { ...seed[0].kase, id: "case_acme", vendor: PA.merchant };
    const { post, cases } = mk([ORPHAN], seed);
    const list = await cases();
    const acme = list.cases.find((x: { kase: { id: string } }) => x.kase.id === "case_acme");
    expect(acme.pendingAuthorization).toBeUndefined(); // no silent adoption onto the same-vendor case
    expect(list.restoredUnresolved[0].kind).toBe("orphan");
    const r = await post("/api/approve", { caseId: "case_acme" });
    expect(r.status).toBe(409); // still gated globally
    expect((await r.json()).code).toBe("orphan_authorization_unresolved");
  });

  it("resolution requires the operator token and evidence; resolving lifts the gate", async () => {
    const { post, audit } = mk([ORPHAN]);
    const noToken = await post("/api/resolve-restored", { caseId: "case_gone", requestId: PA.requestId, resolution: "no_matching_transaction", evidence: "provider dashboard search 2026-10-28" });
    expect(noToken.status).toBe(400); // missing operatorToken field
    const wrong = await post("/api/resolve-restored", { caseId: "case_gone", requestId: PA.requestId, resolution: "no_matching_transaction", evidence: "provider dashboard search 2026-10-28", operatorToken: "nope" });
    expect(wrong.status).toBe(403);
    const thin = await post("/api/resolve-restored", { caseId: "case_gone", requestId: PA.requestId, resolution: "no_matching_transaction", evidence: "ok", operatorToken: "op" });
    expect(thin.status).toBe(400); // evidence must say something real
    const unknown = await post("/api/resolve-restored", { caseId: "case_gone", requestId: "nope:0", resolution: "no_matching_transaction", evidence: "provider dashboard search 2026-10-28", operatorToken: "op" });
    expect(unknown.status).toBe(404);
    const ok = await post("/api/resolve-restored", { caseId: "case_gone", requestId: PA.requestId, resolution: "no_matching_transaction", evidence: "Airwallex dashboard issuing-transaction list for card_orphan, 2026-10-28: zero rows", operatorToken: "op" });
    expect(ok.status).toBe(200);
    const d = await ok.json();
    expect(d.remainingOrphans).toHaveLength(0);
    const entry = audit.list().find((e) => e.kind === "restored_orphan_resolved");
    expect(entry?.detail.evidence).toMatch(/dashboard/);
    expect(entry?.detail.resolution).toBe("no_matching_transaction");
    // Gate lifted: the normal purchase flow works again.
    const ap = await post("/api/approve", { caseId: "case_acme" });
    expect(ap.status).toBe(200);
  });

  it("resolution without a configured operator token is unavailable, never open", async () => {
    const dir = mkdtempSync("/tmp/intentpay-orphan-");
    const f = `${dir}/restore.json`;
    writeFileSync(f, JSON.stringify({ unresolved: [ORPHAN] }));
    const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit: new AuditLog(undefined, () => NOW), sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], unresolvedRestoreFile: f } as never);
    const r = await api(new Request("http://localhost:3000/api/resolve-restored", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_gone", requestId: PA.requestId, resolution: "no_matching_transaction", evidence: "provider dashboard search", operatorToken: "anything" }) }));
    expect(r.status).toBe(403);
  });

  it("a live-backed console still refuses demo reset even with orphans present", async () => {
    const dir = mkdtempSync("/tmp/intentpay-orphan-");
    const f = `${dir}/restore.json`;
    writeFileSync(f, JSON.stringify({ unresolved: [ORPHAN] }));
    const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit: new AuditLog(undefined, () => NOW), sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], unresolvedRestoreFile: f, live: true } as never);
    const r = await api(new Request("http://localhost:3000/api/reset-demo", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: "{}" }));
    expect(r.status).toBe(409);
    const list = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    expect(list.restoredUnresolved).toHaveLength(1); // orphans survive the refused reset
  });

  it("a simulator reset clears orphans as the sanctioned clean start", async () => {
    const { post, cases } = mk([ORPHAN]);
    const r = await post("/api/reset-demo", {});
    expect(r.status).toBe(200);
    expect((await cases()).restoredUnresolved).toBeUndefined();
    const ap = await post("/api/approve", { caseId: "case_acme" });
    expect(ap.status).toBe(200); // gate gone with the demo state
  });
});

describe("restore conflicts (round-8 E)", () => {
  const LIVE = { requestId: "case_acme:in-policy:0", kind: "in-policy", cardId: "card_live", amount: 984, currency: "USD", merchant: "Acme Analytics", startedAt: "2026-10-28T09:30:00Z" };
  const PRESERVED = { ...LIVE, requestId: "case_acme:in-policy:1", cardId: "card_other", startedAt: "2026-10-28T09:35:00Z" };
  const seedWithLiveLock = () => {
    const seed = demoCases();
    seed[0].pendingAuthorization = { ...LIVE } as never;
    return seed;
  };

  it("a conflicting preserved lock never overwrites the live one - both survive, gated and audited", async () => {
    const { post, audit, cases } = mk([{ caseId: "case_acme", pendingAuthorization: PRESERVED }], seedWithLiveLock());
    const list = await cases();
    const acme = list.cases.find((x: { kase: { id: string } }) => x.kase.id === "case_acme");
    expect(acme.pendingAuthorization.requestId).toBe(LIVE.requestId); // live lock untouched
    expect(acme.pendingAuthorization.cardId).toBe("card_live");
    expect(list.restoredUnresolved).toEqual([{ caseId: "case_acme", requestId: PRESERVED.requestId, cardId: "card_other", kind: "conflict", keptRequestId: LIVE.requestId }]);
    const conflict = audit.list().find((e) => e.kind === "unresolved_authorization_restore_conflict");
    expect(conflict?.detail.keptRequestId).toBe(LIVE.requestId);
    expect(conflict?.detail.conflictingRequestId).toBe(PRESERVED.requestId);
    // The conflict is gated like an orphan: purchases on OTHER cases are refused too.
    const r = await post("/api/approve", { caseId: "case_northwind" });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("orphan_authorization_unresolved");
    // Resolution by requestId works for the conflict entry.
    const ok = await post("/api/resolve-restored", { caseId: "case_acme", requestId: PRESERVED.requestId, resolution: "duplicate_confirmed_frozen", evidence: "provider shows card_other; frozen at dashboard 2026-10-28", operatorToken: "op" });
    expect(ok.status).toBe(200);
    const after = await cases();
    expect(after.restoredUnresolved).toBeUndefined();
    expect(after.cases.find((x: { kase: { id: string } }) => x.kase.id === "case_acme").pendingAuthorization.requestId).toBe(LIVE.requestId); // live lock still enforced
  });

  it("re-restoring the SAME request id is idempotent - no conflict, no change", async () => {
    const { audit, cases } = mk([{ caseId: "case_acme", pendingAuthorization: LIVE }], seedWithLiveLock());
    const list = await cases();
    expect(list.restoredUnresolved).toBeUndefined();
    expect(list.cases.find((x: { kase: { id: string } }) => x.kase.id === "case_acme").pendingAuthorization.requestId).toBe(LIVE.requestId);
    expect(audit.list().some((e) => e.kind === "unresolved_authorization_restore_conflict")).toBe(false);
  });
});
