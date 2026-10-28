/** Round-5 independent verification, snapshot 47814c5. Adversarial follow-ups to the N5/N3 fixes. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivateIp } from "../src/net/ssrf.js";
import { LiveIssuingGateway } from "../src/gateway/live.js";
import { createConsoleApi } from "../src/console/api.js";
import { makeSim, type IssuingGateway } from "../src/sim/simGateway.js";

const post = (api: any, p: string, b: unknown) =>
  api(new Request(`http://x${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
const approve = async (api: any, c: string) => (await (await post(api, "/api/approve", { caseId: c })).json() as any).approval;
const mkApi = (gw: IssuingGateway) => {
  const dir = mkdtempSync(join(tmpdir(), "r5-"));
  return createConsoleApi({ gateway: gw, stateFile: join(dir, "s.json") });
};
const lockViaLostCreate = async (gw: IssuingGateway) => { // cardholder committed remotely, response lost
  const api = mkApi(gw);
  const a = await approve(api, "case_acme");
  await post(api, "/api/create-card", { approval: a }); // errors -> cardholder-ambiguous lock
  return api;
};

describe("N5 fix: tri-state cardholder lookup", () => {
  it("live findCardholderByEmail: provider error -> state 'unknown' (never 'absent')", async () => {
    const client = { listCardholders: async () => { throw new Error("HTTP 500 provider meltdown"); } };
    const gw = new LiveIssuingGateway(client as never);
    const r = await gw.findCardholderByEmail("sandi@vyayasan.com");
    expect(r.state).toBe("unknown");
    expect((r as any).error).toContain("500");
  });
  it("live createCardholder: lookup error -> 'unknown', and NO create POST is issued", async () => {
    let creates = 0;
    const client = {
      listCardholders: async () => { throw new Error("HTTP 503 transient"); },
      createCardholder: async () => { creates++; return { cardholder_id: "ch_dup" }; },
    };
    const gw = new LiveIssuingGateway(client as never);
    const r = await gw.createCardholder({ name: "Sandi Samantaray", email: "sandi@vyayasan.com" }, "rid");
    expect(r.state).toBe("unknown");
    expect(creates, "a failed lookup must never become a create").toBe(0);
  });
  it("live createCardholder: successful EMPTY lookup -> creates exactly one (positive control)", async () => {
    let creates = 0;
    const client = {
      listCardholders: async () => ({ items: [] }),
      createCardholder: async () => { creates++; return { cardholder_id: "ch_1" }; },
    };
    const gw = new LiveIssuingGateway(client as never);
    const r = await gw.createCardholder({ name: "Sandi Samantaray", email: "sandi@vyayasan.com" }, "rid");
    expect(r.state).toBe("created");
    expect(creates).toBe(1);
  });
  it("e2e: lookup 'unknown' keeps the lock - none-created + attestation stays 409, no duplicate", async () => {
    const sim = makeSim();
    const gw: IssuingGateway = {
      ...sim,
      createCardholder: async (req, rid) => { await sim.createCardholder(req, rid); throw new Error("committed then lost"); },
      findCardholderByEmail: async () => ({ state: "unknown", error: "HTTP 500" }),
    };
    const api = await lockViaLostCreate(gw);
    const unlock = await post(api, "/api/reconcile-card", { caseId: "case_acme", decision: "none-created", attestation: "I checked the provider dashboard" });
    expect(unlock.status, "unknown lookup must keep the lock").toBe(409);
    expect(((await unlock.json()) as any).error).toMatch(/error is not proof of absence/i);
    // lock still stands: approve and create-card stay refused
    expect((await post(api, "/api/approve", { caseId: "case_acme" })).status).toBe(409);
  });
  it("e2e: a THROWING findCardholderByEmail is also 'unknown', not 'absent'", async () => {
    const sim = makeSim();
    const gw: IssuingGateway = {
      ...sim,
      createCardholder: async (req, rid) => { await sim.createCardholder(req, rid); throw new Error("committed then lost"); },
      findCardholderByEmail: async () => { throw new Error("network reset"); },
    };
    const api = await lockViaLostCreate(gw);
    const unlock = await post(api, "/api/reconcile-card", { caseId: "case_acme", decision: "none-created", attestation: "I checked the provider dashboard" });
    expect(unlock.status).toBe(409);
    expect(((await unlock.json()) as any).error).toMatch(/error is not proof of absence/i);
  });
  it("e2e: gateway returning 'unknown' from createCardholder -> 409 + persisted lock, approve refused", async () => {
    const sim = makeSim();
    const gw: IssuingGateway = { ...sim, createCardholder: async () => ({ state: "unknown", error: "HTTP 503" }) };
    const api = mkApi(gw);
    const a = await approve(api, "case_acme");
    const res = await post(api, "/api/create-card", { approval: a });
    expect(res.status).toBe(409);
    expect((await post(api, "/api/approve", { caseId: "case_acme" })).status).toBe(409);
    expect((await post(api, "/api/create-card", { approval: a })).status).toBe(409);
  });
});

describe("N3 residual fix: none-created disabled without authoritative absence", () => {
  const lockAndAttest = async (gw: IssuingGateway) => {
    const api = await lockViaLostCreate(gw);
    return post(api, "/api/reconcile-card", { caseId: "case_acme", decision: "none-created", attestation: "I checked the provider dashboard" });
  };
  it("gateway WITHOUT supportsAuthoritativeAbsence: none-created refused even with attestation + empty listing", async () => {
    const sim = makeSim();
    const gw: IssuingGateway = {
      ...sim, supportsAuthoritativeAbsence: false, // live-shaped
      createCardholder: async (req, rid) => { await sim.createCardholder(req, rid); throw new Error("committed then lost"); },
    };
    const unlock = await lockAndAttest(gw);
    expect(unlock.status).toBe(409);
    expect(((await unlock.json()) as any).error).toMatch(/not authoritative/i);
  });
  it("real LiveIssuingGateway advertises supportsAuthoritativeAbsence === false", () => {
    const gw = new LiveIssuingGateway({} as never);
    expect(gw.supportsAuthoritativeAbsence).toBe(false);
  });
  it("sim (strong consistency) still unlocks with attestation + double empty read (positive path intact)", async () => {
    const sim = makeSim();
    const gw: IssuingGateway = {
      ...sim,
      createCardholder: async (req, rid) => { await sim.createCardholder(req, rid); throw new Error("committed then lost"); },
    };
    const unlock = await lockAndAttest(gw);
    expect(unlock.status, "sim is authoritative; attested none-created must still work").toBe(200);
  });
  it("verified-absent cardholder short-circuits listing: adopt of any cardId refuses (fail-closed)", async () => {
    const sim = makeSim();
    let listCalls = 0;
    const gw: IssuingGateway = {
      ...sim,
      createCardholder: async (req, rid) => { await sim.createCardholder(req, rid); throw new Error("committed then lost"); },
      findCardholderByEmail: async () => ({ state: "absent" }),
      listCards: async (h) => { listCalls++; return sim.listCards(h); },
    };
    const api = await lockViaLostCreate(gw);
    const adopt = await post(api, "/api/reconcile-card", { caseId: "case_acme", decision: "adopt", cardId: "card_phantom" });
    expect(adopt.status).toBe(409); // a phantom card can never be adopted
    expect(listCalls, "no cardholder => listing short-circuits to empty (documented behavior)").toBe(0);
  });
});

describe("N4 dotted-tail fix regression", () => {
  it("compressed dotted-tail NAT64 public is public; private stays private; malformed fails closed", () => {
    expect(isPrivateIp("64:ff9b::8.8.8.8")).toBe(false);
    expect(isPrivateIp("64:ff9b::10.1.1.1")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIp("2002:808:808::")).toBe(false);
    expect(isPrivateIp("2002:7f00:1::")).toBe(true);
    expect(isPrivateIp("64:ff9b::8.8.8.256")).toBe(true);
    expect(isPrivateIp("::ffff:999.1.1.1")).toBe(true);
    expect(isPrivateIp("64:ff9b:::8.8.8.8")).toBe(true);
  });
});
