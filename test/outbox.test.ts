import { describe, it, expect } from "vitest";
import { Outbox } from "../src/notify/outbox.js";

const NOW = new Date("2026-10-27T01:00:00Z");
const base = { caseId: "case_acme", vendor: "Acme Analytics", recipient: "sandi@vyayasan.com" };

describe("notification outbox (preview only, never sends)", () => {
  it("renders deterministic subjects and bodies per kind", () => {
    const o = new Outbox(() => NOW);
    const r = o.emit("approval_issued", { ...base, detail: { approver: "sandi", cadence: "monthly", cap: 100, currency: "USD", categories: "software", termsHash: "abc123" } });
    expect(r.subject).toBe("Intent approved: Acme Analytics (monthly, cap 100 USD)");
    expect(r.body).toContain("approved through the authenticated approver session sandi");
    expect(r.body).toContain("Terms hash: abc123");
    expect(r.status).toBe("preview");
    expect(r.to).toBe("sandi@vyayasan.com");
    const again = o.emit("approval_issued", { ...base, detail: { approver: "sandi", cadence: "monthly", cap: 100, currency: "USD", categories: "software", termsHash: "abc123" } });
    expect(again.sha256).toBe(r.sha256); // content hash deterministic (integrity field)
    expect(again.id).not.toBe(r.id); // but identical REAL events never collapse onto one id
  });

  it("covers every workflow kind and never marks a record sent", () => {
    const o = new Outbox(() => NOW);
    const kinds = ["approval_issued", "card_created", "deal_changed_frozen", "reapproval_required", "purchase_cleared", "purchase_declined", "gateway_outage"] as const;
    for (const kind of kinds) {
      const r = o.emit(kind, { ...base, detail: { approver: "sandi", cadence: "monthly", cap: 100, currency: "USD", categories: "software", termsHash: "h", limit: 100, currencies: "USD", freezeState: "INACTIVE", newTerms: "x", amount: 100, reason: "above_approved_cap", error: "HTTP 500" } });
      expect(r.subject.length).toBeGreaterThan(0);
      expect(r.body.length).toBeGreaterThan(0);
      expect(r.status).toBe("preview");
    }
    expect(o.list()).toHaveLength(7);
    expect(o.list("case_acme")).toHaveLength(7);
    expect(o.list("case_other")).toHaveLength(0);
  });

  it("gateway outage wording demands reconciliation and claims nothing about the ledger", () => {
    const o = new Outbox(() => NOW);
    const r = o.emit("gateway_outage", { ...base, detail: { error: "HTTP 503" } });
    expect(r.body).toContain("outcome is unknown");
    expect(r.body).toContain("Reconcile");
    expect(r.body).not.toContain("No transaction was recorded");
  });
});
