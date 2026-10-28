/** Round-3 independent verification, snapshot ba4beb9.
 *  Imported verbatim by the builder EXCEPT two spots where the intended behavior changed
 *  (both commented): N1 adopt now CORRECTS provider controls (the sim gateway grew
 *  setCardControls/readCardControls), and the cardholder-ambiguous dead-end is now resolved
 *  via provider-verified lookup, so 'check' returns 200 instead of 409. */
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpMailTransport } from "../src/notify/transport.js";
import { Outbox } from "../src/notify/outbox.js";
import { isPrivateIp } from "../src/net/ssrf.js";
import { createConsoleApi } from "../src/console/api.js";
import { makeSim, type IssuingGateway } from "../src/sim/simGateway.js";

const emit = (o: Outbox) => o.emit("purchase_cleared", { caseId: "c1", vendor: "V", recipient: "a@b.co", detail: { amount: 1, currency: "USD", cap: 1 } });

async function jsonServer(body: string, status = 200) {
  const srv: Server = createServer((_req, res) => { res.writeHead(status, { "content-type": "application/json" }).end(body); });
  await new Promise<void>((r) => srv.listen(0, r));
  return { port: (srv.address() as any).port, close: () => srv.close() };
}

describe("R2 fix: positive-acceptance contract", () => {
  it("200 {\"ok\":true} is now AMBIGUOUS (not 'sent')", async () => {
    const s = await jsonServer('{"ok":true}');
    try {
      const t = new HttpMailTransport(`http://127.0.0.1:${s.port}/send`);
      await expect(t.send(emit(new Outbox()))).rejects.toThrow(/without a positive-acceptance receipt/);
    } finally { s.close(); }
  });
  it("200 {\"accepted\":true,\"id\":\"x\"} is sent", async () => {
    const s = await jsonServer('{"accepted":true,"id":"x"}');
    try {
      const t = new HttpMailTransport(`http://127.0.0.1:${s.port}/send`);
      const r = await t.send(emit(new Outbox()));
      expect(r.providerId).toBe("x");
    } finally { s.close(); }
  });
});

describe("R3 residual: expanded NAT64 without '::' compression", () => {
  it("64:ff9b:0:0:0:0:7f00:1 (expanded NAT64 WKP of 127.0.0.1) should be private", () => {
    expect(isPrivateIp("64:ff9b:0:0:0:0:7f00:1")).toBe(true);
  });
});

