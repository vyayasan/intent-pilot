/**
 * Console authentication seam.
 *
 * AuthProvider is the interface; two implementations exist:
 *  - OidcProvider: real sign-in via OpenID Connect authorization-code + PKCE. Production
 *    requires it (config fails closed otherwise). ID tokens are verified locally: RS256
 *    signature against the IdP's JWKS, exact issuer, audience, expiry and nonce.
 *  - The demo path in server.ts (per-run random token in a meta tag) is NOT an AuthProvider
 *    and stays dev-only - it exists so the simulator demo needs no IdP.
 *
 * Sessions are opaque random ids stored server-side in memory (HttpOnly, SameSite=Lax cookie;
 * Secure + __Host- prefix in production). A restart logs everyone out - acceptable: the IdP
 * round-trip is seconds, and no bearer material ever touches disk.
 *
 * Roles: approver > operator > viewer. Approvers and viewers are named by env allowlists
 * (email or sub); any other authenticated user is an operator. Authorization decisions are
 * enforced in api.ts from identity.role.
 */
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { assertPublicEndpoint, guardedDispatcher, isLoopbackHttpUrl } from "../net/ssrf.js";
import type { Agent } from "undici";

export type Role = "viewer" | "operator" | "approver";
export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, approver: 2 };

export interface Identity {
  sub: string;
  email?: string;
  name?: string;
  provider: string;
  /** null = authenticated but NOT enrolled: denied by default. Roles come from explicit
   *  subject-bound allowlists; email entries match only a verified email claim. */
  role: Role | null;
}

export interface AuthProvider {
  readonly name: string;
  /** Authenticated identity for this request, or null. Must be cheap: runs on every API call. */
  authenticate(request: Request): Identity | null;
  /** Handles /auth/* protocol routes (login, callback, logout). Undefined = not handled. */
  route?(request: Request): Promise<Response | undefined>;
}

interface Session { identity: Identity; expiresAt: number; }

export class SessionStore {
  private sessions = new Map<string, Session>();
  constructor(private ttlMs = 12 * 60 * 60 * 1000) {}
  create(identity: Identity): string {
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, { identity, expiresAt: Date.now() + this.ttlMs });
    if (this.sessions.size > 10_000) this.sweep();
    return id;
  }
  get(id: string): Identity | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { this.sessions.delete(id); return null; }
    return s.identity;
  }
  destroy(id: string): void { this.sessions.delete(id); }
  private sweep(): void {
    const nowMs = Date.now();
    for (const [k, v] of this.sessions) if (v.expiresAt <= nowMs) this.sessions.delete(k);
  }
}

export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Secure cookie + __Host- prefix. True in production (https). */
  secureCookie: boolean;
  /** Emails or subs granted the approver role (case-insensitive). */
  approvers?: string[];
  /** Emails or subs restricted to the viewer role. Everyone else authenticated is an operator. */
  viewers?: string[];
  sessionTtlMs?: number;
  fetchImpl?: typeof fetch;
  /** DNS resolver for the resolution-time SSRF guard (tests). Defaults to the system resolver. */
  lookupAll?: Parameters<typeof guardedDispatcher>[0];
}

interface OidcDiscovery { issuer?: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; }
interface PendingAuth { verifier: string; nonce: string; returnTo: string; expiresAt: number; }

const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url");

export class OidcProvider implements AuthProvider {
  readonly name = "oidc";
  readonly sessions: SessionStore;
  private discovery?: { doc: OidcDiscovery; jwks: JSONWebKeySet["keys"]; fetchedAt: number };
  private pending = new Map<string, PendingAuth>();
  private fetchImpl: typeof fetch;
  private cookieName: string;
  private dispatcher?: Agent;
  private devIssuer: boolean;

  constructor(private opts: OidcOptions) {
    this.sessions = new SessionStore(opts.sessionTtlMs);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cookieName = opts.secureCookie ? "__Host-intentpay_session" : "intentpay_session";
    // Issuer policy: https in real use; http only for a loopback test issuer. Non-loopback
    // issuers get the resolution-time SSRF guard on every discovery/JWKS/token fetch.
    this.devIssuer = isLoopbackHttpUrl(opts.issuer);
    if (!this.devIssuer && !opts.issuer.startsWith("https:"))
      throw new Error("INTENTPAY_OIDC_ISSUER must be https (http is allowed only for loopback test issuers)");
    this.dispatcher = this.devIssuer ? undefined : guardedDispatcher(opts.lookupAll);
  }

