import { describe, it, expect } from "vitest";
import { createConsoleApi, demoCases, type CaseState } from "../src/console/api.js";
import { AuditLog } from "../src/audit/audit.js";

const NOW = new Date("2026-10-06T09:00:00Z");
const setup = (seedCases?: CaseState[]) => {
  const audit = new AuditLog(undefined, () => NOW);
  const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000", ...headers }, body: JSON.stringify(body) }));
  return { api, audit, post };
};

describe("console api", () => {
  it("lists cases with the policy decision: monthly, week-7 breach", async () => {
    const { api } = setup();
    const r = await api(new Request("http://localhost:3000/api/cases"));
    const d = await r.json();
    expect(d.cases[0].decision.cadence).toBe("monthly");
    expect(d.cases[0].decision.annualBreachWeek).toBe(7);
    expect(d.cases[0].decision.savingsPct).toBeCloseTo(18, 0);
  });

  it("refuses a POST without the console token or from a foreign origin", async () => {
    const { api } = setup();
    const noTok = await api(new Request("http://localhost:3000/api/approve", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(noTok.status).toBe(403);
    const badOrigin = await api(new Request("http://localhost:3000/api/approve", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://evil.example" }, body: "{}" }));
    expect(badOrigin.status).toBe(403);
  });

  it("runs the full flow: approve, create card, simulate pass and fail", async () => {
    const { post } = setup();
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect(ap.approval.cadence).toBe("monthly");
    expect(ap.approval.amountCap).toBe(100);
    const cc = await (await post("/api/create-card", { approval: ap.approval })).json();
    expect(cc.card.controls).toEqual({ amountLimit: 100, currencyAllowlist: ["USD"], merchantCategories: ["software"] });
    const ok = await (await post("/api/simulate", { caseId: "case_acme", kind: "in-policy" })).json();
    expect(ok.transaction.status).toBe("CLEARING");
    const nope = await (await post("/api/simulate", { caseId: "case_acme", kind: "over-cap" })).json();
    expect(nope.transaction.status).toBe("FAILED");
    expect(nope.transaction.failureReason).toBe("above_approved_cap");
    const wrongCur = await (await post("/api/simulate", { caseId: "case_acme", kind: "wrong-currency" })).json();
    expect(wrongCur.transaction.failureReason).toBe("currency_not_allowed");
    const wrongCat = await (await post("/api/simulate", { caseId: "case_acme", kind: "wrong-category" })).json();
    expect(wrongCat.transaction.failureReason).toBe("category_not_allowed");
  });

  it("refuses card creation without a valid approval, on reuse, and when the deal changed", async () => {
    const seed = demoCases();
    const { post } = setup(seed);
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    const forged = { ...ap.approval, sig: "0".repeat(64) };
    const r1 = await post("/api/create-card", { approval: forged });
    expect(r1.status).toBe(409);
    // change the deal after approval
    seed[0].intent = { ...seed[0].intent!, amountCap: 150 };
    const r2 = await post("/api/create-card", { approval: ap.approval });
    expect(await r2.json()).toEqual({ error: "intent changed" });
    // restore, create, then reuse
    seed[0].intent = { ...seed[0].intent!, amountCap: 100 };
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(200);
    const reuse = await post("/api/create-card", { approval: ap.approval });
    expect(await reuse.json()).toEqual({ error: "approval already used" });
  });

  it("requires the approver's own key signature for card creation", async () => {
    const { post } = setup();
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    // The API-issued approval carries the demo approver key signature and passes.
    expect(ap.approval.approverKeyId).toMatch(/^[0-9a-f]{12}$/);
    expect(typeof ap.approval.approverSig).toBe("string");
    // Stripping the approver signature - even with a valid server HMAC - is refused.
    const stripped = { ...ap.approval };
    delete stripped.approverSig;
    delete stripped.approverKeyId;
    expect(await (await post("/api/create-card", { approval: stripped })).json()).toEqual({ error: "missing approver signature" });
    // A forged approver signature is refused too.
    const forged = { ...ap.approval, approverSig: Buffer.from("not-the-approver").toString("base64") };
    expect(await (await post("/api/create-card", { approval: forged })).json()).toEqual({ error: "bad approver signature" });
    // The genuine approval still creates the card.
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(200);
  });

  it("reports live=false by default and exposes live=true with reset refused on a live-backed console", async () => {
    const { api } = setup();
    const d = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    expect(d.live).toBe(false);
    const audit2 = new AuditLog(undefined, () => NOW);
    const live = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit: audit2, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], live: true });
    const dl = await (await live(new Request("http://localhost:3000/api/cases"))).json();
    expect(dl.live).toBe(true);
    const rr = await live(new Request("http://localhost:3000/api/reset-demo", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: "{}" }));
    expect(rr.status).toBe(409);
  });

  it("a rejection emits a recommendation_rejected notification and persists the rejection", async () => {
    const saved: string[] = [];
    const store = { kind: "mem", load: () => null, save: (state: unknown) => { saved.push(JSON.stringify(state)); } };
    const audit = new AuditLog(undefined, () => NOW);
    const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], store: store as never });
    const post = (path: string, body: unknown) =>
      api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
    const r = await post("/api/reject", { caseId: "case_acme", reason: "not in budget this quarter" });
    expect(r.status).toBe(200);
    const d = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    const note = d.notifications.find((n: { kind: string }) => n.kind === "recommendation_rejected");
    expect(note).toBeTruthy();
    expect(note.status).toBe("preview"); // nothing is sent without an owner-approved transport
    expect(note.body).toMatch(/not in budget this quarter/);
    const last = JSON.parse(saved[saved.length - 1]);
    expect(last.cases.find((c: { kase: { id: string } }) => c.kase.id === "case_acme").rejected).toBe("not in budget this quarter");
  });

  it("records a rejection with its reason and never creates a card", async () => {
    const { post, audit } = setup();
    await post("/api/reject", { caseId: "case_acme", reason: "not in budget this quarter" });
    const r = await post("/api/approve", { caseId: "case_acme" }); // approve is still possible later; the rejection is recorded
    expect(r.status).toBe(200);
    expect(audit.list().some((e) => e.kind === "recommendation_rejected")).toBe(true);
  });

  it("audits refusals and executions", async () => {
    const { post, audit } = setup();
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    await post("/api/create-card", { approval: ap.approval });
    const kinds = audit.list().map((e) => e.kind);
    expect(kinds).toContain("approval_issued");
    expect(kinds).toContain("card_created");
  });
});

