import { randomUUID } from "node:crypto";

// Thin typed client for the Airwallex sandbox. Credentials come from the caller (env at the edge), never from code.
// Behaviour taken from the public docs: login with x-client-id / x-api-key returns a ~30 minute bearer token;
// every mutating call carries a unique request_id; issuing lives under /api/v1/issuing and the sandbox
// simulators under /api/v1/simulation/issuing.
export interface ClientOpts {
  clientId: string; apiKey: string;
  /** Skip login and send this bearer token - for a local auth-injecting proxy that owns the credentials. */
  bearerToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch; now?: () => number; maxRps?: number;
  sleep?: (ms: number) => Promise<void>;
}
export class AirwallexError extends Error {
  constructor(public status: number, public code: string, message: string) { super(`${status} ${code}: ${message}`); }
}

export class AirwallexClient {
  private token = ""; private tokenExp = 0; private stamps: number[] = [];
  private f: typeof fetch; private now: () => number; private sleep: (ms: number) => Promise<void>;
  private base: string; private maxRps: number;
  constructor(private o: ClientOpts) {
    if (!o.bearerToken && (!o.clientId || !o.apiKey)) throw new Error("clientId and apiKey are required");
    this.f = o.fetchImpl ?? fetch; this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.base = o.baseUrl ?? "https://api.sandbox.airwallex.com";
    this.maxRps = o.maxRps ?? 8; // docs: 20 rps global, 10 per endpoint
  }
  private async throttle() {
    for (;;) {
      const t = this.now(); this.stamps = this.stamps.filter((s) => t - s < 1000);
      if (this.stamps.length < this.maxRps) { this.stamps.push(t); return; }
      await this.sleep(1000 - (t - this.stamps[0]) + 1);
    }
  }
  private async auth(): Promise<string> {
    if (this.o.bearerToken) return this.o.bearerToken;
    if (this.token && this.now() < this.tokenExp - 60_000) return this.token;
    await this.throttle();
    const r = await this.f(`${this.base}/api/v1/authentication/login`, { method: "POST", headers: { "x-client-id": this.o.clientId, "x-api-key": this.o.apiKey } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new AirwallexError(r.status, j.code ?? "auth_failed", j.message ?? "login failed");
    this.token = j.token; this.tokenExp = this.now() + 25 * 60_000; // refresh well inside the 30 min life
    return this.token;
  }
  // Public so run scripts can reach documented endpoints the typed helpers do not cover yet.
  // requestId should be stable per logical action (e.g. the approval nonce) so a retry after a timeout is deduplicated by Airwallex.
  async call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, requestId?: string): Promise<T> {
    // One payload for every attempt, so a retry of a POST reuses the same request_id and Airwallex deduplicates it.
    const payload = method === "POST" ? { request_id: requestId ?? randomUUID(), ...(body ?? {}) } : undefined;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth(); await this.throttle();
      const r = await this.f(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok) return j as T;
      // An expired or revoked token: log in again once. Rate limited: back off and retry (at most twice).
      if (r.status === 401 && !refreshed) { refreshed = true; this.token = ""; continue; }
      if (r.status === 429 && attempt < 2) { await this.sleep(500 * 2 ** attempt); continue; }
      throw new AirwallexError(r.status, j.code ?? "error", j.message ?? "request failed");
    }
  }

  // Issuing. Doc pages verified 6 Oct 2026.
  createCardholder(body: Record<string, unknown>, requestId?: string) {
    return this.call<any>("POST", "/api/v1/issuing/cardholders/create", body, requestId);
  }
  createCard(body: Record<string, unknown>, requestId?: string) {
    return this.call<any>("POST", "/api/v1/issuing/cards/create", body, requestId);
  }
  getCardLimits(cardId: string) {
    return this.call<any>("GET", `/api/v1/issuing/cards/${encodeURIComponent(cardId)}/limits`);
  }
  /** Freeze a card by setting its status; the same endpoint updates other card fields. */
  updateCard(cardId: string, body: Record<string, unknown>, requestId?: string) {
    return this.call<any>("POST", `/api/v1/issuing/cards/${encodeURIComponent(cardId)}/update`, body, requestId);
  }
  listTransactions(opts: { cardId?: string; size?: number } = {}) {
    const q = new URLSearchParams({ size: String(opts.size ?? 100) });
    if (opts.cardId) q.set("card_id", opts.cardId);
    return this.call<{ items: any[] }>("GET", `/api/v1/issuing/transactions?${q}`);
  }

  // Sandbox-only simulators, kept behind this one client as the guide advises.
  simCreateAuthorization(body: Record<string, unknown>, requestId?: string) {
    return this.call<any>("POST", "/api/v1/simulation/issuing/create", body, requestId);
  }
  simCapture(transactionId: string, requestId?: string) {
    // This API version captures through the transaction lifecycle id, not the transaction id.
    return this.call<any>("POST", `/api/v1/simulation/issuing/card_transaction_lifecycles/${encodeURIComponent(transactionId)}/capture`, {}, requestId);
  }
  simReverse(transactionId: string, requestId?: string) {
    return this.call<any>("POST", `/api/v1/simulation/issuing/card_transaction_lifecycles/${encodeURIComponent(transactionId)}/reverse`, {}, requestId);
  }
  simRefund(body: Record<string, unknown>, requestId?: string) {
    return this.call<any>("POST", "/api/v1/simulation/issuing/refund", body, requestId);
  }
}
