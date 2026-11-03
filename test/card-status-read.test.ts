import { describe, it, expect } from "vitest";
import { createConsoleApi, demoCases } from "../src/console/api.js";
import { makeSim } from "../src/sim/simGateway.js";
import { LiveIssuingGateway } from "../src/gateway/live.js";
import { AirwallexClient } from "../src/gateway/airwallex.js";

async function setup() {
  const gateway = makeSim(), api = createConsoleApi({ seedCases: demoCases(), gateway });
  const post = (p: string, b: unknown) => api(new Request(`http://localhost/api/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const { approval } = await (await post("approve", { caseId: "case_acme" })).json();
  const { card } = await (await post("create-card", { approval })).json();
  const view = async () => (await (await api(new Request("http://localhost/api/cases"))).json()).cases.find((c: any) => c.kase.id === "case_acme");
  return { gateway, card, view };
}
describe("read-only provider card status refresh", () => {
  it("reflects an external freeze without purchase or provider mutation", async () => {
    const { gateway, card, view } = await setup();
    expect((await view()).card.status).toBe("ACTIVE");
    gateway.freezeCard(card.id);
    const c = await view();
    expect(c.card.status).toBe("FROZEN");
    expect(c.cardStatusRead.state).toBe("ok");
    expect(c.cardStatusRead.checkedAt).toBeTruthy();
    expect(c.transactions).toEqual([]);
  });
  it("reflects external permanent closure", async () => {
    const { gateway, card, view } = await setup();
    gateway.closeCard(card.id);
    expect((await view()).card.status).toBe("CLOSED");
  });
  it.each(["throw", "missing", "unrecognized"])("marks %s status as unknown, never claims current ACTIVE", async (mode) => {
    const { gateway, view } = await setup();
    gateway.readCardStatus = () => { if (mode === "throw") throw new Error("provider outage"); return (mode === "missing" ? undefined : "NEW_STATE") as any; };
    const c = await view();
    expect(c.cardStatusRead.state).toBe("unknown");
    expect(c.cardStatusRead.error).toContain("not current evidence");
  });
  it("does not silently trust an old gateway with no status reader", async () => {
    const { gateway, view } = await setup();
    delete (gateway as any).readCardStatus;
    expect((await view()).cardStatusRead.state).toBe("unknown");
  });
  it.each([["ACTIVE", "ACTIVE"], ["INACTIVE", "FROZEN"], ["CLOSED", "CLOSED"], ["SUSPENDED", undefined]])("provider %s maps to %s without guessing", async (status, expected) => {
    const client = new AirwallexClient({ clientId: "", apiKey: "", bearerToken: "test", fetchImpl: (async () => new Response(JSON.stringify({ card_status: status }))) as any });
    expect(await new LiveIssuingGateway(client).readCardStatus("card_1")).toBe(expected);
  });
});
