import { describe, it, expect } from "vitest";
import { makeSim } from "../../src/sim/simGateway.js";
import { createConsoleApi } from "../../src/console/api.js";
import { AuditLog } from "../../src/audit/audit.js";

// Round two of the red team: the controls themselves. Every attack here targets the
// card controls, the idempotency store, or the approval checkpoint rather than the model.

const NOW = new Date("2026-10-06T09:00:00Z");
const cardOn = (sim: ReturnType<typeof makeSim>, limit = 100) => {
  const h = sim.createCardholder({ name: "A", email: "a@example.com" }, "h1");
  return sim.createCard({ cardholderId: h.id, controls: { amountLimit: limit, currencyAllowlist: ["USD"], merchantCategories: ["software"] } }, "c1");
};
const buy = { amount: 75, currency: "USD", merchant: "Acme", category: "software" };

describe("redteam: control-plane attacks", () => {
  it("idempotency aliasing: the same request id with a different payload returns the first result", () => {
    // Documented behaviour, inherited from the disputes red team: the idempotency key is the
    // request id alone. A caller that reuses an id for a different purchase gets the first
    // purchase back and no second charge. One request id per logical action is the contract.
    const sim = makeSim({ walletBalance: 1000 });
    const card = cardOn(sim);
    const t1 = sim.authorize(card.id, buy, "req-shared");
    const t2 = sim.authorize(card.id, { ...buy, amount: 99 }, "req-shared");
    expect(t2.id).toBe(t1.id);
    expect(t2.amount).toBe(75); // the first payload won
    expect(sim.walletBalance()).toBe(925); // charged once
  });

  it("freeze blocks new authorizations but does not strand an in-flight one: capture still settles", () => {
    // Documented behaviour: freezing is a control on NEW spend. A purchase already authorized
    // before the freeze can still be captured, matching how card networks treat settlement.
    const sim = makeSim({ walletBalance: 1000 });
    const card = cardOn(sim);
    const t = sim.authorize(card.id, buy, "req-1");
    sim.freezeCard(card.id, "frz-1");
    expect(sim.authorize(card.id, buy, "req-2").failureReason).toBe("card_frozen");
    expect(sim.capture(t.id, "cap-1").status).toBe("CLEARING");
  });

  it("freeze/unfreeze race: controls re-apply on every authorization, nothing is cached", () => {
    const sim = makeSim({ walletBalance: 1000 });
    const card = cardOn(sim);
    sim.freezeCard(card.id, "frz-1");
    expect(sim.authorize(card.id, buy, "req-1").status).toBe("FAILED");
    sim.unfreezeCard(card.id, "unf-1");
    expect(sim.authorize(card.id, buy, "req-2").status).toBe("PENDING");
    sim.freezeCard(card.id, "frz-2");
    expect(sim.authorize(card.id, buy, "req-3").failureReason).toBe("card_frozen");
  });

  it("a charge with no merchant category is declined, never silently matched", () => {
    const sim = makeSim({ walletBalance: 1000 });
    const card = cardOn(sim);
    const t = sim.authorize(card.id, { ...buy, category: "" }, "req-1");
    expect(t.status).toBe("FAILED");
    expect(t.failureReason).toBe("category_not_allowed");
    expect(sim.walletBalance()).toBe(1000);
  });

  it("approving an escalated case is refused: the human checkpoint cannot be skipped", async () => {
    // Pulsar Ads has no annual price, so policy escalates. Hitting approve anyway must 409:
    // a person has to resolve the escalation first, there is no force-approve path.
    const audit = new AuditLog(undefined, () => NOW);
    const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"] });
    const r = await api(new Request("http://localhost:3000/api/approve", {
      method: "POST",
      headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" },
      body: JSON.stringify({ caseId: "case_pulsar" }),
    }));
    expect(r.status).toBe(409);
    const d = await r.json();
    expect(d.error).toMatch(/escalat/i);
  });
});
