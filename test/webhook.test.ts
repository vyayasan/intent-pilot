import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { WebhookVerifier, isIssuingEvent } from "../src/gateway/webhook.js";

const sign = (secret: string, ts: string, body: string) => createHmac("sha256", secret).update(ts + body).digest("hex");
describe("webhook verification", () => {
  const NOW = 1_800_000_000_000, ts = String(NOW), body = JSON.stringify({ id: "evt_1", name: "issuing.transaction.created", data: { id: "txn_1" } });
  const mk = () => new WebhookVerifier("whsec", { now: () => NOW });
  it("accepts a correct signature once and flags a repeat", () => {
    const v = mk(), h = { timestamp: ts, signature: sign("whsec", ts, body) };
    const e = v.verify(body, h); expect(e).not.toBe("duplicate"); expect(isIssuingEvent(e as any)).toBe(true);
    expect(v.verify(body, h)).toBe("duplicate");
  });
  it("rejects a wrong secret, a changed body, a stale timestamp and missing headers", () => {
    expect(() => mk().verify(body, { timestamp: ts, signature: sign("other", ts, body) })).toThrow(/mismatch/);
    expect(() => mk().verify(body + " ", { timestamp: ts, signature: sign("whsec", ts, body) })).toThrow(/mismatch/);
    const old = String(NOW - 10 * 60_000);
    expect(() => mk().verify(body, { timestamp: old, signature: sign("whsec", old, body) })).toThrow(/tolerance/);
    expect(() => mk().verify(body, {})).toThrow(/headers/);
    expect(() => new WebhookVerifier("")).toThrow();
  });
});
