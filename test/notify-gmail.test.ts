import { describe, it, expect } from "vitest";
import { GmailApiTransport, renderMime } from "../src/notify/gmailTransport.js";
import { AmbiguousMailFailure, DefiniteMailFailure } from "../src/notify/transport.js";
import { createHash } from "node:crypto";

const record = (over: Record<string, unknown> = {}) => {
  const base = { kind: "card_created", to: "sandi@vyayasan.com", subject: "[IntentPay] Card created", body: "limit 100 USD", caseId: "case_acme" };
  const sha256 = createHash("sha256").update(JSON.stringify({ kind: base.kind, subject: base.subject, body: base.body, caseId: base.caseId })).digest("hex");
  return { id: "n1", at: "2026-10-27T00:00:00Z", status: "pending", attempts: 0, ...base, sha256, ...over } as never;
};

const okToken = { access_token: "ya29.test", expires_in: 3600 };
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mk = (sendImpl: (url: string) => Promise<Response>) => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => { calls.push(url); return sendImpl(url); }) as unknown as typeof fetch;
  const t = new GmailApiTransport({ clientId: "id", clientSecret: "sec", refreshToken: "rt", fetchImpl, lookupAll: async () => [{ address: "142.250.180.5", family: 4 }] });
  return { t, calls };
};
const SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

describe("GmailApiTransport failure discipline", () => {
  it("success: documented Message id is the positive-acceptance receipt", async () => {
    const { t } = mk(async (url) => url === SEND ? jsonRes(200, { id: "msg-1", threadId: "t-1" }) : jsonRes(200, okToken));
    const r = await t.send(record());
    expect(r.providerId).toBe("msg-1");
  });
  it("MIME render: To/Subject/body survive base64 round-trip", async () => {
    let raw = "";
    const { t } = mk(async (url) => {
      if (url === SEND) { /* capture below */ }
      return url === SEND ? jsonRes(200, { id: "m" }) : jsonRes(200, okToken);
    });
    const orig = (t as never as { fetchImpl: typeof fetch }).fetchImpl;
    void orig;
    const mime = renderMime(record());
    expect(mime).toContain("To: sandi@vyayasan.com");
    expect(mime).toContain("Subject: [IntentPay] Card created");
    expect(mime).toContain("MIME-Version: 1.0");
    const b64 = mime.split("\r\n\r\n")[1];
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("limit 100 USD");
    void raw;
  });
  it("documented Google JSON error = DEFINITE not-sent (request processed and rejected)", async () => {
    const { t } = mk(async (url) => url === SEND ? jsonRes(400, { error: { code: 400, message: "Invalid To header", status: "INVALID_ARGUMENT" } }) : jsonRes(200, okToken));
    await expect(t.send(record())).rejects.toBeInstanceOf(DefiniteMailFailure);
  });
  it("2xx without a Message id = AMBIGUOUS, never treated as sent", async () => {
    const { t } = mk(async (url) => url === SEND ? jsonRes(200, {}) : jsonRes(200, okToken));
    await expect(t.send(record())).rejects.toBeInstanceOf(AmbiguousMailFailure);
  });
  it("unparseable error body = AMBIGUOUS (a proxy may have answered)", async () => {
    const { t } = mk(async (url) => url === SEND ? new Response("<html>502 bad gateway</html>", { status: 502 }) : jsonRes(200, okToken));
    await expect(t.send(record())).rejects.toBeInstanceOf(AmbiguousMailFailure);
  });
  it("token refresh invalid_grant = DEFINITE and the SEND endpoint is never called", async () => {
    const { t, calls } = mk(async (url) => url === SEND ? jsonRes(200, { id: "m" }) : jsonRes(401, { error: "invalid_grant", error_description: "Token has been revoked." }));
    await expect(t.send(record())).rejects.toBeInstanceOf(DefiniteMailFailure);
    expect(calls.includes(SEND), "send must never be attempted without a token").toBe(false);
  });
  it("token refresh network failure = DEFINITE for the email (send never attempted)", async () => {
    const { t, calls } = mk(async () => { throw new Error("connect ECONNREFUSED 142.250.180.5:443"); });
    await expect(t.send(record())).rejects.toBeInstanceOf(DefiniteMailFailure);
    expect(calls.filter((u) => u === SEND).length).toBe(0);
  });
  it("send timeout = AMBIGUOUS (the request may have arrived)", async () => {
    const { t } = mk(async (url) => {
      if (url === SEND) { const e = new Error("The operation timed out"); e.name = "TimeoutError"; throw e; }
      return jsonRes(200, okToken);
    });
    await expect(t.send(record())).rejects.toBeInstanceOf(AmbiguousMailFailure);
  });
  it("send connection refused = DEFINITE pre-send failure", async () => {
    const { t } = mk(async (url) => {
      if (url === SEND) { const e = new Error("fetch failed"); (e as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" }; throw e; }
      return jsonRes(200, okToken);
    });
    await expect(t.send(record())).rejects.toBeInstanceOf(DefiniteMailFailure);
  });
  it("integrity failure (tampered record) = DEFINITE before any network call", async () => {
    const { t, calls } = mk(async () => jsonRes(200, okToken));
    await expect(t.send(record({ body: "tampered" }))).rejects.toBeInstanceOf(DefiniteMailFailure);
    expect(calls.length).toBe(0);
  });
});
