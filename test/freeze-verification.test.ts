import {it,expect,vi} from "vitest";
import {LiveIssuingGateway} from "../src/gateway/live.js";
import type {AirwallexClient} from "../src/gateway/airwallex.js";
for (const read of [{card_id:"c",card_status:"ACTIVE"},{card_id:"other",card_status:"INACTIVE"},{}]) {
 it(`refuses unverified freeze ${JSON.stringify(read)}`,async()=>{
  const client={updateCard:vi.fn(async()=>({})),call:vi.fn(async()=>read)};
  await expect(new LiveIssuingGateway(client as unknown as AirwallexClient).freezeCard("c")).rejects.toThrow("freeze read-back not confirmed");
 });
}
it("marks frozen only after independent card read confirms id and status",async()=>{
 const client={updateCard:vi.fn(async()=>({})),call:vi.fn(async()=>({card_id:"c",card_status:"INACTIVE"}))};
 expect((await new LiveIssuingGateway(client as unknown as AirwallexClient).freezeCard("c")).status).toBe("FROZEN");
 expect(client.call).toHaveBeenCalledWith("GET","/api/v1/issuing/cards/c");
});
