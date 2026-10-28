// Structural finding (independent review round 2 + main): after an AMBIGUOUS create-card
// outcome the provider may hold a card we cannot see, and a fresh approval carries a fresh
// nonce - a fresh provider idempotency slot - so a blind fresh approval could create a
// SECOND card. Safety must be enforced in code, not documented in a runbook: while
// createCardUnresolved stands, approve and create-card refuse, and only a provider card
// listing can clear the lock.
import { describe, it, expect } from "vitest";
import { createConsoleApi } from "../src/console/api.js";
import { AuditLog } from "../src/audit/audit.js";

const NOW = new Date("2026-10-06T09:00:00Z");
type GW = Record<string, unknown>;
const mk = (gateway: GW, extra: Record<string, unknown> = {}) => {
  const audit = new AuditLog(undefined, () => NOW);
  const api = createConsoleApi({
    gateway: {
      supportsAuthoritativeAbsence: true, // mk() doubles behave like the strongly-consistent sim; tests can override
      async createCardholder(req: { name: string; email: string }) { return { state: "created" as const, cardholder: { id: "holder-1", ...req } }; },
      async createCard(req: { cardholderId: string; controls: unknown }) { return { id: "card-1", cardholderId: req.cardholderId, controls: req.controls, status: "ACTIVE" }; },
      async listTransactions() { return [] as unknown[]; },
      ...gateway,
    } as never,
    key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok",
    allowedOrigins: ["http://localhost:3000"], ...extra,
  });
  const post = (path: string, body: unknown) =>
    api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
  return { api, post, audit };
};