  private guarded(input: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(input, { ...init, redirect: "error", ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}) } as RequestInit);
  }

  authenticate(request: Request): Identity | null {
    const cookie = request.headers.get("cookie") ?? "";
    for (const part of cookie.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === this.cookieName) return this.sessions.get(v.join("="));
    }
    return null;
  }

  /** Deny by default: unlisted users get no role (api.ts refuses them). Sub entries always
   *  match (issuer-scoped, stable). Email entries match ONLY a verified email claim from the
   *  bound issuer - an unverified email claim proves nothing about mailbox ownership. */
  private roleFor(sub: string, email: string | undefined, emailVerified: boolean): Role | null {
    // Subs are issuer-scoped and case-SENSITIVE (exact match); emails match case-insensitively
    // and only when verified (review: case-insensitive sub matching widened membership).
    const match = (list?: string[]) =>
      !!list?.some((e) =>
        e === sub || (emailVerified && !!email && e.toLowerCase() === email.toLowerCase()));
    if (match(this.opts.approvers)) return "approver";
    if (match(this.opts.viewers)) return "viewer";
    return null;
  }

  private cookieHeader(value: string, maxAgeSeconds: number): string {
    const parts = [`${this.cookieName}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
    if (this.opts.secureCookie) parts.push("Secure");
    return parts.join("; ");
  }

  private async discoveryDoc(): Promise<{ doc: OidcDiscovery; jwks: JSONWebKeySet["keys"] }> {
    if (this.discovery && Date.now() - this.discovery.fetchedAt < 5 * 60_000) return this.discovery;
    const issuer = this.opts.issuer.replace(/\/$/, "");
    // Endpoint trust: the discovery doc's issuer must match; discovered endpoints must be
    // https + non-private (http only for loopback test issuers); fetches never follow redirects
    // (a redirect could aim the client_secret at another host) and run through the
    // resolution-time SSRF guard. Same-origin is NOT required - real IdPs span origins
    // (Google: accounts.google.com / oauth2.googleapis.com / www.googleapis.com).
    const res = await this.guarded(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    const doc = (await res.json()) as OidcDiscovery;
    if (doc.issuer && doc.issuer.replace(/\/$/, "") !== issuer) throw new Error("OIDC discovery issuer mismatch");
    for (const endpoint of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri])
      assertPublicEndpoint(String(endpoint), { allowHttpLoopback: this.devIssuer });
    const jwksRes = await this.guarded(doc.jwks_uri, { signal: AbortSignal.timeout(10_000) });
    if (!jwksRes.ok) throw new Error(`OIDC JWKS fetch failed: HTTP ${jwksRes.status}`);
    const jwks = ((await jwksRes.json()) as JSONWebKeySet).keys;
    this.discovery = { doc, jwks, fetchedAt: Date.now() };
    return this.discovery;
  }

  async route(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/auth/login" && request.method === "GET") return this.login(url);
    if (url.pathname === "/auth/callback" && request.method === "GET") return this.callback(url);
    // Logout is state-changing: POST only, with an Origin check (a bare GET would be a
    // one-pixel logout-CSRF - review).
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(this.opts.redirectUri).origin)
        return new Response(JSON.stringify({ error: "origin not allowed" }), { status: 403, headers: { "content-type": "application/json; charset=utf-8" } });
      return this.logout(request);
    }
    return undefined;
  }

  private async login(url: URL): Promise<Response> {
    const returnTo = url.searchParams.get("return_to") ?? "/";
    // Open-redirect guard: local paths only.
    const safeReturn = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    // Bounded + swept: an unbounded pending map is a memory-exhaustion vector (review).
    for (const [k, v] of this.pending) if (v.expiresAt <= Date.now()) this.pending.delete(k);
    if (this.pending.size >= 10_000) return new Response(JSON.stringify({ error: "too many sign-in attempts in flight - retry shortly" }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } });
    this.pending.set(state, { verifier, nonce, returnTo: safeReturn, expiresAt: Date.now() + 10 * 60_000 });
    let doc: OidcDiscovery;
    try { ({ doc } = await this.discoveryDoc()); }
    catch { return new Response(JSON.stringify({ error: "identity provider configuration untrusted or unreachable" }), { status: 502, headers: { "content-type": "application/json; charset=utf-8" } }); }
    const target = new URL(doc.authorization_endpoint);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("client_id", this.opts.clientId);
    target.searchParams.set("redirect_uri", this.opts.redirectUri);
    target.searchParams.set("scope", "openid email profile");
    target.searchParams.set("state", state);
    target.searchParams.set("nonce", nonce);
    target.searchParams.set("code_challenge", challenge);
    target.searchParams.set("code_challenge_method", "S256");
    return new Response(null, { status: 302, headers: { location: target.toString() } });
  }

  private async callback(url: URL): Promise<Response> {
    const fail = (msg: string, status = 400) => new Response(JSON.stringify({ error: msg }), { status, headers: { "content-type": "application/json; charset=utf-8" } });
    const errParam = url.searchParams.get("error");
    if (errParam) return fail(`sign-in refused by the identity provider (${errParam})`, 401);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const pending = this.pending.get(state);
    if (!pending || !code) return fail("invalid or expired sign-in state");
    this.pending.delete(state); // one-time use
    if (pending.expiresAt <= Date.now()) return fail("sign-in state expired");

    let doc: OidcDiscovery, jwks: JSONWebKeySet["keys"];
    try { ({ doc, jwks } = await this.discoveryDoc()); } catch { return fail("identity provider unreachable", 502); }

    const body = new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: this.opts.redirectUri,
      client_id: this.opts.clientId, client_secret: this.opts.clientSecret, code_verifier: pending.verifier
    });
    let tokenRes: Response;
    try {
      tokenRes = await this.guarded(doc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(10_000) });
    } catch { return fail("identity provider unreachable", 502); }
    if (!tokenRes.ok) return fail("token exchange refused by the identity provider", 401);
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) return fail("identity provider returned no id_token", 502);

    const identity = await this.verifyIdToken(tokens.id_token, this.opts.issuer.replace(/\/$/, ""), jwks, pending.nonce)
      ?? await (async () => {
        // A kid we do not know: refresh the JWKS once (key rotation) before giving up.
        const fresh = await this.guarded(doc.jwks_uri, { signal: AbortSignal.timeout(10_000) });
        if (!fresh.ok) return null;
        const keys = ((await fresh.json()) as JSONWebKeySet).keys;
        this.discovery = { doc, jwks: keys, fetchedAt: Date.now() };
        return this.verifyIdToken(tokens.id_token!, this.opts.issuer.replace(/\/$/, ""), keys, pending.nonce); // awaited by caller
      })();
    if (!identity) return fail("id_token verification failed", 401);

    const sessionId = this.sessions.create(identity);
    return new Response(null, { status: 302, headers: { location: pending.returnTo, "set-cookie": this.cookieHeader(sessionId, Math.floor((this.opts.sessionTtlMs ?? 12 * 60 * 60 * 1000) / 1000)) } });
  }

  private logout(request: Request): Response {
    const identity = this.authenticate(request);
    const cookie = request.headers.get("cookie") ?? "";
    for (const part of cookie.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === this.cookieName) this.sessions.destroy(v.join("="));
    }
    void identity;
    return new Response(null, { status: 302, headers: { location: "/", "set-cookie": this.cookieHeader("", 0) } });
  }

  /**
   * ID-token verification via jose (maintained, zero-dep): RS256 only, exact issuer, audience,
   * exp/nbf with 60s clock tolerance. Plus rules jose does not own: azp required when aud has
   * multiple entries, nonce echo required (we always send one), sub required, and email only
   * trusted when email_verified === true.
   */
  private async verifyIdToken(token: string, issuer: string, jwks: JSONWebKeySet["keys"], nonce: string): Promise<Identity | null> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, createLocalJWKSet({ keys: jwks }), {
        issuer,
        audience: this.opts.clientId,
        algorithms: ["RS256"],
        clockTolerance: 60
      }));
    } catch { return null; }
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.opts.clientId) return null;
    if (payload.nonce !== nonce) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    const emailVerified = payload.email_verified === true;
    const email = typeof payload.email === "string" ? payload.email : undefined;
    return {
      sub: payload.sub,
      email,
      name: typeof payload.name === "string" ? payload.name : undefined,
      provider: `oidc:${issuer}`,
      role: this.roleFor(payload.sub, email, emailVerified)
    };
  }
}
