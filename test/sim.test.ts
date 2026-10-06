import { describe, it, expect } from "vitest";
import { DECLINE, makeSim } from "../src/sim/simGateway.js";
import type { AuthorizationRequest } from "../src/domain/types.js";

const setup = (walletBalance = 1_000) => {
  const sim = makeSim({ walletBalance });
  const holder = sim.createCardholder({ name: "Sandi Samantaray", email: "sandi@example.com" });
  const card = sim.createCard({ cardholderId: holder.id, controls: { amountLimit: 100, currencyAllowlist: ["USD"], merchantCategories: ["software"] } });
  return { sim, holder, card };
};
const buy = (over: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({ amount: 75, currency: "USD", merchant: "Acme SaaS", category: "software", ...over });

describe("simulated issuing gateway", () => {
  it("clears an authorization inside the approved intent", () => {
    const { sim, card } = setup();
    const t = sim.authorize(card.id, buy());
    expect(t.status).toBe("PENDING");
    expect(sim.capture(t.id).status).toBe("CLEARING"); // CLEARING is accepted; no APPROVED exists
    expect(sim.walletBalance()).toBe(925);
  });

  it("declines above the approved cap, with the policy-matching reason", () => {
    const { sim, card } = setup();
    const t = sim.authorize(card.id, buy({ amount: 101 }));
    expect(t.status).toBe("FAILED");
    expect(t.failureReason).toBe(DECLINE.ABOVE_CAP);
  });

  it("treats the per-transaction limit as inclusive, then reaches the funding check", () => {
    const { sim, card } = setup(100);
    const t = sim.authorize(card.id, buy({ amount: 100 }));
    expect(t.status).toBe("PENDING"); // equal to the limit: controls pass
    const { sim: sim2, card: card2 } = setup(50);
    const t2 = sim2.authorize(card2.id, buy({ amount: 100 })); // controls pass, funding fails
    expect(t2.status).toBe("FAILED");
    expect(t2.failureReason).toBe(DECLINE.FUNDS);
  });

  it("declines an off-allowlist currency and category", () => {
    const { sim, card } = setup();
    expect(sim.authorize(card.id, buy({ currency: "GBP" })).failureReason).toBe(DECLINE.CURRENCY);
    expect(sim.authorize(card.id, buy({ category: "travel" })).failureReason).toBe(DECLINE.CATEGORY);
  });

  it("declines everything once the card is frozen", () => {
    const { sim, card } = setup();
    sim.freezeCard(card.id);
    expect(sim.authorize(card.id, buy()).failureReason).toBe(DECLINE.FROZEN);
  });

  it("keeps the card state machine: capture, reverse, refund, and no illegal moves", () => {
    const { sim, card } = setup();
    const t = sim.authorize(card.id, buy());
    expect(() => sim.reverse(t.id)).toThrow(/illegal/); // still PENDING
    sim.capture(t.id);
    expect(sim.reverse(t.id).status).toBe("REVERSED");
    expect(sim.walletBalance()).toBe(1_000);
    const t2 = sim.authorize(card.id, buy({ amount: 10 }));
    sim.capture(t2.id);
    expect(sim.refund(t2.id).status).toBe("REFUNDED");
    expect(() => sim.capture(t2.id)).toThrow(/illegal/);
  });

  it("deduplicates a retried request_id instead of creating a second financial action", () => {
    const { sim, card } = setup();
    const a = sim.authorize(card.id, buy(), "rid-1");
    const b = sim.authorize(card.id, buy(), "rid-1");
    expect(b.id).toBe(a.id);
    expect(sim.walletBalance()).toBe(925); // charged once
  });

  it("fails closed on a non-positive or non-finite amount", () => {
    const { sim, card } = setup();
    expect(sim.authorize(card.id, buy({ amount: 0 })).failureReason).toBe(DECLINE.ABOVE_CAP);
    expect(sim.authorize(card.id, buy({ amount: NaN })).failureReason).toBe(DECLINE.ABOVE_CAP);
  });
});