describe("card issuance ambiguity lock (structural: no fresh-nonce duplicate)", () => {
  it("ambiguous create locks the case; fresh approval refused; operator adopts the provider-verified card", async () => {
    const remote: Array<{ id: string; cardholderId: string; controls: unknown; status: string }> = [];
    const { post } = mk({
      // The failure mode that matters: the card WAS created remotely, then the reply died.
      async createCard(req: { cardholderId: string; controls: unknown }) {
        remote.push({ id: "card-remote-1", cardholderId: req.cardholderId, controls: req.controls, status: "ACTIVE" });
        throw new Error("socket hangup after commit");
      },
      async listCards() { return remote; },
      // Adopt verifies provider-side controls by read-back (round-3 N1): expose the real record.
      async readCardControls(id: string) { return remote.find((r) => r.id === id)?.controls; },
    });
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    const r1 = await post("/api/create-card", { approval: ap.approval });
    expect(r1.status).toBe(409);
    expect((await r1.json()).error).toMatch(/outcome unknown/);

    // The duplicate path is closed: a fresh approval (fresh nonce) is refused while locked.
    const r2 = await post("/api/approve", { caseId: "case_acme" });
    expect(r2.status).toBe(409);
    expect((await r2.json()).error).toMatch(/reconcile-card/);

    // The listing is provider-side evidence.
    const chk = await (await post("/api/reconcile-card", { caseId: "case_acme", decision: "check" })).json();
    expect(chk.remoteCards).toHaveLength(1);

    // "Nothing was created" is contradicted by the provider and refused.
    expect((await post("/api/reconcile-card", { caseId: "case_acme", decision: "none-created" })).status).toBe(409);
    // Adopting a card that is not in this cardholder's provider listing is refused.
    expect((await post("/api/reconcile-card", { caseId: "case_acme", decision: "adopt", cardId: "card-not-there" })).status).toBe(409);

    // Adopting the provider-verified card clears the lock and continues the flow.
    const ad = await post("/api/reconcile-card", { caseId: "case_acme", decision: "adopt", cardId: "card-remote-1" });
    expect(ad.status).toBe(200);
    const v = await ad.json();
    expect(v.card.id).toBe("card-remote-1");
    expect(v.case.createCardUnresolved).toBeUndefined();
    expect(v.card.controls.amountLimit).toBe(v.case.intent.amountCap); // intent controls overlaid
  });

  it("provider-empty listing unlocks; the fresh approval then issues exactly one card", async () => {
    let created = 0, fail = true;
    const { post } = mk({
      async createCard(req: { cardholderId: string; controls: unknown }) {
        if (fail) throw new Error("connection reset before any response");
        created++;
        return { id: "card-1", cardholderId: req.cardholderId, controls: req.controls, status: "ACTIVE" };
      },
      async listCards() { return []; },
    });
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(409);
    // A bare click is refused; the unlock needs an operator attestation (round-3 N3).
    expect((await post("/api/reconcile-card", { caseId: "case_acme", decision: "none-created" })).status).toBe(409);
    expect((await post("/api/reconcile-card", { caseId: "case_acme", decision: "none-created", attestation: "short" })).status).toBe(409);
    const nc = await post("/api/reconcile-card", { caseId: "case_acme", decision: "none-created", attestation: "verified the provider card list is empty in the dashboard" });
    expect(nc.status).toBe(200);
    fail = false;
    const ap2 = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect((await post("/api/create-card", { approval: ap2.approval })).status).toBe(200);
    expect(created).toBe(1);
  });

  it("a gateway with no provider card listing cannot reconcile: 501 and the lock stands", async () => {
    const noList = {
      async createCard() { throw new Error("timeout"); },
      listCards: undefined,
    };
    const { post } = mk(noList);
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(409);
    const r = await post("/api/reconcile-card", { caseId: "case_acme", decision: "check" });
    expect(r.status).toBe(501);
    expect((await r.json()).error).toMatch(/stays disabled/);
    // Still locked afterwards.
    expect((await post("/api/approve", { caseId: "case_acme" })).status).toBe(409);
  });

  it("the lock survives a restart (persisted), and reconciliation still works off the recorded cardholder id", async () => {
    const { mkdtempSync } = await import("node:fs");
    const dir = mkdtempSync("/tmp/intentpay-cardlock-");
    const stateFile = `${dir}/state.json`;
    const failGw = {
      async createCard() { throw new Error("dropped after commit"); },
      async listCards() { return []; },
    };
    const one = mk(failGw, { stateFile });
    const ap = await (await one.post("/api/approve", { caseId: "case_acme" })).json();
    expect((await one.post("/api/create-card", { approval: ap.approval })).status).toBe(409);
    // Restart against the same state file: fresh module holderId, lock persisted.
    const two = mk(failGw, { stateFile });
    const list = await (await two.api(new Request("http://localhost:3000/api/cases"))).json();
    const acme = list.cases.find((x: { kase: { id: string } }) => x.kase.id === "case_acme");
    expect(acme.createCardUnresolved).toBeDefined();
    expect(acme.createCardUnresolved.cardholderId).toBe("holder-1");
    expect((await two.post("/api/approve", { caseId: "case_acme" })).status).toBe(409);
    expect((await two.post("/api/reconcile-card", { caseId: "case_acme", decision: "none-created", attestation: "verified empty at the provider" })).status).toBe(200);
  });
});


