import { describe, it, expect, vi } from "vitest";
import { createConsoleApi, demoCases } from "../src/console/api.js";
import { makeSim, DECLINE } from "../src/sim/simGateway.js";
import { LiveIssuingGateway } from "../src/gateway/live.js";
import type { AirwallexClient } from "../src/gateway/airwallex.js";

function setup() {
  const seed = demoCases(), gateway = makeSim(), api = createConsoleApi({ seedCases: seed, gateway });
  const post = (path: string, body: unknown) => api(new Request(`http://localhost:3000/api/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const approvedCard = async () => {
    const { approval } = await (await post("approve", { caseId: "case_acme" })).json();
    const { card } = await (await post("create-card", { approval })).json();
    return card;
  };
  return { seed, gateway, post, approvedCard };
}

describe("permanent card close (simulator, not live rail proof)", () => {
  it("refuses to close a card that was never created", async () => {
    const { post } = setup();
    expect((await post("close-card", { caseId: "case_acme" })).status).toBe(409);
  });
  it("refuses to close an ACTIVE card - freeze must come first", async () => {
    const { post, approvedCard } = setup();
    await approvedCard();
    const res = await post("close-card", { caseId: "case_acme" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/freeze/i);
  });
  it("closes a frozen card: status CLOSED, audited, and authorizations decline as card_closed", async () => {
    const { post, approvedCard } = setup();
    await approvedCard();
    expect((await post("freeze", { caseId: "case_acme" })).status).toBe(200);
    const res = await post("close-card", { caseId: "case_acme" });
    expect(res.status).toBe(200);
    expect((await res.json()).card.status).toBe("CLOSED");
    const decline = await (await post("simulate", { caseId: "case_acme", kind: "in-policy" })).json();
    expect(decline.transaction.failureReason).toBe(DECLINE.CLOSED);
  });
  it("keeps the card closed on provider error - outcome unknown, no silent state change", async () => {
    const { seed, gateway, post, approvedCard } = setup();
    const card = await approvedCard();
    await post("freeze", { caseId: "case_acme" });
    vi.spyOn(gateway, "closeCard").mockImplementation(() => { throw new Error("timeout"); });
    expect((await post("close-card", { caseId: "case_acme" })).status).toBe(409);
    expect(seed[0].card!.status).toBe("FROZEN");
    void card;
  });
});

describe("live gateway close read-back discipline", () => {
  for (const read of [{ card_id: "c", card_status: "INACTIVE" }, { card_id: "other", card_status: "CLOSED" }, {}]) {
    it(`refuses unverified close ${JSON.stringify(read)}`, async () => {
      const client = { updateCard: vi.fn(async () => ({})), call: vi.fn(async () => read) };
      await expect(new LiveIssuingGateway(client as unknown as AirwallexClient).closeCard("c")).rejects.toThrow("close read-back not confirmed");
    });
  }
  it("marks closed only after independent card read confirms id and CLOSED status", async () => {
    const client = { updateCard: vi.fn(async () => ({})), call: vi.fn(async () => ({ card_id: "c", card_status: "CLOSED" })) };
    const g = new LiveIssuingGateway(client as unknown as AirwallexClient);
    expect((await g.closeCard("c")).status).toBe("CLOSED");
    expect(client.updateCard).toHaveBeenCalledWith("c", { card_status: "CLOSED" }, undefined);
    expect(client.call).toHaveBeenCalledWith("GET", "/api/v1/issuing/cards/c");
  });
});

describe("ladder after close (simulator)", () => {
  it("allows a fresh approval on a closed-card case and issues a replacement card", async () => {
    const { post, approvedCard } = setup();
    const old = await approvedCard();
    await post("freeze", { caseId: "case_acme" });
    expect((await post("close-card", { caseId: "case_acme" })).status).toBe(200);
    const fresh = await post("approve", { caseId: "case_acme" });
    expect(fresh.status).toBe(200);
    const { approval } = await fresh.json();
    const replacement = await post("create-card", { approval });
    expect(replacement.status).toBe(200);
    const { card } = await replacement.json();
    expect(card.id).not.toBe(old.id);
    expect(card.status).toBe("ACTIVE");
  });
  it("still refuses re-approval over a FROZEN card without a terms change", async () => {
    const { post, approvedCard } = setup();
    await approvedCard();
    await post("freeze", { caseId: "case_acme" });
    expect((await post("approve", { caseId: "case_acme" })).status).toBe(409);
  });
});

describe("terminal-state invariant (simulator)", () => {
  it("sim freeze/unfreeze refuse a CLOSED card - it cannot be resurrected", async () => {
    const { gateway, post, approvedCard } = setup();
    const card = await approvedCard();
    await post("freeze", { caseId: "case_acme" });
    await post("close-card", { caseId: "case_acme" });
    expect(() => gateway.freezeCard(card.id)).toThrow(/closed \(terminal\)/);
    expect(() => gateway.unfreezeCard(card.id)).toThrow(/closed \(terminal\)/);
  });
  it("change-terms on a closed-card case never touches the terminal card and keeps it CLOSED", async () => {
    const { seed, gateway, post, approvedCard } = setup();
    await approvedCard();
    await post("freeze", { caseId: "case_acme" });
    await post("close-card", { caseId: "case_acme" });
    const freeze = vi.spyOn(gateway, "freezeCard");
    const res = await post("change-terms", { caseId: "case_acme", terms: { ...seed[0].kase.terms!, monthlyPrice: 90 }, rawTerms: "New deal: 90 USD per month, 972 annually. Software. 30 days notice." });
    expect(res.status).toBe(200);
    expect(freeze).not.toHaveBeenCalled();
    expect(seed[0].card!.status).toBe("CLOSED");
    expect(seed[0].requiresReapproval).toBe(true);
    expect(seed[0].freezeState).toBe("verified");
  });
});
