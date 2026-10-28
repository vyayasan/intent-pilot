import { createHash } from "node:crypto";
import { Agent } from "undici";
import type { NotificationRecord } from "./outbox.js";
import { guardedDispatcher, isPrivateHostname } from "../net/ssrf.js";

/**
 * Email transports. The default is NO transport (preview): records render for review and nothing
 * is ever sent. A transport only runs when the operator explicitly selects one by environment;
 * real provider accounts, recipients and wording are the owner's approval gate, not a default.
 */

export interface DeliveryReceipt {
  transport: string;
  status: "sent" | "failed" | "dry-run";
  at: string;
  providerId?: string;
  error?: string;
  /** true = outcome UNKNOWN (timeout/reset after the request may have been sent).
   *  false = definitely NOT sent (validation, connection refused, or the endpoint answered no). */
  ambiguous?: boolean;
  /** Set when a dry-run record was explicitly promoted to a real send by an operator. */
  promoted?: { from: "dry-run"; at: string; operator: string };
}

/** The request definitely never delivered: validation failed, connection refused, or the
 *  endpoint answered with an error status. The email was NOT sent. */
export class DefiniteMailFailure extends Error {}
/** The request may have reached the endpoint (timeout, connection reset mid-flight): the
 *  outcome is UNKNOWN and the email may have been sent. Never resent blindly. */
export class AmbiguousMailFailure extends Error {}

export interface EmailTransport {
  readonly name: string;
  /** Deliver one already-rendered record. Throw DefiniteMailFailure or AmbiguousMailFailure on
   *  failure - the dispatcher records the outcome and never resends on its own. */
  send(record: NotificationRecord): Promise<{ providerId?: string }>;
}

const RECIPIENT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateRecord(record: NotificationRecord) {
  if (!RECIPIENT.test(record.to)) throw new DefiniteMailFailure(`invalid recipient: ${record.to.slice(0, 60)}`);
  if (!record.subject || record.subject.length > 200) throw new DefiniteMailFailure("subject missing or too long");
  if (!record.body) throw new DefiniteMailFailure("body missing");
  const expect = createHash("sha256").update(JSON.stringify({ kind: record.kind, subject: record.subject, body: record.body, caseId: record.caseId })).digest("hex");
  if (expect !== record.sha256) throw new DefiniteMailFailure("record integrity check failed: sha256 mismatch");
}

/**
 * Exercises the full delivery pipeline - validation, integrity check, receipt - without any
 * provider. Receipts are marked dry-run so they can never be mistaken for real delivery, and a
 * dry-run record is never silently promoted to a real send (see NotificationDispatcher.promote).
 */
export class DryRunTransport implements EmailTransport {
  readonly name = "dry-run";
  async send(record: NotificationRecord) {
    validateRecord(record);
    return { providerId: `dry_${record.sha256.slice(0, 16)}` };
  }
}

/**
 * EXPERIMENTAL: POSTs the rendered record to an operator-configured HTTP endpoint
 * (INTENTPAY_MAIL_ENDPOINT). Tested only against local fake servers; it has never run against a
 * real email provider, and selecting it for real recipients is a separate owner-approved decision.
 *
 * Failure classification mirrors the payment rail. Only failures provably BEFORE the request
 * left this process (refused connection, DNS, blocked port, local validation) are DEFINITE
 * not-sent. Once the request has arrived, nothing short of the documented rejection contract -
 * a JSON body {"rejected": true, "reason": "..."} - proves non-delivery: a 4xx or 5xx alone can
 * still follow a side-effect send, so it stays AMBIGUOUS and is never resent blindly.
 */
type DnsLookupAll = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface HttpMailGuardOptions {
  /** "production": https only, no private literal hosts, resolution-time SSRF guard, no redirects. */
  guard?: "off" | "production";
  /** DNS resolver (all addresses); injectable for tests. Defaults to the system resolver. */
  lookupAll?: DnsLookupAll;
}

// fetch-spec blocked ports, checked locally so the refusal is provably pre-send (undici's own
// rejection carries no error code and would otherwise be indistinguishable from a post-arrival
// parse failure - review finding F1).
const BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);

