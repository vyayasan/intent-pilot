import { describe, it, expect } from "vitest";
import { makeSim } from "../../src/sim/simGateway.js";

// Attacker's (and accident's) goal: make one logical action land as two financial actions,
// or move money through illegal state transitions. The gateway must be idempotent per
// request id and the state machine must refuse illegal moves.

const cardOn = (sim: ReturnType<typeof makeSim>, limit = 100) => {
  const h = sim.createCardholder({ name: "A", email: "a@example.com" }, "h1");
  return sim.createCard({ cardholderId: h.id, controls: { amountLimit: limit, currencyAllowlist: ["USD"], merchantCategories: ["software"] } }, "c1");
};
const buy = { amount: 75, currency: "USD", merchant: "Acme", category: "software" };

describe("redteam: gateway double-spend and state attacks", () => {
  it("a retried authorization with the same request id charges once", () => {
    const sim = makeSim({ walletBalance: 1000 });
    const card = cardOn(sim);
    const t1 = sim.authorize(card.id, buy, "req-1");
    const t2 = sim.authorize(card.id, buy, "req-1");
    expect(t2.id).toBe(t1.id);
    expect(sim.walletBalance()).toBe(925);
  });

  it("a retry with a different request id is a real second purchase", () => {
    const sim = makeSim({ walletBalance: 1000 });
    const card = cardOn(sim);
    sim.authorize(card.id, buy, "req-1");
    sim.authorize(card.id, buy, "req-2");
    expect(sim.walletBalance()).toBe(850);
  });

  it("retried card creation cannot mint a second card from one call", () => {
    const sim = makeSim();
    const h = sim.createCardholder({ name: "A", email: "a@example.com" }, "h1");
    const c1 = sim.createCard({ cardholderId: h.id, controls: { amountLimit: 100, currencyAllowlist: ["USD"], merchantCategories: ["software"] } }, "c1");
    const c2 = sim.createCard({ cardholderId: h.id, controls: { amountLimit: 100, currencyAllowlist: ["USD"], merchantCategories: ["software"] } }, "c1");
    expect(c2.id).toBe(c1.id);
  });

  it("capture, reverse and refund respect the state machine", () => {
    const sim = makeSim({ walletBalance: 1000 });
    const card = cardOn(sim);
    const t = sim.authorize(card.id, buy, "req-1");
    sim.capture(t.id, "cap-1");
    expect(() => sim.capture(t.id, "cap-2")).toThrow(/illegal/); // CLEARING -> CLEARING is not a move
    expect(sim.refund(t.id, "ref-1").status).toBe("REFUNDED");
    expect(sim.walletBalance()).toBe(1000); // money came back exactly once
    expect(() => sim.reverse(t.id, "rev-1")).toThrow(/illegal/);
  });

  it("a frozen card declines without touching the wallet", () => {
    const sim = makeSim({ walletBalance: 1000 });
    const card = cardOn(sim);
    sim.freezeCard(card.id, "frz-1");
    const t = sim.authorize(card.id, buy, "req-1");
    expect(t.status).toBe("FAILED");
    expect(t.failureReason).toBe("card_frozen");
    expect(sim.walletBalance()).toBe(1000);
  });

  it("wallet conservation: debits minus refunds equal the wallet delta across a mixed flow", () => {
    const sim = makeSim({ walletBalance: 1000 });
    const card = cardOn(sim, 200);
    const a = sim.authorize(card.id, buy, "a");
    sim.authorize(card.id, { ...buy, amount: 50 }, "b");
    sim.authorize(card.id, { ...buy, amount: 500 }, "c"); // declined: over cap
    sim.capture(a.id, "cap-a");
    sim.refund(a.id, "ref-a");
    expect(sim.walletBalance()).toBe(1000 - 50); // only purchase b stands
  });
});
