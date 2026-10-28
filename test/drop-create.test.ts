import { describe, it, expect } from "vitest";
import { DropCreateResponseGateway } from "../src/gateway/drop-create.js";
import { makeSim } from "../src/sim/simGateway.js";

const req = { cardholderId: "", controls: { amountLimit: 100, currencyAllowlist: ["USD"], merchantCategories: ["software"] } };
const withHolder = async (g: ReturnType<typeof makeSim> | DropCreateResponseGateway) => {
  const r = await g.createCardholder({ name: "Case Seven", email: "case7@example.com" }, "h1");
  if (r.state === "unknown") throw new Error(r.error);
  return { ...req, cardholderId: r.cardholder.id };
};

describe("DropCreateResponseGateway (case-7 drill seam)", () => {
  it("discards exactly one successful create response as an unknown outcome, then passes through", async () => {
    const inner = makeSim();
    const g = new DropCreateResponseGateway(inner);
    expect(g.spent).toBe(false);
    const withId = await withHolder(g);
    // First create: the inner gateway really creates the card, the wrapper discards the response.
    await expect(g.createCard(withId, "r1")).rejects.toThrow(/response lost after the provider call/);
    expect(g.spent).toBe(true);
    // The card really exists provider-side - the honest recovery path (listing) finds it.
    const listed = await g.listCards(withId.cardholderId);
    expect(listed).toHaveLength(1);
    expect(listed[0].controls.amountLimit).toBe(100);
    // Second create passes through untouched.
    const second = await g.createCard(withId, "r2");
    expect(second.id).toBeTruthy();
  });

  it("a genuine provider failure on the armed call is rethrown as-is and still disarms", async () => {
    const inner = makeSim();
    inner.createCard = () => Promise.reject(new Error("provider 500")) as never;
    const g = new DropCreateResponseGateway(inner);
    await expect(g.createCard({ ...req, cardholderId: "any" }, "r1")).rejects.toThrow("provider 500");
    expect(g.spent).toBe(true);
  });

  it("delegates every other method and the absence-authority flag untouched", async () => {
    const inner = makeSim();
    const g = new DropCreateResponseGateway(inner);
    expect(g.supportsAuthoritativeAbsence).toBe(inner.supportsAuthoritativeAbsence);
    const holder = await g.createCardholder({ name: "A", email: "a@b.c" }, "h1");
    expect(holder.state).toBe("created");
    expect(await g.listTransactions()).toEqual([]);
  });
});