export class HttpMailTransport implements EmailTransport {
  readonly name = "http";
  private dispatcher?: Agent;
  constructor(
    private endpoint: string | undefined,
    private token?: string,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 10_000,
    private options: HttpMailGuardOptions = {}
  ) {
    if (options.guard === "production") {
      // Resolution-time SSRF guard: validate the addresses the resolver ACTUALLY returns inside
      // the connect path - a hostname check alone is beaten by DNS answers pointing internal.
      // Shared dispatcher (net/ssrf.ts) owns the undici lookup contract.
      this.dispatcher = guardedDispatcher(options.lookupAll, (e) =>
        new DefiniteMailFailure(e.message + " - request never left this process; not sent"));
    }
  }
  async send(record: NotificationRecord) {
    if (!this.endpoint) throw new DefiniteMailFailure("http transport selected without INTENTPAY_MAIL_ENDPOINT");
    if (this.options.guard === "production") {
      const u = new URL(this.endpoint);
      if (u.protocol !== "https:") throw new DefiniteMailFailure("production mail endpoint must be https - not sent");
      if (isPrivateHostname(u.hostname)) throw new DefiniteMailFailure("production mail endpoint must not be a private/internal host - not sent");
    }
    validateRecord(record);
    const port = Number(new URL(this.endpoint).port || (new URL(this.endpoint).protocol === "https:" ? 443 : 80));
    if (BLOCKED_PORTS.has(port)) throw new DefiniteMailFailure(`mail endpoint port ${port} is on the fetch blocklist - request never left this process; not sent`);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ to: record.to, subject: record.subject, body: record.body, sha256: record.sha256, kind: record.kind, caseId: record.caseId }),
        signal: AbortSignal.timeout(this.timeoutMs),
        // Redirects are never followed: the request body (and bearer token) must not leak to a
        // second origin, and a redirect target is outside the SSRF guard. A 3xx answer after the
        // request arrived classifies ambiguous like any other non-ok response.
        redirect: "manual",
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {})
      } as RequestInit);
    } catch (e) {
      if (e instanceof DefiniteMailFailure || e instanceof AmbiguousMailFailure) throw e;
      const err = e as Error & { cause?: unknown };
      // The SSRF guard's DefiniteMailFailure can be wrapped several layers deep by undici
      // (fetch failed -> connect error -> lookup error); walk the whole cause chain.
      for (let c: unknown = err; c instanceof Error; c = (c as { cause?: unknown }).cause) {
        if (c instanceof DefiniteMailFailure || c instanceof AmbiguousMailFailure) throw c;
      }
      if (err.name === "TimeoutError" || err.name === "AbortError")
        throw new AmbiguousMailFailure(`mail endpoint timeout after ${this.timeoutMs}ms - request may have been sent; outcome unknown`);
      // DEFINITE pre-send failures only: a refused TCP connection or a DNS failure prove no
      // bytes reached an endpoint. (Blocked ports are refused locally above; the SSRF guard
      // throws its own DefiniteMailFailure, rethrown untouched higher up.)
      const code = (err.cause as { code?: string } | undefined)?.code;
      if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN")
        throw new DefiniteMailFailure(`mail endpoint request never left this process (${code}); not sent`);
      // EVERYTHING else is ambiguous - including code-less failures: a garbage or truncated HTTP
      // reply means the request DID arrive (review F1), so "unknown code" can never mean "not sent".
      throw new AmbiguousMailFailure(`mail endpoint failure (${code ?? err.message.slice(0, 80)}) - the request may have arrived; outcome unknown`);
    }
    // The request ARRIVED, so no HTTP status alone proves non-delivery: an arbitrary endpoint can
    // send as a side effect and then answer 400 or 500. The only definite rejection is the
    // documented contract: a JSON body {"rejected": true, "reason": "<non-empty>"} - an explicit,
    // machine-readable delivery-rejected receipt. Anything else post-arrival stays AMBIGUOUS.
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      let receipt: { rejected?: unknown; reason?: unknown } | undefined;
      try { receipt = JSON.parse(raw) as { rejected?: unknown; reason?: unknown }; } catch { receipt = undefined; }
      if (receipt && receipt.rejected === true && typeof receipt.reason === "string" && receipt.reason.trim().length > 0)
        throw new DefiniteMailFailure(`mail endpoint HTTP ${res.status} with explicit delivery rejection: ${receipt.reason.slice(0, 200)} - not sent`);
      throw new AmbiguousMailFailure(`mail endpoint HTTP ${res.status} after the request arrived without a validated delivery-rejection receipt - the email may have been sent, outcome unknown`);
    }
    // A 2xx only proves delivery when the body is a STRICT positive-acceptance receipt
    // (review round-2 R2): {"accepted": true, "id"?: string}. Readable-but-arbitrary JSON is
    // not acceptance - an arbitrary endpoint can answer 200 {"ok":true} without sending.
    const raw = await res.text().catch(() => "");
    let j: { accepted?: unknown; id?: unknown };
    try { j = JSON.parse(raw) as { accepted?: unknown; id?: unknown }; } catch {
      throw new AmbiguousMailFailure(`mail endpoint answered HTTP ${res.status} with an unreadable receipt body - the request arrived; outcome unknown`);
    }
    if (j.accepted !== true)
      throw new AmbiguousMailFailure(`mail endpoint answered HTTP ${res.status} without a positive-acceptance receipt (contract: {"accepted":true}) - the request arrived; outcome unknown`);
    return { providerId: typeof j.id === "string" ? j.id : undefined };
  }
}
