/** Round-7 independent verification: f1d79d6 undici lookup contract fix + sibling sweep.
 *  No external writes: discriminators use TEST-NET addresses (RFC 5737, unrouted) with short
 *  timeouts - ERR_INVALID_IP_ADDRESS fires INSIDE the dispatcher before any packet leaves. */
import { describe, it, expect } from "vitest";
// Builder adaptations (round-7 import), behavior-preserving:
//  1. sibling guardedDispatcher probe uses fetch (not raw request): the production OIDC path in
//     auth.ts calls fetch with this dispatcher, and undici fetch aborts a pending connect on the
//     signal while a raw request() to an unrouted TEST-NET address does not settle pre-timeout.
//  2. HttpMailTransport probe passes the real 5-arg constructor (endpoint, token, fetchImpl,
//     timeoutMs, options) per src/notify/transport.ts + src/console/server.ts; the submitted
//     probe passed options in the fetchImpl slot.
import { Agent, request } from "undici";
import { createServer } from "node:http";
import { GmailApiTransport } from "../src/notify/gmailTransport.js";
import { guardedDispatcher, assertPublicResolution } from "../src/net/ssrf.js";
import { HttpMailTransport, DefiniteMailFailure } from "../src/notify/transport.js";
import { createHash } from "node:crypto";

const rec = () => {
  const r = { kind: "card_created", caseId: "case_acme", to: "ops@example.com", subject: "Card issued", body: "see console", sha256: "" };
  return { ...r, sha256: createHash("sha256").update(JSON.stringify({ kind: r.kind, subject: r.subject, body: r.body, caseId: r.caseId })).digest("hex") } as never;
};
/** TEST-NET-1: classified public by the SSRF guard, unroutable in practice - a lookup bug
 *  surfaces instantly as ERR_INVALID_IP_ADDRESS; a healthy lookup proceeds to a connect that
 *  times out / aborts. No real service is ever contacted. */
const TESTNET = [{ address: "192.0.2.7", family: 4 }];
const classify = async (fn: () => Promise<unknown>): Promise<string> => {
  const t0 = Date.now();
  try { await fn(); return "COMPLETED"; } catch (e) {
    // The lookup-contract failure is a local, sub-100ms rejection; a healthy lookup proceeds to
    // the connect phase and only fails at the 700ms timeout. Timing is a wrapper-proof
    // discriminator (transports re-wrap errors and drop the code from the chain).
    if (Date.now() - t0 < 300) return "LOOKUP_CONTRACT_BROKEN";
    for (let c: unknown = e; c instanceof Error; c = (c as { cause?: unknown }).cause)
      if ((c as { code?: string }).code === "ERR_INVALID_IP_ADDRESS" || c.message.includes("ERR_INVALID_IP_ADDRESS")) return "LOOKUP_CONTRACT_BROKEN";
    return "REACHED_CONNECT_PHASE"; // any other failure means the lookup was accepted
  }
};

describe("f1d79d6: gmail transport lookup honors the all:true array contract", () => {
  it("REAL undici agent + REAL transport class: lookup succeeds, failure is connect-phase, not ERR_INVALID_IP_ADDRESS", async () => {
    const t = new GmailApiTransport({ clientId: "c", clientSecret: "s", refreshToken: "r", timeoutMs: 700,
      lookupAll: async () => TESTNET });
    expect(await classify(() => t.send(rec()))).toBe("REACHED_CONNECT_PHASE");
  });
  it("SSRF invariant intact after the fix: a private resolution is refused before any dispatch", async () => {
    const t = new GmailApiTransport({ clientId: "c", clientSecret: "s", refreshToken: "r", timeoutMs: 700,
      lookupAll: async () => [{ address: "169.254.169.254", family: 4 }] });
    await expect(t.send(rec())).rejects.toBeInstanceOf(DefiniteMailFailure);
  });
  it("assertPublicResolution rejects a MIXED array (one private among publics)", () => {
    expect(() => assertPublicResolution("h", [{ address: "142.250.180.5" }, { address: "10.0.0.4" }])).toThrow(/private/);
  });
});

describe("sibling sweep: the same contract bug outside gmailTransport", () => {
  it("guardedDispatcher (OIDC production path, auth.ts) has the SAME single-pair bug", async () => {
    const d = guardedDispatcher(async () => TESTNET);
    expect(await classify(() => fetch("https://issuer.example/", { dispatcher: d, signal: AbortSignal.timeout(700) } as RequestInit)),
      "production IdP discovery/JWKS/token fetches would ALL fail pre-dispatch: login down at first real IdP run")
      .toBe("REACHED_CONNECT_PHASE");
  });
  it("HttpMailTransport production guard has the SAME single-pair bug", async () => {
    const t = new HttpMailTransport("https://mail.example/send", "tok", fetch, 700, { guard: "production", lookupAll: async () => TESTNET });
    expect(await classify(() => t.send(rec()))).toBe("REACHED_CONNECT_PHASE");
  });
});

describe("contract proof: what undici 7.30.1 actually passes", () => {
  it("lookup is invoked with all:true and only the ARRAY reply is accepted", async () => {
    const seen: unknown[] = [];
    const srv = createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as { port: number }).port;
    const mk = (reply: (cb: Function) => void) => new Agent({ connect: { lookup: (h: string, o: unknown, cb: Function) => { seen.push(o); reply(cb); } } });
    const r1 = await request(`http://example.test:${port}/`, { dispatcher: mk((cb) => cb(null, [{ address: "127.0.0.1", family: 4 }])) });
    expect(r1.statusCode).toBe(200); await r1.body.dump();
    expect((seen[0] as { all?: boolean }).all).toBe(true);
    await expect(request(`http://example.test:${port}/`, { dispatcher: mk((cb) => cb(null, "127.0.0.1", 4)) }))
      .rejects.toMatchObject({ code: "ERR_INVALID_IP_ADDRESS" });
    srv.close();
  });
});