describe("round-3 reconcile hardening (N1-N3)", () => {
  it("N1: adopt CORRECTS mismatched provider controls and verifies the read-back", async () => {
    const remote: { id: string; cardholderId: string; controls: Record<string, unknown>; status: string }[] = [];
    const { post } = mk({
      async createCard(req: { cardholderId: string; controls: unknown }) {
        // Committed with WRONG controls (partial/tampered provider state), then died.
        remote.push({ id: "card-remote-9", cardholderId: req.cardholderId, controls: { amountLimit: 999999, currencyAllowlist: ["USD", "EUR"], merchantCategories: ["software", "travel"] }, status: "ACTIVE" });
        throw new Error("sandbox 400: ambiguous failure after commit");
      },
      async listCards() { return remote; },
      async readCardControls(id: string) { return remote.find((r) => r.id === id)?.controls; },
      async setCardControls(id: string, controls: Record<string, unknown>) { const r = remote.find((x) => x.id === id); r!.controls = controls; return r!.controls; },
    });
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(409);
    const ad = await post("/api/reconcile-card", { caseId: "case_acme", decision: "adopt", cardId: "card-remote-9" });
    expect(ad.status).toBe(200);
    const v = await ad.json();
    // The PROVIDER record was corrected to the intent payload - not merely overlaid locally.
    expect(remote[0].controls.amountLimit).toBe(v.case.intent.amountCap);
    expect(remote[0].controls.currencyAllowlist).toEqual([v.case.intent.currency]);
    expect(remote[0].controls.merchantCategories).toEqual(v.case.intent.categories);
    expect(v.card.controls.amountLimit).toBe(v.case.intent.amountCap);
  });

  it("N1: adopt REFUSES when controls mismatch and the gateway cannot correct them; freeze-stray is the way out", async () => {
    const remote: { id: string; cardholderId: string; controls: Record<string, unknown>; status: string }[] = [];
    const { post } = mk({
      async createCard(req: { cardholderId: string }) {
        remote.push({ id: "card-stray-1", cardholderId: req.cardholderId, controls: { amountLimit: 999999, currencyAllowlist: ["USD", "EUR"], merchantCategories: ["travel"] }, status: "ACTIVE" });
        throw new Error("ambiguous");
      },
      async listCards() { return remote; },
      async readCardControls(id: string) { return remote.find((r) => r.id === id)?.controls; },
      async freezeCard(id: string) { const r = remote.find((x) => x.id === id); r!.status = "FROZEN"; return r; },
    });
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(409);
    const ad = await post("/api/reconcile-card", { caseId: "case_acme", decision: "adopt", cardId: "card-stray-1" });
    expect(ad.status).toBe(409);
    expect((await ad.json()).error).toMatch(/freeze-stray/);
    // The stray is still spendable until frozen; the lock is still on.
    expect(remote[0].status).toBe("ACTIVE");
    const fs = await post("/api/reconcile-card", { caseId: "case_acme", decision: "freeze-stray", cardId: "card-stray-1" });
    expect(fs.status).toBe(200);
    expect(remote[0].status).toBe("FROZEN");
    const v = await fs.json();
    expect(v.case.createCardUnresolved).toBeUndefined();
    expect(v.case.card).toBeUndefined(); // no card adopted; fresh approval required
  });

  it("N2: a restart reuses the durable cardholder id - no duplicate cardholder at the provider", async () => {
    const { mkdtempSync } = await import("node:fs");
    const dir = mkdtempSync("/tmp/intentpay-holder-");
    const stateFile = `${dir}/state.json`;
    let cardholders = 0;
    const gw = {
      async createCardholder(req: { name: string; email: string }) { cardholders++; return { state: "created" as const, cardholder: { id: "holder-1", ...req } }; },
      async listCards() { return []; },
    };
    const one = mk(gw, { stateFile });
    const a1 = await (await one.post("/api/approve", { caseId: "case_acme" })).json();
    expect((await one.post("/api/create-card", { approval: a1.approval })).status).toBe(200);
    const two = mk(gw, { stateFile }); // restart over the same state file
    const a2 = await (await two.post("/api/approve", { caseId: "case_flowdesk" })).json();
    expect((await two.post("/api/create-card", { approval: a2.approval })).status).toBe(200);
    expect(cardholders).toBe(1);
  });

  it("N2: a cardholder-ambiguous crash is recoverable via provider-verified absence + attestation", async () => {
    const { post } = mk({
      async createCardholder() { throw new Error("committed then failed"); },
      async listCards() { return []; },
      async findCardholderByEmail() { return { state: "absent" as const }; }, // provider-verified: no cardholder exists
    });
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(409);
    const chk = await (await post("/api/reconcile-card", { caseId: "case_acme", decision: "check" })).json();
    expect(chk.remoteCards).toEqual([]);
    expect(chk.note).toMatch(/no cardholder/);
    expect((await post("/api/reconcile-card", { caseId: "case_acme", decision: "adopt", cardId: "x" })).status).toBe(409);
    expect((await post("/api/reconcile-card", { caseId: "case_acme", decision: "none-created", attestation: "verified no cardholder or cards at the provider" })).status).toBe(200);
  });

  it("N3: an empty first read that turns non-empty on re-read keeps the lock", async () => {
    let reads = 0;
    const remote: { id: string; cardholderId: string; controls: unknown; status: string }[] = [];
    const { post } = mk({
      async createCard() { throw new Error("ambiguous"); },
      async listCards() {
        reads++;
        if (reads === 2) remote.push({ id: "card-late", cardholderId: "holder-1", controls: {}, status: "ACTIVE" }); // lagging visibility
        return remote;
      },
    });
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(409);
    const r = await post("/api/reconcile-card", { caseId: "case_acme", decision: "none-created", attestation: "verified empty once" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/changed between reads/);
  });
});

describe("round-4 N5/N3-residual regressions", () => {
  it("cardholder lookup UNKNOWN (provider error) keeps the lock; no new cardholder create", async () => {
    let holderCreates = 0;
    const { post } = mk({
      async createCardholder() { holderCreates++; throw new Error("list failed before create"); },
      async findCardholderByEmail() { return { state: "unknown" as const, error: "HTTP 503" }; },
      async listCards() { return []; },
    });
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    const r = await post("/api/create-card", { approval: ap.approval });
    expect(r.status).toBe(409);
    expect(holderCreates, "lookup failure must not become a create").toBe(1); // attempted once, threw before any provider create
    for (const decision of ["check", "none-created", "adopt"] as const) {
      const rr = await post("/api/reconcile-card", { caseId: "case_acme", decision, cardId: "x", attestation: "checked the provider dashboard" });
      expect(rr.status, `decision=${decision} stays locked on unknown`).toBe(409);
    }
  });

  it("none-created is disabled on a gateway without authoritative absence (no documented consistency)", async () => {
    // Live-provider shape: card committed remotely, reply lost; gateway lists empty (lag possible)
    // and does NOT claim read-after-write consistency. Attestation + double-empty-read must not unlock.
    const remote: Array<{ id: string; cardholderId: string; controls: unknown; status: string }> = [];
    const { post } = mk({
      supportsAuthoritativeAbsence: undefined, // live providers document no consistency guarantee
      async createCard(req: { cardholderId: string; controls: unknown }) {
        remote.push({ id: "card-remote-1", cardholderId: req.cardholderId, controls: req.controls, status: "ACTIVE" });
        throw new Error("socket hangup after commit");
      },
      async listCards() { return []; }, // lagging/empty listing
      async readCardControls(id: string) { return remote.find((r) => r.id === id)?.controls; },
    });
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    await post("/api/create-card", { approval: ap.approval });
    const unlock = await post("/api/reconcile-card", { caseId: "case_acme", decision: "none-created", attestation: "I checked the provider dashboard" });
    expect(unlock.status).toBe(409);
    const body = await unlock.json();
    expect(String(body.error)).toMatch(/not authoritative|consistency/i);
  });
});

describe("reviewer round-5: reject gated on unresolved card issuance", () => {
  it("reject is refused while createCardUnresolved stands; after verified none-created it succeeds with true no-card wording", async () => {
    const { api, post, audit } = mk({
      async createCard() { throw new Error("socket hangup after commit"); },
      async listCards() { return []; },
    });
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(409);
    // While issuance is unresolved a stray provider card may exist: reject must refuse,
    // never emit a "no card was created" claim.
    const r = await post("/api/reject", { caseId: "case_acme", reason: "not in budget" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/issuance on this case is unresolved/);
    expect(audit.list().some((e) => e.kind === "refused" && /issuance is unresolved/.test(String(e.detail.reason)))).toBe(true);
    // After a verified none-created reconciliation the reject goes through, wording true.
    expect((await post("/api/reconcile-card", { caseId: "case_acme", decision: "none-created", attestation: "verified empty at the provider" })).status).toBe(200);
    expect((await post("/api/reject", { caseId: "case_acme", reason: "not in budget" })).status).toBe(200);
    const list = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    const [n] = list.notifications.filter((x: { kind: string }) => x.kind === "recommendation_rejected");
    expect(n.body).toContain("No card was created and no spend can happen");
  });
});
