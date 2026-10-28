import { describe, it, expect, vi } from "vitest";
import { createConsoleApi, demoCases } from "../src/console/api.js";
import { makeSim } from "../src/sim/simGateway.js";
function setup() {
  const seed = demoCases(), gateway = makeSim(), api = createConsoleApi({ seedCases: seed, gateway });
  const post = (path: string, body: unknown) => api(new Request(`http://localhost:3000/api/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const change = () => post("change-terms", { caseId: "case_acme", terms: { ...seed[0].kase.terms!, monthlyPrice: 90 }, rawTerms: "New deal: 90 USD per month, 984 annually. Software. 30 days notice." });
  return { seed, gateway, post, change };
}
describe("deal change lifecycle (simulator, not live rail proof)", () => {
  it("refuses actual changed terms even when retained intent was not edited", async () => {
    const { seed, post } = setup();
    const { approval } = await (await post("approve", { caseId: "case_acme" })).json();
    seed[0].kase.terms!.monthlyPrice = 90;
    expect((await post("create-card", { approval })).status).toBe(409);
  });
  it("freezes the old card, rejects stale approval and creates a fresh approved replacement", async () => {
    const { post, change } = setup();
    const { approval } = await (await post("approve", { caseId: "case_acme" })).json();
    const { card } = await (await post("create-card", { approval })).json();
    expect((await post("approve", { caseId: "case_acme" })).status).toBe(409);
    expect((await change()).status).toBe(200);
    const decline = await (await post("simulate", { caseId: "case_acme", kind: "in-policy" })).json();
    expect(decline.transaction.failureReason).toBe("card_frozen");
    expect(decline.transaction.amount).toBe(100);
    expect((await post("create-card", { approval })).status).toBe(409);
    const fresh = await (await post("approve", { caseId: "case_acme" })).json();
    expect(fresh.approval.amountCap).toBe(90);
    const replacement = await (await post("create-card", { approval: fresh.approval })).json();
    expect(replacement.card.id).not.toBe(card.id);
    const pass = await (await post("simulate", { caseId: "case_acme", kind: "in-policy" })).json();
    expect(pass.transaction.status).toBe("CLEARING");
  });
  it("does not advance terms after an unknown remote freeze outcome", async () => {
    const { seed, gateway, post, change } = setup();
    const { approval } = await (await post("approve", { caseId: "case_acme" })).json();
    await post("create-card", { approval });
    vi.spyOn(gateway, "freezeCard").mockImplementation(() => { throw new Error("timeout"); });
    expect((await change()).status).toBe(409);
    expect(seed[0].kase.terms!.monthlyPrice).toBe(100);
    expect(seed[0].requiresReapproval).toBe(true);
    expect(seed[0].freezeState).toBe("unknown");
    expect((await post("approve", { caseId: "case_acme" })).status).toBe(409);
    expect((await post("create-card", { approval })).status).toBe(409);
  });
  it("serializes simultaneous issuance to create only one card", async () => {
    const { gateway, post } = setup(), create = vi.spyOn(gateway, "createCard");
    const { approval } = await (await post("approve", { caseId: "case_acme" })).json();
    const results = await Promise.all([post("create-card", { approval }), post("create-card", { approval })]);
    expect(results.map(r => r.status)).toEqual([200, 409]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
describe("terms change that removes the annual option (simulator)", () => {
  it("freezes the old card, marks annual not offered, escalates the decision and blocks re-approval", async () => {
    const { seed, post } = setup();
    const { approval } = await (await post("approve", { caseId: "case_acme" })).json();
    await post("create-card", { approval });
    const noAnnual = { ...seed[0].kase.terms!, monthlyPrice: 90, annualPrice: null };
    const changed = await (await post("change-terms", { caseId: "case_acme", terms: noAnnual, rawTerms: "Acme repriced to 90 USD/month; annual plan withdrawn." })).json();
    expect(changed.case.freezeState).toBe("verified");
    expect(changed.case.requiresReapproval).toBe(true);
    expect(changed.case.decision.cadence).toBe("ESCALATE");
    expect(changed.case.decision.reasons.join(" ")).toMatch(/missing a monthly or annual price/);
    expect(changed.case.decision.savingsPct).toBeNull();
    expect(changed.case.decision.annualBreachWeek).toBeNull();
    const decline = await (await post("simulate", { caseId: "case_acme", kind: "in-policy" })).json();
    expect(decline.transaction.failureReason).toBe("card_frozen");
    const reapprove = await post("approve", { caseId: "case_acme" });
    expect(reapprove.status).toBe(409);
    expect(((await reapprove.json()).error)).toMatch(/escalat/i);
  });
});
