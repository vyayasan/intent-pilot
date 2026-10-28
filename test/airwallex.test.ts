import { describe, it, expect } from "vitest";
import { AirwallexClient } from "../src/gateway/airwallex.js";
import { toCardTransaction } from "../src/gateway/live.js";

const mkClient = (responses: Response[], log: string[] = []) => {
  let i = 0;
  const f = (async (url: any, init: any) => { log.push(String(url).split(".com")[1] + " " + (init?.body ?? "")); return responses[i++] ?? new Response("{}", { status: 500 }); }) as any;
  return new AirwallexClient({ clientId: "c", apiKey: "k", fetchImpl: f, sleep: async () => {}, now: () => 0 });
};
const login = () => new Response(JSON.stringify({ token: "t" }), { status: 200 });

describe("client resilience", () => {
  it("logs in again once after a 401", async () => {
    const c = mkClient([login(), new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 }), login(), new Response(JSON.stringify({ id: "crd_1" }), { status: 200 })]);
    expect((await c.createCard({ cardholder_id: "cth_1" })).id).toBe("crd_1");
  });
  it("retries a rate-limited POST with the same request_id", async () => {
    const log: string[] = [];
    const c = mkClient([login(), new Response("{}", { status: 429 }), new Response(JSON.stringify({ ok: 1 }), { status: 200 })], log);
    await c.simCapture("txn_1", "rid-1");
    const posts = log.filter((l) => l.includes("capture"));
    expect(posts.length).toBe(2);
    expect(posts[0]).toBe(posts[1]);
    expect(posts[0]).toContain("rid-1");
  });
  it("gives up after repeated rate limits", async () => {
    const c = mkClient([login(), new Response("{}", { status: 429 }), new Response("{}", { status: 429 }), new Response("{}", { status: 429 })]);
    await expect(c.getCardLimits("crd_1")).rejects.toThrow(/429/);
  });
});

describe("bearer token mode", () => {
  it("skips login when a bearer token is supplied (auth-injecting proxy)", async () => {
    const calls: string[] = [];
    const f: typeof fetch = (async (url: any) => { calls.push(String(url)); return new Response(JSON.stringify({ items: [] }), { status: 200 }); }) as any;
    const c = new AirwallexClient({ clientId: "", apiKey: "", bearerToken: "proxy-injected", baseUrl: "http://127.0.0.1:8788", fetchImpl: f });
    await c.listTransactions();
    expect(calls.some((u) => u.includes("authentication/login"))).toBe(false);
  });
});

describe("live status mapping", () => {
  it("treats transaction_type CLEARING as accepted", () => {
    expect(toCardTransaction({ id: "txn_1", card_id: "crd_1", amount: 75, currency: "USD", transaction_type: "CLEARING", status: "PENDING" }).status).toBe("CLEARING");
  });
  it("carries failure_reason on a decline", () => {
    const t = toCardTransaction({ id: "txn_2", card_id: "crd_1", amount: 101, currency: "USD", transaction_type: "AUTHORIZATION", status: "FAILED", failure_reason: "above_approved_cap" });
    expect(t.status).toBe("FAILED");
    expect(t.failureReason).toBe("above_approved_cap");
  });
  // Shapes below observed against the Airwallex sandbox on 2026-10-21.
  it("maps a live authorize approval (no status field) to PENDING", () => {
    const t = toCardTransaction({ card_transaction_id: "ctx_1", card_transaction_lifecycle_id: "lc_1", card_id: "crd_1", transaction_amount: 100, transaction_currency: "USD", type: "AUTHORIZATION", process_result: "APPROVED" });
    expect(t.id).toBe("ctx_1");
    expect(t.status).toBe("PENDING");
  });
  it("maps a live capture response (type CLEARING, no status field) to CLEARING", () => {
    const t = toCardTransaction({ card_transaction_id: "ctx_1", card_id: "crd_1", transaction_amount: 100, transaction_currency: "USD", type: "CLEARING", process_result: "APPROVED" });
    expect(t.id).toBe("ctx_1");
    expect(t.status).toBe("CLEARING");
  });
  it("maps a live CARD_INACTIVE decline to FAILED with the reason", () => {
    const t = toCardTransaction({ card_transaction_id: "ctx_2", card_id: "crd_1", transaction_amount: 100, transaction_currency: "USD", type: "AUTHORIZATION", process_result: "DECLINED", failure_reason: "CARD_INACTIVE" });
    expect(t.status).toBe("FAILED");
    expect(t.failureReason).toBe("CARD_INACTIVE");
  });
  it("links transactions-list items to the authorization id space via card_transaction_data", () => {
    const t = toCardTransaction({ transaction_id: "txn_9", card_id: "crd_1", transaction_amount: -100, transaction_currency: "USD", transaction_type: "CLEARING", status: "APPROVED", card_transaction_data: { card_transaction_id: "ctx_1", card_transaction_lifecycle_id: "lc_1" } });
    expect(t.id).toBe("ctx_1");
    expect(t.status).toBe("CLEARING");
  });
});
