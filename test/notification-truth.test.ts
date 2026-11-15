import { describe, it, expect } from "vitest";
import { createConsoleApi, demoCases } from "../src/console/api.js";
import { makeSim } from "../src/sim/simGateway.js";
import { Outbox } from "../src/notify/outbox.js";

function setup() {
  const seed = demoCases(), gateway = makeSim(), api = createConsoleApi({ seedCases: seed, gateway });
  const post = (path: string, body: unknown) => api(new Request(`http://localhost:3000/api/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const approvedCard = async () => {
    const { approval } = await (await post("approve", { caseId: "case_acme" })).json();
    const { card } = await (await post("create-card", { approval })).json();
    return { approval, card };
  };
  const change = () => post("change-terms", { caseId: "case_acme", terms: { ...seed[0].kase.terms!, monthlyPrice: 90 }, rawTerms: "New deal: 90 USD per month, 984 annually. Software. 30 days notice." });
  const notes = async (kind: string) => {
    const d = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    return d.notifications.filter((n: { kind: string }) => n.kind === kind);
  };
  return { seed, gateway, post, approvedCard, change, notes };
}

describe("notification wording matches the real case state", () => {
  it("reject with a live card is refused - 'no spend can happen' must stay true", async () => {
    const { post, approvedCard } = setup();
    await approvedCard();
    const r = await post("reject", { caseId: "case_acme", reason: "not in budget" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/close it before rejecting/);
  });
  it("reject after a permanent close succeeds and the notification wording holds", async () => {
    const { post, approvedCard, notes } = setup();
    await approvedCard();
    await post("freeze", { caseId: "case_acme" });
    expect((await post("close-card", { caseId: "case_acme" })).status).toBe(200);
    expect((await post("reject", { caseId: "case_acme", reason: "not in budget" })).status).toBe(200);
    const [n] = await notes("recommendation_rejected");
    expect(n.subject).toBe("[TEST] Case rejected: Acme Analytics"); // a card WAS created (then closed): no false "no card was created" claim
    expect(n.body).toContain("permanently closed - it can never transact again");
    expect(n.body).not.toContain("No card was created");
    expect(n.html).toContain("Permanently closed");
  });
  it("reapproval_required (no-card branch) never claims a frozen card", async () => {
    const { post, change, notes } = setup();
    await post("approve", { caseId: "case_acme" }); // approval but NO card
    expect((await change()).status).toBe(200);
    const [n] = await notes("reapproval_required");
    expect(n.body).toContain("No card exists on this case");
    expect(n.body).not.toContain("stays frozen");
    expect(n.html).toContain("No card exists on this case");
    expect(n.html).not.toContain("stays frozen");
  });
  it("deal_changed_frozen on a closed card says permanently closed, never frozen", async () => {
    const { post, approvedCard, change, notes } = setup();
    await approvedCard();
    await post("freeze", { caseId: "case_acme" });
    expect((await post("close-card", { caseId: "case_acme" })).status).toBe(200);
    expect((await change()).status).toBe(200);
    const [n] = await notes("deal_changed_frozen");
    expect(n.subject).toBe("[TEST] Deal changed: Acme Analytics card permanently closed, approval invalidated");
    expect(n.body).toContain("permanently closed");
    expect(n.body).not.toContain("card was frozen");
    expect(n.html).toContain("Permanently closed");
    expect(n.html).not.toContain("CARD FROZEN");
  });
  it("deal_changed_frozen on a live card keeps freeze read-back wording", async () => {
    const { post, approvedCard, change, notes } = setup();
    await approvedCard();
    expect((await change()).status).toBe(200);
    const [n] = await notes("deal_changed_frozen");
    expect(n.subject).toBe("[TEST] Deal changed: Acme Analytics card frozen, approval invalidated");
    expect(n.body).toContain("card was frozen");
    expect(n.body).toContain("Freeze read-back: verified");
    expect(n.html).toContain("CARD FROZEN");
  });
  it("approval_issued note reflects the old card state: none / frozen / closed", async () => {
    // none
    const a = setup();
    await a.post("approve", { caseId: "case_acme" });
    const [n1] = await a.notes("approval_issued");
    expect(n1.html).toContain("no card exists yet");
    // frozen old card (re-approval after terms change)
    const b = setup();
    await b.approvedCard();
    await b.change();
    await b.post("approve", { caseId: "case_acme" });
    const bn = (await b.notes("approval_issued")).pop();
    expect(bn.html).toContain("old card stays frozen");
    // closed old card (replacement ladder)
    const c = setup();
    await c.approvedCard();
    await c.post("freeze", { caseId: "case_acme" });
    await c.post("close-card", { caseId: "case_acme" });
    await c.post("approve", { caseId: "case_acme" });
    const cn = (await c.notes("approval_issued")).pop();
    expect(cn.html).toContain("permanently closed");
    expect(cn.html).not.toContain("no card exists yet");
  });
  it("plain-text canonical bodies stay in sync with html for the changed kinds", () => {
    const o = new Outbox();
    const base = { caseId: "c", vendor: "Acme", recipient: "sandi@vyayasan.com" };
    const closed = o.emit("deal_changed_frozen", { ...base, detail: { freezeState: "verified", newTerms: "x", cardState: "closed" } });
    for (const phrase of ["permanently closed"]) { expect(closed.body).toContain(phrase); expect(closed.html).toContain(phrase); }
    const re = o.emit("reapproval_required", { ...base, detail: { newTerms: "x", cardState: "none" } });
    for (const phrase of ["No card exists on this case"]) { expect(re.body).toContain(phrase); expect(re.html).toContain(phrase); }
    const rj = o.emit("recommendation_rejected", { ...base, detail: { approver: "a", reason: "r", cardState: "closed" } });
    expect(rj.subject).toBe("Case rejected: Acme");
    for (const phrase of ["permanently closed"]) { expect(rj.body).toContain(phrase); expect(rj.html).toContain(phrase); }
    const rj0 = o.emit("recommendation_rejected", { ...base, detail: { approver: "a", reason: "r", cardState: "none" } });
    expect(rj0.subject).toBe("Case rejected: Acme - no card was created");
    expect(rj0.body).toContain("No card was created and no spend can happen on this case.");
  });
});
