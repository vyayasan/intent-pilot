import { Agent } from "undici";
import type { NotificationRecord } from "./outbox.js";
import { AmbiguousMailFailure, DefiniteMailFailure, validateRecord, type EmailTransport } from "./transport.js";
import { guardedDispatcher } from "../net/ssrf.js";

/**
 * Gmail API transport (users.messages.send) - the real-provider path for the approval emails.
 * NEVER selected by default: it runs only when the operator sets INTENTPAY_EMAIL_TRANSPORT=gmail
 * with OAuth credentials from an owner-approved Google client (a separate explicit approval).
 *
 * Failure discipline mirrors the payment rail, adapted to the Gmail API's DOCUMENTED contract
 * (developers.google.com/gmail/api/reference/rest/v1/users.messages/send):
 *  - 2xx with a Message resource (string `id`) = the documented positive-acceptance receipt: SENT.
 *  - 2xx without an `id` = not a valid receipt: AMBIGUOUS, never resent blindly.
 *  - A 4xx carrying Google's documented JSON error body ({error:{message,...}}) = the request was
 *    validated and rejected before any message was created: DEFINITE not-sent.
 *  - ANY 5xx, parseable Google error body or not = AMBIGUOUS: a commit-then-error can follow a
 *    side-effecting send, so the message may exist; never resent blindly.
 *  - A non-2xx with an unparseable body = AMBIGUOUS (an arbitrary proxy could have answered).
 *  - Pre-send network failures (refused connection, DNS) = DEFINITE not-sent.
 *  - Timeout/reset mid-flight = AMBIGUOUS: the request may have arrived; outcome unknown.
 *  - Token-refresh failure of ANY kind = DEFINITE not-sent for the email: the send request was
 *    never made. (invalid_grant additionally means the owner-approved credential is dead.)
 */

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface GoogleErrorBody { error?: { code?: number; message?: string; status?: string } }

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
const encodeSubject = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

export function renderMime(record: NotificationRecord): string {
  const headers = [
    `To: ${record.to}`,
    `Subject: ${encodeSubject(record.subject)}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    `MIME-Version: 1.0`,
  ];
  return headers.join("\r\n") + "\r\n\r\n" + Buffer.from(record.body, "utf8").toString("base64");
}

export interface GmailTransportOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable DNS for tests; defaults to the system resolver (all addresses). */
  lookupAll?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  now?: () => number;
}

export class GmailApiTransport implements EmailTransport {
  readonly name = "gmail";
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private dispatcher: Agent;
  private token?: { value: string; expiresAt: number };
  private now: () => number;

  constructor(private opts: GmailTransportOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
    // Resolution-time SSRF guard on both Google endpoints (fixed https hosts, but the resolver's
    // answer is what we actually connect to) - shared with the OIDC and http-mail paths so the
    // undici lookup contract lives in exactly one place (net/ssrf.ts).
    this.dispatcher = guardedDispatcher(opts.lookupAll, (e) =>
      new DefiniteMailFailure(e.message + " - request never left this process; not sent"));
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    let res: Response;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
          refresh_token: this.opts.refreshToken,
          grant_type: "refresh_token",
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "manual",
        dispatcher: this.dispatcher,
      } as RequestInit);
    } catch (e) {
      // The SEND was never attempted, so for the email this is provably not-sent.
      const msg = e instanceof Error ? e.message : String(e);
      throw new DefiniteMailFailure(`gmail token refresh failed before any send attempt (${msg.slice(0, 120)}) - not sent`);
    }
    const raw = await res.text().catch(() => "");
    let body: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
    try { body = JSON.parse(raw); } catch { body = {}; }
    if (!res.ok || typeof body.access_token !== "string" || !body.access_token) {
      const why = body.error === "invalid_grant"
        ? "invalid_grant - the owner-approved Google credential is revoked/expired; re-authorization required"
        : `HTTP ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim();
      throw new DefiniteMailFailure(`gmail token refresh rejected (${why.slice(0, 200)}) - the send was never attempted; not sent`);
    }
    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async send(record: NotificationRecord): Promise<{ providerId?: string }> {
    // Local validation is the same integrity/field gate every transport applies (definite, pre-send).
    validateRecord(record);
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.fetchImpl(SEND_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ raw: b64url(renderMime(record)) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "manual",
        dispatcher: this.dispatcher,
      } as RequestInit);
    } catch (e) {
      if (e instanceof DefiniteMailFailure || e instanceof AmbiguousMailFailure) throw e;
      const err = e as Error & { cause?: unknown };
      for (let c: unknown = err; c instanceof Error; c = (c as { cause?: unknown }).cause) {
        if (c instanceof DefiniteMailFailure || c instanceof AmbiguousMailFailure) throw c;
      }
      if (err.name === "TimeoutError" || err.name === "AbortError")
        throw new AmbiguousMailFailure(`gmail send timeout after ${this.timeoutMs}ms - the request may have been sent; outcome unknown`);
      const code = (err.cause as { code?: string } | undefined)?.code;
      if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN")
        throw new DefiniteMailFailure(`gmail send never left this process (${code}); not sent`);
      throw new AmbiguousMailFailure(`gmail send failure (${code ?? err.message.slice(0, 80)}) - the request may have arrived; outcome unknown`);
    }
    const raw = await res.text().catch(() => "");
    let body: { id?: string } & GoogleErrorBody = {};
    try { body = JSON.parse(raw); } catch { body = {}; }
    if (res.ok) {
      // Documented positive-acceptance receipt: a Message resource with an id.
      if (typeof body.id === "string" && body.id.length > 0) return { providerId: body.id };
      throw new AmbiguousMailFailure("gmail send answered 2xx without a Message id - not a valid delivery receipt; outcome unknown");
    }
    // Only a documented 4xx Google error body is a definite rejection: the request was validated
    // and refused before any message was created. A 5xx can follow a side-effecting send
    // (commit-then-error), so even a parseable Google error body stays AMBIGUOUS - never resent.
    if (body.error && typeof body.error.message === "string" && body.error.message.length > 0) {
      if (res.status >= 400 && res.status < 500)
        throw new DefiniteMailFailure(`gmail send rejected by the documented API contract (HTTP ${res.status} ${body.error.status ?? ""}: ${body.error.message.slice(0, 200)}) - not sent`);
      throw new AmbiguousMailFailure(`gmail send answered HTTP ${res.status} (${body.error.status ?? ""}: ${body.error.message.slice(0, 200)}) - a 5xx can follow a side-effect send; outcome unknown`);
    }
    throw new AmbiguousMailFailure(`gmail send HTTP ${res.status} with an unparseable error body - the request may have been sent, outcome unknown`);
  }
}
