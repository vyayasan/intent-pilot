/** Round-4 independent verification, snapshot 648a2ed. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivateIp } from "../src/net/ssrf.js";
import { LiveIssuingGateway } from "../src/gateway/live.js";
import { createConsoleApi } from "../src/console/api.js";
import { makeSim, type IssuingGateway } from "../src/sim/simGateway.js";

describe("N4: structured IPv6 parser - adversarial forms", () => {
  const priv = ["64:ff9b:0:0:0:0:7f00:1", "64:ff9b:0000:0000:0000:0000:127.0.0.1", "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::", "2002:a9fe:a9fe::", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "::127.0.0.1",
    "fe80::1", "fd00::1", "::1", "::", "0:0:0:0:0:0:0:1"];
  const pub = ["2606:4700:4700::1111", "2001:4860:4860::8888", "8.8.8.8", "64:ff9b::8.8.8.8", "2002:808:808::"];
  it("private/embedded forms classify private", () => { for (const ip of priv) expect(isPrivateIp(ip), ip).toBe(true); });
  it("genuinely public forms stay public", () => { for (const ip of pub) expect(isPrivateIp(ip), ip).toBe(false); });
  it("malformed v6-shaped input fails CLOSED (private)", () => {
    expect(isPrivateIp("::g::")).toBe(true);
    expect(isPrivateIp("1:::2")).toBe(true);
    expect(isPrivateIp("zzzz::1")).toBe(true);
  });
});

describe("cardholder lookup: provider errors are confused with absence", () => {
  it("findCardholderByEmail swallows provider errors and reports ABSENT", async () => {
    const client = { listCardholders: async () => { throw new Error("HTTP 500 provider meltdown"); } };
    const gw = new LiveIssuingGateway(client as never);
    const found = await gw.findCardholderByEmail!("sandi@vyayasan.com");
    expect(found, "a provider ERROR became 'no cardholder' - the unlock path downstream treats this as proof of absence").not.toBeUndefined();
  });
  it("createCardholder swallows lookup errors and CREATES (duplicate on transient failure)", async () => {
    let created = 0;
    const client = {
      listCardholders: async () => { throw new Error("HTTP 503 transient"); },
      createCardholder: async () => { created++; return { cardholder_id: "ch_new" }; },
    };
    const gw = new LiveIssuingGateway(client as never);
    await gw.createCardholder({ name: "Sandi Samantaray", email: "sandi@vyayasan.com" }, "rid");
    expect(created, "lookup failure must not become a create").toBe(0);
  });
  it("end-to-end: cardholder-ambiguous lock + provider lookup ERROR unlocks via attestation (duplicate hole)", async () => {
    // Cardholder committed remotely; creation response was lost; the provider lookup now errors.
    const sim = makeSim();
    const gw: IssuingGateway = {
      ...sim,
      createCardholder: async (req, rid) => { await sim.createCardholder(req, rid); throw new Error("committed then lost"); },
      findCardholderByEmail: async () => { throw new Error("HTTP 500"); }, // swallowed upstream
    };
    const dir = mkdtempSync(join(tmpdir(), "dup-"));
    const api = createConsoleApi({ gateway: gw, stateFile: join(dir, "s.json") });
    const approveRes = await api(new Request("http://x/api/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: "case_acme" }) }));
    const { approval } = (await approveRes.json()) as any;
    await api(new Request("http://x/api/create-card", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approval }) }));
    const unlock = await api(new Request("http://x/api/reconcile-card", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseId: "case_acme", decision: "none-created", attestation: "I checked the provider dashboard" }) }));
    expect(unlock.status, "a provider lookup ERROR must not count as verified absence").toBe(409);
  });
});