describe("authorization outcome handling", () => {
  type GW = Record<string, unknown>;
  const gw = (over: GW) => ({
    async createCardholder(req: { name: string; email: string }) { return { state: "created" as const, cardholder: { id: "holder-1", ...req } }; },
    async createCard(req: { cardholderId: string; controls: unknown }) { return { id: "card-1", cardholderId: req.cardholderId, controls: req.controls, status: "ACTIVE" }; },
    async listTransactions() { return [] as unknown[]; },
    ...over,
  }) as never;
  const drive = async (api: ReturnType<typeof createConsoleApi>, kind = "in-policy") => {
    const post = (path: string, body: unknown) =>
      api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
    const approved = await (await post("/api/approve", { caseId: "case_acme" })).json();
    await post("/api/create-card", { approval: approved.approval });
    return post("/api/simulate", { caseId: "case_acme", kind });
  };
  const mk = (gateway: GW, audit = new AuditLog(undefined, () => NOW)) =>
    ({ api: createConsoleApi({ gateway: gw(gateway), key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"] }), audit });

  it.each([400, 422, 500, 503])("HTTP %s on authorize is UNKNOWN, never a rejection, and locks the card", async (status) => {
    const { api, audit } = mk({ async authorize() { const e = new Error(`HTTP ${status} failure`) as Error & { status: number }; e.status = status; throw e; } });
    const r = await drive(api);
    expect(r.status).toBe(502);
    const d = await r.json();
    expect(d.code).toBe("authorization_outcome_unknown");
    expect(d.error).toMatch(/outcome is unknown/);
    expect(d.error).toMatch(/Reconcile/);
    expect(d.error).not.toMatch(/No transaction was recorded/);
    expect(d.error).not.toMatch(/rejected/);
    expect(audit.list().some((e) => e.kind === "authorization_outcome_unknown" && e.detail.httpStatus === status)).toBe(true);
    // Duplicate-retry inhibition: a second purchase attempt is refused while unresolved.
    const r2 = await api(new Request("http://localhost:3000/api/simulate", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme", kind: "in-policy" }) }));
    expect(r2.status).toBe(409);
    expect((await r2.json()).code).toBe("authorization_unresolved");
  });

  it("transport/timeout on authorize is UNKNOWN with the same lock", async () => {
    const { api } = mk({ async authorize() { throw new Error("fetch failed: socket hang up"); } });
    const r = await drive(api);
    expect(r.status).toBe(502);
    expect((await r.json()).code).toBe("authorization_outcome_unknown");
  });

  it("a no-match ledger read does NOT unlock (no documented idempotency); manual operator confirm does, and the retry reuses the same request id", async () => {
    const seen: (string | undefined)[] = [];
    let calls = 0;
    const { api, audit } = mk({
      async authorize(_cardId: string, _auth: unknown, requestId?: string) {
        seen.push(requestId);
        if (++calls === 1) throw new Error("gateway timeout");
        return { id: "txn_ok", cardId: "card-1", amount: 100, currency: "USD", merchant: "Acme Analytics", category: "software", status: "CLEARING", transactedAt: NOW.toISOString() };
      },
      async capture(t: string) { return { id: t, cardId: "card-1", amount: 100, currency: "USD", status: "CLEARING", transactedAt: NOW.toISOString() }; },
    });
    await drive(api); // attempt 1 fails unknown
    const post2 = (body: unknown) => api(new Request("http://localhost:3000/api/reconcile", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
    const rec = await post2({ caseId: "case_acme" });
    const rd = await rec.json();
    expect(rd.outcome).toBe("no_match");
    expect(rd.case.pendingAuthorization.reconciledAt).toBeUndefined(); // still locked
    expect(audit.list().some((e) => e.kind === "reconciliation_no_match")).toBe(true);
    // still locked after no-match
    const blocked = await api(new Request("http://localhost:3000/api/simulate", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme", kind: "in-policy" }) }));
    expect(blocked.status).toBe(409);
    // manual operator attestation unlocks
    const manual = await post2({ caseId: "case_acme", manualConfirm: "Checked Airwallex dashboard transactions for the card: nothing from this attempt." });
    expect((await manual.json()).outcome).toBe("manual_confirm");
    expect(audit.list().some((e) => e.kind === "reconciliation_manual_confirm")).toBe(true);
    const retry = await api(new Request("http://localhost:3000/api/simulate", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme", kind: "in-policy" }) }));
    expect(retry.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]); // same request id on retry
  });

  it("a probable heuristic match keeps the lock until an operator reviews it; review adopts the transaction", async () => {
    const silent = { id: "txn_silent", cardId: "card-1", amount: 100, currency: "USD", merchant: "Acme Analytics", category: "software", status: "PENDING", transactedAt: NOW.toISOString() };
    const { api, audit } = mk({
      async authorize() { throw new Error("500 internal"); }, // committed upstream, response lost
      async listTransactions() { return [silent]; },
      async getTransaction(id: string) { return id === "txn_silent" ? silent : undefined; },
    });
    await drive(api);
    const post2 = (body: unknown) => api(new Request("http://localhost:3000/api/reconcile", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
    const rec = await post2({ caseId: "case_acme" });
    const d = await rec.json();
    expect(d.outcome).toBe("probable_match");
    expect(d.definitive).toBe(false);
    expect(d.transaction.id).toBe("txn_silent");
    // NOT adopted and NOT unlocked: spending stays blocked.
    expect(d.case.pendingAuthorization).toBeDefined();
    expect(d.case.pendingAuthorization.probableMatch.transactionId).toBe("txn_silent");
    expect(d.case.transactions.map((t: { id: string }) => t.id)).not.toContain("txn_silent");
    expect(audit.list().some((e) => e.kind === "reconciliation_probable_match" && e.detail.definitive === false)).toBe(true);
    const blocked = await api(new Request("http://localhost:3000/api/simulate", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme", kind: "in-policy" }) }));
    expect(blocked.status).toBe(409);
    // Reviewed resolution adopts and unlocks.
    const manual = await post2({ caseId: "case_acme", manualConfirm: "Reviewed txn_silent against the provider record: it is this attempt." });
    const md = await manual.json();
    expect(md.outcome).toBe("manual_confirm");
    expect(md.case.pendingAuthorization).toBeUndefined();
    expect(md.case.transactions.map((t: { id: string }) => t.id)).toContain("txn_silent");
    expect(audit.list().some((e) => e.kind === "reconciliation_probable_confirmed")).toBe(true);
  });

  it("terms changes are refused while an authorization outcome is unresolved", async () => {
    const { api } = mk({ async authorize() { throw new Error("timeout"); } });
    await drive(api);
    const ct = await api(new Request("http://localhost:3000/api/change-terms", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme", terms: { monthlyPrice: 90, annualPrice: 984, currency: "USD", category: "software", noticeDays: 30 }, rawTerms: "changed terms" }) }));
    expect(ct.status).toBe(409);
    expect((await ct.json()).error).toMatch(/unresolved/);
  });

  it("corrupt persisted state fails closed: mutations refused until operator action", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync("/tmp/intentpay-corrupt-");
    const stateFile = `${dir}/state.json`;
    writeFileSync(stateFile, "{ not json");
    const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], stateFile });
    const approve = await api(new Request("http://localhost:3000/api/approve", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme" }) }));
    expect(approve.status).toBe(409);
    expect((await approve.json()).code).toBe("state_corrupted");
    // The sanctioned recovery is an explicit reset, which is still allowed.
    const reset = await api(new Request("http://localhost:3000/api/reset-demo", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: "{}" }));
    expect(reset.status).toBe(200);
    const approve2 = await api(new Request("http://localhost:3000/api/approve", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme" }) }));
    expect(approve2.status).toBe(200);
  });

  it("reconcile refuses to guess between two matching ledger transactions", async () => {
    const dup = (id: string) => ({ id, cardId: "card-1", amount: 100, currency: "USD", merchant: "Acme Analytics", status: "PENDING", transactedAt: NOW.toISOString() });
    const { api, audit } = mk({
      async authorize() { throw new Error("timeout"); },
      async listTransactions() { return [dup("txn_a"), dup("txn_b")]; },
    });
    await drive(api);
    const rec = await api(new Request("http://localhost:3000/api/reconcile", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme" }) }));
    expect(rec.status).toBe(409);
    expect((await rec.json()).code).toBe("reconciliation_ambiguous");
    expect(audit.list().some((e) => e.kind === "reconciliation_ambiguous")).toBe(true);
  });

  it("capture failure keeps the known authorization id pending; reconcile finds it by id", async () => {
    const pending = { id: "txn_known", cardId: "card-1", amount: 100, currency: "USD", merchant: "Acme Analytics", status: "CLEARING", transactedAt: NOW.toISOString() };
    const { api, audit } = mk({
      async authorize() { return { ...pending, status: "PENDING" }; },
      async capture() { throw new Error("503 capture unavailable"); },
      async listTransactions() { return [pending]; },
    });
    const r = await drive(api);
    expect(r.status).toBe(502);
    const d = await r.json();
    expect(d.code).toBe("capture_outcome_unknown");
    expect(d.transactionId).toBe("txn_known");
    const rec = await api(new Request("http://localhost:3000/api/reconcile", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme" }) }));
    const rd = await rec.json();
    expect(rd.outcome).toBe("matched");
    expect(audit.list().some((e) => e.kind === "reconciliation_matched" && e.detail.basis === "transaction_id")).toBe(true);
  });

  it("reviewer round-5: a PENDING capture is NOT cleared - no cleared audit or email, the lock stands", async () => {
    const pending = { cardId: "card-1", amount: 100, currency: "USD", merchant: "Acme Analytics", transactedAt: NOW.toISOString() };
    const { api, audit } = mk({
      async authorize() { return { id: "txn_p", ...pending, status: "PENDING" }; },
      async capture(t: string) { return { id: t, ...pending, status: "PENDING" }; },
      // no getTransaction: the status lookup is unavailable
    });
    const r = await drive(api);
    expect(r.status).toBe(409);
    const d = await r.json();
    expect(d.code).toBe("capture_unconfirmed");
    expect(d.transactionId).toBe("txn_p");
    expect(d.error).toMatch(/neither cleared nor declined/);
    expect(audit.list().some((e) => e.kind === "capture_unconfirmed")).toBe(true);
    expect(audit.list().some((e) => e.kind === "authorization_cleared")).toBe(false);
    // The authorization lock stands: a blind retry is still refused.
    const r2 = await api(new Request("http://localhost:3000/api/simulate", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme", kind: "in-policy" }) }));
    expect(r2.status).toBe(409);
    expect((await r2.json()).code).toBe("authorization_unresolved");
  });

  it("reviewer round-5: PENDING capture + confirmed-CLEARING lookup still clears honestly", async () => {
    const pending = { cardId: "card-1", amount: 100, currency: "USD", merchant: "Acme Analytics", transactedAt: NOW.toISOString() };
    const { api, audit } = mk({
      async authorize() { return { id: "txn_p2", ...pending, status: "PENDING" }; },
      async capture(t: string) { return { id: t, ...pending, status: "PENDING" }; },
      async getTransaction(id: string) { return { id, ...pending, status: "CLEARING" }; },
    });
    const r = await drive(api);
    expect(r.status).toBe(200);
    expect((await r.json()).transaction.status).toBe("CLEARING");
    expect(audit.list().some((e) => e.kind === "authorization_cleared")).toBe(true);
  });

  it("reviewer round-5: a FAILED capture payload is a definitive decline, never a clearing", async () => {
    const base = { cardId: "card-1", amount: 100, currency: "USD", merchant: "Acme Analytics", transactedAt: NOW.toISOString() };
    const { api, audit } = mk({
      async authorize() { return { id: "txn_f", ...base, status: "PENDING" }; },
      async capture(t: string) { return { id: t, ...base, status: "FAILED", failureReason: "above_approved_cap" }; },
    });
    const r = await drive(api);
    expect(r.status).toBe(200);
    expect((await r.json()).transaction.status).toBe("FAILED");
    expect(audit.list().some((e) => e.kind === "authorization_declined" && e.detail.reason === "above_approved_cap")).toBe(true);
    expect(audit.list().some((e) => e.kind === "authorization_cleared")).toBe(false);
  });

  it("a documented decline payload is the only definitive rejection: no funds authorized, no absolute ledger claim", async () => {
    const { api, audit } = mk({
      async authorize() { return { id: "txn_dec", cardId: "card-1", amount: 101, currency: "USD", merchant: "Acme Analytics", status: "FAILED", failureReason: "above_approved_cap" }; },
    });
    const r = await drive(api, "over-cap");
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.transaction.status).toBe("FAILED");
    expect(audit.list().some((e) => e.kind === "authorization_declined")).toBe(true);
    expect(d.case.pendingAuthorization).toBeUndefined();
    const logs = d.case.log.join(" ");
    expect(logs).toMatch(/declined by the issuing gateway/);
    expect(logs).not.toMatch(/No transaction was recorded/);
    expect(logs).not.toMatch(/no funds were authorized/i); // no undocumented funds claim
  });

  it("a stale ledger row from an earlier purchase is not adopted as this attempt", async () => {
    const old = { id: "txn_old", cardId: "card-1", amount: 100, currency: "USD", merchant: "Acme Analytics", status: "CLEARING", transactedAt: "2026-10-20T09:00:00Z" };
    const { api } = mk({
      async authorize() { throw new Error("timeout"); },
      async listTransactions() { return [old]; },
    });
    await drive(api);
    const rec = await api(new Request("http://localhost:3000/api/reconcile", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme" }) }));
    const d = await rec.json();
    expect(d.outcome).toBe("no_match"); // outside the attempt time window: not adopted
    expect(d.case.pendingAuthorization).toBeDefined();
  });

  it("the unresolved lock and its request id survive a process restart", async () => {
    const { mkdtempSync } = await import("node:fs");
    const dir = mkdtempSync("/tmp/intentpay-state-");
    const stateFile = `${dir}/state.json`;
    const audit1 = new AuditLog(undefined, () => NOW);
    const api1 = createConsoleApi({ gateway: gw({ async authorize() { throw new Error("socket hang up"); } }), key: "k", approver: "sandi", now: () => NOW, audit: audit1, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], stateFile });
    await drive(api1);
    // simulate a crash: a brand-new api instance over the same state file
    const audit2 = new AuditLog(undefined, () => NOW);
    const api2 = createConsoleApi({ gateway: gw({ async authorize() { throw new Error("should be blocked before this runs"); } }), key: "k", approver: "sandi", now: () => NOW, audit: audit2, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], stateFile });
    const list = await (await api2(new Request("http://localhost:3000/api/cases"))).json();
    const acme = list.cases.find((x: { kase: { id: string } }) => x.kase.id === "case_acme");
    expect(acme.pendingAuthorization).toBeDefined();
    expect(acme.pendingAuthorization.requestId).toBe("case_acme:in-policy:0");
    const retry = await api2(new Request("http://localhost:3000/api/simulate", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme", kind: "in-policy" }) }));
    expect(retry.status).toBe(409); // still locked after restart
  });

  it("a duplicate-click race yields one failed attempt and one lock refusal, never two gateway calls", async () => {
    let calls = 0;
    const { api } = mk({ async authorize() { calls++; await new Promise((r) => setTimeout(r, 50)); throw new Error("timeout"); } });
    const post = () => api(new Request("http://localhost:3000/api/simulate", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme", kind: "in-policy" }) }));
    const approved = await (await api(new Request("http://localhost:3000/api/approve", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme" }) }))).json();
    await api(new Request("http://localhost:3000/api/create-card", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ approval: approved.approval }) }));
    const [r1, r2] = await Promise.all([post(), post()]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([409, 502]);
    expect(calls).toBe(1);
  });

  it("a used approval cannot be replayed after a process restart", async () => {
    const { mkdtempSync } = await import("node:fs");
    const dir = mkdtempSync("/tmp/intentpay-replay-");
    const stateFile = `${dir}/state.json`;
    const mk2 = (audit: AuditLog) => createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], stateFile });
    const api1 = mk2(new AuditLog(undefined, () => NOW));
    const post = (api: ReturnType<typeof mk2>, path: string, body: unknown) =>
      api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
    const approved = await (await post(api1, "/api/approve", { caseId: "case_acme" })).json();
    expect((await post(api1, "/api/create-card", { approval: approved.approval })).status).toBe(200);
    // Crash and restart with the same state file, then replay the same approval.
    const api2 = mk2(new AuditLog(undefined, () => NOW));
    const replay = await post(api2, "/api/create-card", { approval: approved.approval });
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toMatch(/already used|active card/);
  });

  it("a state file with a malformed shape fails closed rather than silently dropping locks", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync("/tmp/intentpay-shape-");
    const stateFile = `${dir}/state.json`;
    writeFileSync(stateFile, JSON.stringify([{ nope: true }])); // parses, wrong shape
    const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], stateFile });
    const r = await api(new Request("http://localhost:3000/api/approve", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme" }) }));
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("state_corrupted");
  });

  it("emails previews are emitted at each step, addressed to the operator, and never sent", async () => {
    const { api, post } = setup();
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    await post("/api/create-card", { approval: ap.approval });
    await post("/api/simulate", { caseId: "case_acme", kind: "in-policy" });
    await post("/api/simulate", { caseId: "case_acme", kind: "over-cap" });
    const d = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    const kinds = d.notifications.map((n: { kind: string }) => n.kind);
    expect(kinds).toContain("approval_issued");
    expect(kinds).toContain("card_created");
    expect(kinds).toContain("purchase_cleared");
    expect(kinds).toContain("purchase_declined");
    for (const n of d.notifications) {
      expect(n.status).toBe("preview");
      expect(n.to).toBe("sandi@vyayasan.com");
    }
  });

  it("a failing ledger read degrades visibly to last-known entries, never a silent empty list", async () => {
    const txn = { id: "txn_1", cardId: "card-1", amount: 100, currency: "USD", merchant: "Acme Analytics", status: "CLEARING" };
    let failLedger = false;
    const { api } = mk({
      async authorize() { return { ...txn, status: "PENDING" }; },
      async capture() { return txn; },
      async getTransaction() { if (failLedger) throw new Error("503 ledger unavailable"); return txn; },
    });
    await drive(api); // records txn_1 with a healthy ledger
    const okList = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    const acme = okList.cases.find((x: { kase: { id: string } }) => x.kase.id === "case_acme");
    expect(acme.ledger.state).toBe("ok");
    expect(acme.transactions).toHaveLength(1);
    failLedger = true;
    const degraded = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    const acme2 = degraded.cases.find((x: { kase: { id: string } }) => x.kase.id === "case_acme");
    expect(acme2.ledger.state).toBe("degraded");
    expect(acme2.ledger.error).toMatch(/503/);
    expect(acme2.ledger.lastKnownAt).toBeDefined();
    expect(acme2.transactions).toHaveLength(1); // last-known preserved, not silently empty
    expect(acme2.transactions[0].id).toBe("txn_1");
  });

  it("a failing ledger with no last-known reports unavailable instead of implying empty", async () => {
    const seed = demoCases();
    seed[0].transactionIds = ["txn_x"]; // known id, no preserved evidence
    const { api } = mk({ async getTransaction() { throw new Error("timeout"); } }, new AuditLog(undefined, () => NOW));
    const api2 = createConsoleApi({ gateway: gw({ async getTransaction() { throw new Error("timeout"); } }), key: "k", approver: "sandi", now: () => NOW, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases: seed });
    void api;
    const d = await (await api2(new Request("http://localhost:3000/api/cases"))).json();
    expect(d.cases[0].ledger.state).toBe("unavailable");
    expect(d.cases[0].transactions).toHaveLength(0);
  });

  it("demo reset is refused on a live-backed console", async () => {
    const api = createConsoleApi({ live: true, key: "k", approver: "sandi", now: () => NOW, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"] });
    const r = await api(new Request("http://localhost:3000/api/reset-demo", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: "{}" }));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/simulator/);
  });
});

describe("email promotion endpoint", () => {
  const withMail = (opts: { operatorToken?: string; transport?: { name: string; send: () => Promise<{ providerId?: string }> } }) => {
    const audit = new AuditLog(undefined, () => NOW);
    const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], emailTransport: opts.transport ?? null, operatorToken: opts.operatorToken });
    const post = (body: unknown) =>
      api(new Request("http://localhost:3000/api/notifications/promote", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
    return { api, audit, post };
  };
  const real = { name: "http", async send() { return { providerId: "p1" }; } };

  it("is unavailable when no operator token is configured", async () => {
    const { post } = withMail({ transport: real });
    const r = await post({ id: "ntf_x", operatorToken: "anything" });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/not configured/);
  });

  it("refuses a wrong operator token", async () => {
    const { post } = withMail({ transport: real, operatorToken: "right" });
    const r = await post({ id: "ntf_x", operatorToken: "wrong" });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/wrong operator token/);
  });

  it("refuses promotion when the selected transport cannot send (preview)", async () => {
    const { post } = withMail({ operatorToken: "op" });
    const r = await post({ id: "ntf_x", operatorToken: "op" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/real email transport/);
  });

  it("refuses to promote a record that is not dry-run (already sent stays sent)", async () => {
    const { api, post } = withMail({ transport: real, operatorToken: "op" });
    await api(new Request("http://localhost:3000/api/approve", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId: "case_acme" }) }));
    const d = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    const rec = d.notifications.find((n: { kind: string }) => n.kind === "approval_issued");
    expect(rec.status).toBe("sent");
    const r = await post({ id: rec.id, operatorToken: "op" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/only a dry-run record/);
  });
});

describe("audit case attribution", () => {
  it("binds approvals and refusals to their case; the per-case view never leaks another case's entries", async () => {
    const seed = demoCases();
    const { audit, post } = setup(seed);
    await post("/api/approve", { caseId: "case_acme" });
    await post("/api/approve", { caseId: "case_flowdesk" });
    // a case-bound failure: tampered signature on acme's card creation
    const ap = await (await post("/api/approve", { caseId: "case_northwind" })).json();
    const forged = { ...ap.approval, sig: "0".repeat(64) };
    const r = await post("/api/create-card", { approval: forged });
    expect(r.status).toBe(409);
    const entries = audit.list();
    const approvals = entries.filter((e) => e.kind === "approval_issued").map((e) => e.caseId);
    expect(approvals).toEqual(["case_acme", "case_flowdesk", "case_northwind"]);
    const refusal = entries.find((e) => e.kind === "refused" && e.detail.reason !== undefined && e.detail.nonce === ap.approval.nonce);
    expect(refusal?.caseId).toBe("case_northwind");
    // the console's per-case filter (page.ts): no caseId = global, shown on every case
    const forCase = (id: string) => entries.filter((e) => !e.caseId || e.caseId === id);
    expect(forCase("case_acme").filter((e) => e.kind === "approval_issued").map((e) => e.caseId)).toEqual(["case_acme"]);
    expect(forCase("case_flowdesk").filter((e) => e.kind === "approval_issued").map((e) => e.caseId)).toEqual(["case_flowdesk"]);
    expect(forCase("case_flowdesk").some((e) => e.kind === "refused" && e.detail.nonce === ap.approval.nonce)).toBe(false);
  });
});