// Helper: approve a case and return the approval object.
async function approve(api: any, caseId: string) {
  const res = await api(new Request("http://x/api/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId }) }));
  return (await res.json() as any).approval;
}
const post = (api: any, path: string, body: unknown) =>
  api(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("card reconcile: adopt discards provider-echoed controls without verification", () => {
  it("adopt overlays the intent payload even when the provider listing echoes DIFFERENT real controls", async () => {
    // Gateway whose createCard "fails ambiguously" after committing with WRONG controls
    // (simulating partial/tampered provider state): the committed card allows 999999 USD.
    const sim = makeSim();
    let holder = "";
    const gw: IssuingGateway = {
      ...sim,
      createCardholder: async (req, rid) => { const r = await sim.createCardholder(req, rid); if (r.state !== "unknown") holder = r.cardholder.id; return r; }, // BUILDER ADAPTATION: tri-state return (round-4 N5)
      createCard: async (req, rid) => {
        await sim.createCard({ cardholderId: req.cardholderId, controls: { amountLimit: 999999, currencyAllowlist: ["USD", "EUR"], merchantCategories: ["software", "travel"] } }, rid);
        throw new Error("sandbox 400: ambiguous failure after commit");
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "adopt-"));
    const api = createConsoleApi({ gateway: gw, stateFile: join(dir, "s.json") });
    const approval = await approve(api, "case_acme");
    const create = await post(api, "/api/create-card", { approval });
    expect(create.status).toBe(409); // locked
    const listing = (await gw.listCards!(holder))!;
    const realCard = listing[0];
    expect(realCard.controls.amountLimit).toBe(999999); // provider reality: wide open
    const adopt = await post(api, "/api/reconcile-card", { caseId: "case_acme", decision: "adopt", cardId: realCard.id });
    expect(adopt.status).toBe(200);
    const body = (await adopt.json()) as any;
    // The console now BELIEVES the card enforces the approved intent (cap 100 USD software-only),
    // while the provider record still allows 999999 USD any-currency travel. No verification, no update.
    expect(body.card.controls.amountLimit).toBe(100);
    const reality = (await gw.listCards!(holder))![0];
    // BUILDER ADAPTATION (intended behavior change): adopt now corrects the provider record
    // via setCardControls and verifies the read-back before adopting - the provider card is
    // brought in line with the intent, so the wide-open record no longer exists.
    expect(reality.controls.amountLimit, "provider record corrected to the approved intent").toBe(100);
  });
});

describe("card reconcile: empty-listing unlock has no lag protection", () => {
  it("one empty first-page listing + 'none-created' click clears the lock (no attestation text, no re-read, no lag window)", async () => {
    const sim = makeSim();
    let calls = 0;
    const gw: IssuingGateway = {
      ...sim,
      createCard: async () => { throw new Error("ambiguous"); },
      listCards: () => { calls++; return []; }, // eventually-consistent provider could still hold the card
    };
    const dir = mkdtempSync(join(tmpdir(), "nc-"));
    const api = createConsoleApi({ gateway: gw, stateFile: join(dir, "s.json") });
    const approval = await approve(api, "case_acme");
    await post(api, "/api/create-card", { approval });
    const r = await post(api, "/api/reconcile-card", { caseId: "case_acme", decision: "none-created" });
    expect(r.status, "single empty listing unlocks; compare authorize reconcile, which keeps the lock on no-match without manual attestation").toBe(409);
    void calls;
  });
});

describe("cardholder identity is not durable", () => {
  it("a restart forgets the cardholder id and creates a SECOND cardholder at the provider", async () => {
    const sim = makeSim();
    let cardholders = 0;
    const gw: IssuingGateway = { ...sim, createCardholder: async (req, rid) => { cardholders++; return sim.createCardholder(req, rid); } };
    const dir = mkdtempSync(join(tmpdir(), "holder-"));
    const sf = join(dir, "s.json");
    const api1 = createConsoleApi({ gateway: gw, stateFile: sf });
    const a1 = await approve(api1, "case_acme");
    expect((await post(api1, "/api/create-card", { approval: a1 })).status).toBe(200);
    api1.flush();
    // Simulated restart: fresh api over the same state file.
    const api2 = createConsoleApi({ gateway: gw, stateFile: sf });
    const a2 = await approve(api2, "case_flowdesk");
    expect((await post(api2, "/api/create-card", { approval: a2 })).status).toBe(200);
    expect(cardholders, "one logical cardholder should be created once").toBe(1);
  });
  it("cardholder-ambiguous lock has NO api resolution route (dead-end)", async () => {
    const sim = makeSim();
    const gw: IssuingGateway = {
      ...sim,
      createCardholder: async (req, rid) => { await sim.createCardholder(req, rid); throw new Error("committed then failed"); },
    };
    const dir = mkdtempSync(join(tmpdir(), "holder2-"));
    const api = createConsoleApi({ gateway: gw, stateFile: join(dir, "s.json") });
    const approval = await approve(api, "case_acme");
    expect((await post(api, "/api/create-card", { approval })).status).toBe(409); // locked, cardholderId unknown
    // BUILDER ADAPTATION (intended behavior change): the cardholder is now discovered via
    // findCardholderByEmail (the sim committed it before the ambiguous failure), so 'check'
    // succeeds as a provider read. none-created still refuses without an attestation (N3) and
    // adopt still refuses a cardId absent from the provider listing.
    expect((await post(api, "/api/reconcile-card", { caseId: "case_acme", decision: "check", cardId: "x" })).status).toBe(200);
    for (const decision of ["none-created", "adopt"] as const) {
      const r = await post(api, "/api/reconcile-card", { caseId: "case_acme", decision, cardId: "x" });
      expect(r.status, `decision=${decision} blocked`).toBe(409);
    }
  });
});
