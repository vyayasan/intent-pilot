/** Round-6 independent verification, snapshot 236e9e8: Gmail transport + sqlite busy-retry. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GmailApiTransport } from "../src/notify/gmailTransport.js";
import { AmbiguousMailFailure, DefiniteMailFailure } from "../src/notify/transport.js";
import { SqliteStore, SqliteLeaseError } from "../src/console/state.js";
import type { NotificationRecord } from "../src/notify/outbox.js";

const rec = (): NotificationRecord => {
  const r = { kind: "card_created", caseId: "case_acme", to: "ops@example.com", subject: "Card issued", body: "see console", sha256: "" } as NotificationRecord;
  r.sha256 = createHash("sha256").update(JSON.stringify({ kind: r.kind, subject: r.subject, body: r.body, caseId: r.caseId })).digest("hex");
  return r;
};
const gw = (sendImpl: (url: string) => Promise<{ status: number; body: string }>) => {
  const fetchImpl = (async (url: any, init: any) => {
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    const r = await sendImpl(String(url));
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  return new GmailApiTransport({ clientId: "c", clientSecret: "s", refreshToken: "r", fetchImpl, lookupAll: async () => [{ address: "142.250.180.5", family: 4 }] });
};

describe("Gmail transport failure classification", () => {
  it("2xx without a Message id is AMBIGUOUS (never 'sent')", async () => {
    await expect(gw(async () => ({ status: 200, body: "{}" })).send(rec())).rejects.toBeInstanceOf(AmbiguousMailFailure);
  });
  it("2xx with a Message id is the positive-acceptance receipt", async () => {
    const r = await gw(async () => ({ status: 200, body: JSON.stringify({ id: "msg_1" }) })).send(rec());
    expect(r.providerId).toBe("msg_1");
  });
  it("timeout mid-flight is AMBIGUOUS (the request may have arrived)", async () => {
    const t = new GmailApiTransport({ clientId: "c", clientSecret: "s", refreshToken: "r", timeoutMs: 50, lookupAll: async () => [{ address: "142.250.180.5", family: 4 }],
      fetchImpl: (async (_u: any, init: any) => { if (String(_u).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 })); await new Promise((res, rej) => { init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))); }); }) as unknown as typeof fetch });
    await expect(t.send(rec())).rejects.toBeInstanceOf(AmbiguousMailFailure);
  });
  it("documented 4xx rejection is DEFINITE not-sent (no message created)", async () => {
    await expect(gw(async () => ({ status: 403, body: JSON.stringify({ error: { code: 403, message: "Insufficient Permission", status: "PERMISSION_DENIED" } }) })).send(rec())).rejects.toBeInstanceOf(DefiniteMailFailure);
  });
  it("5xx WITH a parseable Google error body must be AMBIGUOUS, not 'definitely not sent'", async () => {
    // The codebase's own mail discipline (transport.ts): "a 4xx or 5xx alone can still follow a
    // side-effect send, so it stays AMBIGUOUS". Google's send contract does not document that a
    // 500 proves no message was created; a commit-then-500 is exactly the ambiguous shape the
    // payment rail locks on. Definite here enables a blind resend -> duplicate operator email.
    await expect(gw(async () => ({ status: 500, body: JSON.stringify({ error: { code: 500, message: "Backend Error", status: "INTERNAL" } }) })).send(rec()))
      .rejects.toBeInstanceOf(AmbiguousMailFailure);
  });
  it("5xx with an unparseable body is AMBIGUOUS", async () => {
    await expect(gw(async () => ({ status: 502, body: "<html>bad gateway</html>" })).send(rec())).rejects.toBeInstanceOf(AmbiguousMailFailure);
  });
  it("token refresh invalid_grant is DEFINITE (send never attempted) and names re-authorization", async () => {
    const t = new GmailApiTransport({ clientId: "c", clientSecret: "s", refreshToken: "r", lookupAll: async () => [{ address: "142.250.180.5", family: 4 }],
      fetchImpl: (async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been revoked." }), { status: 400 })) as unknown as typeof fetch });
    await expect(t.send(rec())).rejects.toThrowError(/invalid_grant.*re-authorization|re-authorization/s);
  });
  it("SSRF: a private resolution for the Google endpoint is refused before any byte leaves", async () => {
    // The guard lives in the undici dispatcher, so this uses the REAL fetch with only DNS injected.
    const t = new GmailApiTransport({ clientId: "c", clientSecret: "s", refreshToken: "r", timeoutMs: 2000,
      lookupAll: async () => [{ address: "169.254.169.254", family: 4 }] });
    await expect(t.send(rec())).rejects.toBeInstanceOf(DefiniteMailFailure);
  });
  it("redirects are never followed (authorization header cannot leak to a second origin)", async () => {
    let authToSecondOrigin = false;
    const t = new GmailApiTransport({ clientId: "c", clientSecret: "s", refreshToken: "r", lookupAll: async () => [{ address: "142.250.180.5", family: 4 }],
      fetchImpl: (async (url: any, init: any) => {
        if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
        if (String(url).includes("evil")) { if ((init?.headers as any)?.authorization) authToSecondOrigin = true; return new Response("{}"); }
        return new Response("", { status: 302, headers: { location: "https://evil.example/steal" } });
      }) as unknown as typeof fetch });
    await expect(t.send(rec())).rejects.toThrow();
    expect(authToSecondOrigin).toBe(false);
  });
});

describe("sqlite busy-retry (round-5 flake fix) semantics", () => {
  it("a genuinely corrupt store still fails CLOSED (no retry washes corruption away)", () => {
    const p = join(mkdtempSync(join(tmpdir(), "corrupt-")), "s.db");
    writeFileSync(p, Buffer.from("this is not a sqlite database at all, definitely not".padEnd(100, "x")));
    const s = new SqliteStore(p);
    expect(s.load()).toBe("corrupted");
  });
  it("a live owner's lease is still refused IMMEDIATELY (retry bridges init contention, not the lease)", () => {
    const p = join(mkdtempSync(join(tmpdir(), "lease-")), "s.db");
    const a = new SqliteStore(p);
    const t0 = Date.now();
    expect(() => new SqliteStore(p)).toThrow(SqliteLeaseError);
    expect(Date.now() - t0, "lease refusal must not spin through the busy-retry budget").toBeLessThan(2000);
    a.close();
  });
  it("two openers of one fresh file in one process: exactly one holds the lease, no corrupt marker", () => {
    const p = join(mkdtempSync(join(tmpdir(), "fresh-")), "s.db");
    const a = new SqliteStore(p);
    expect(a.load()).not.toBe("corrupted");
    expect(() => new SqliteStore(p)).toThrow(SqliteLeaseError);
    a.close();
  });
  it("stale-lease takeover still works after the TTL", () => {
    const p = join(mkdtempSync(join(tmpdir(), "stale-")), "s.db");
    const a = new SqliteStore(p, 50); // TTL 50ms, heartbeats stopped by close-less abandon below
    (a as any).heartbeat && clearInterval((a as any).heartbeat); // simulate a dead owner without close()
    const deadline = Date.now() + 3000;
    let b: SqliteStore | undefined;
    while (Date.now() < deadline && !b) { try { b = new SqliteStore(p, 50); } catch { /* still fresh */ } }
    expect(b, "a dead owner's lease must be taken over").toBeDefined();
    b?.close();
  });
});
