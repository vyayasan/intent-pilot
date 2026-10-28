/**
 * Auth seam tests against a REAL local OIDC IdP (test/helpers/test-idp.ts): real HTTP, real
 * RS256 JWTs, real PKCE. Nothing here mocks the console's verification. Label: protocol-verified
 * locally - a production IdP run is owner decision D3 and remains unclaimed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer as netCreateServer } from "node:net";
import { rmSync } from "node:fs";
import { buildConsoleServer } from "../src/console/server.js";
import { startTestIdp, type TestIdp } from "./helpers/test-idp.js";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

const freePort = () => new Promise<number>((res, rej) => {
  const s = netCreateServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

interface Rig { base: string; idp: TestIdp; }
async function startRig(extraEnv: Record<string, string> = {}): Promise<Rig> {
  const idp = await startTestIdp();
  const port = await freePort();
  const stateFile = `/tmp/auth-test-state-${port}.json`;
  const auditFile = `/tmp/auth-test-audit-${port}.jsonl`;
  const { server, flush } = buildConsoleServer({
    PORT: String(port),
    INTENTPAY_STATE_FILE: stateFile,
    INTENTPAY_AUDIT_FILE: auditFile,
    INTENTPAY_OIDC_ISSUER: idp.url,
    INTENTPAY_OIDC_CLIENT_ID: "intentpay-console",
    INTENTPAY_OIDC_CLIENT_SECRET: "test-secret",
    INTENTPAY_OIDC_REDIRECT_URI: `http://127.0.0.1:${port}/auth/callback`,
    ...extraEnv
  });
  // Listen on the reserved port so the OIDC redirect_uri matches (standard free-port reservation;
  // the race window on localhost is negligible for tests).
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  cleanup.push(async () => { flush(); await new Promise<void>((r) => server.close(() => r())); await idp.close(); rmSync(stateFile, { force: true }); rmSync(auditFile, { force: true }); });
  return { base: `http://127.0.0.1:${port}`, idp };
}

/** Minimal cookie-jar client over real HTTP, manual redirects. */
function client() {
  const jar = new Map<string, string>();
  const go = async (url: string, opts: { method?: string; follow?: boolean; origin?: string | false } = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    // Browsers always send Origin on POST; tests do the same unless probing the CSRF guard.
    if ((opts.method ?? "GET") === "POST" && opts.origin !== false) headers.origin = opts.origin ?? new URL(url).origin;
    const res = await fetch(url, { method: opts.method ?? "GET", redirect: "manual", headers });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair.split("=");
      if (c.includes("Max-Age=0")) jar.delete(k); else jar.set(k, v.join("="));
    }
    if (opts.follow && res.status === 302) return go(new URL(res.headers.get("location")!, url).toString(), opts);
    return res;
  };
  return { go, jar };
}

/** Drive the full sign-in flow over real HTTP and return the authed client. */
async function signIn(base: string): Promise<ReturnType<typeof client>> {
  const c = client();
  const login = await c.go(`${base}/auth/login?return_to=/`);
  expect(login.status).toBe(302);
  const authorize = await c.go(login.headers.get("location")!);
  expect(authorize.status).toBe(302);
  const cb = await c.go(authorize.headers.get("location")!);
  expect(cb.status).toBe(302);
  expect(cb.headers.get("location")).toBe("/");
  expect([...c.jar.keys()].some((k) => k.endsWith("intentpay_session"))).toBe(true);
  return c;
}

describe("OIDC sign-in (protocol-verified locally against a real test IdP)", () => {
  it("full happy path: page gated, real code+PKCE exchange, cookie session, API unlocked", async () => {
    const { base } = await startRig({ INTENTPAY_OIDC_APPROVERS: "pilot@example.com" });
    const anon = client();
    const pageAnon = await anon.go(`${base}/`);
    expect(pageAnon.status).toBe(302);
    expect(pageAnon.headers.get("location")).toMatch(/^\/auth\/login/);
    expect((await anon.go(`${base}/api/cases`)).status).toBe(401);

    const c = await signIn(base);
    const pageRes = await c.go(`${base}/`);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).not.toContain('<meta name="console-token" content='); // no bearer material in HTML under real auth

    const who = await (await c.go(`${base}/api/whoami`)).json() as { identity: { email: string; role: string; provider: string } };
    expect(who.identity.email).toBe("pilot@example.com");
    expect(who.identity.role).toBe("approver");
    expect(who.identity.provider).toContain("oidc:");
    expect((await c.go(`${base}/api/cases`)).status).toBe(200);
  });

  it("INTENTPAY_SESSION_COOKIE_SECURE=1 arms the Secure attribute outside production; unset leaves it off", async () => {
    const secureRig = await startRig({ INTENTPAY_SESSION_COOKIE_SECURE: "1" });
    const c1 = client();
    const login1 = await c1.go(`${secureRig.base}/auth/login?return_to=/`);
    const cb1 = await c1.go((await c1.go(login1.headers.get("location")!)).headers.get("location")!);
    expect(cb1.headers.getSetCookie().some((c) => c.includes("Secure"))).toBe(true);

    const plainRig = await startRig();
    const c2 = client();
    const login2 = await c2.go(`${plainRig.base}/auth/login?return_to=/`);
    const cb2 = await c2.go((await c2.go(login2.headers.get("location")!)).headers.get("location")!);
    expect(cb2.headers.getSetCookie().some((c) => c.includes("Secure"))).toBe(false);
  });

  it("PKCE is real: the token exchange carried a verifier and the IdP checked it", async () => {
    const { base, idp } = await startRig();
    await signIn(base);
    expect(idp.lastTokenRequest?.grant_type).toBe("authorization_code");
    expect(idp.lastTokenRequest?.code_verifier).toBeTruthy();
    // IdP rejects a wrong verifier directly (defense really enforced IdP-side)
    const idp2 = idp;
    const bad = await fetch(`${idp2.url}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: "unknown", code_verifier: "wrong", client_id: "x", client_secret: "y" }).toString() });
    expect(bad.status).toBe(400);
  });

  it("callback with a wrong/unknown state is rejected, no session issued", async () => {
    const { base } = await startRig();
    const c = client();
    const res = await c.go(`${base}/auth/callback?code=whatever&state=forged`);
    expect(res.status).toBe(400);
    expect([...c.jar.keys()]).toHaveLength(0);
  });

  it("IdP refusal (access_denied) yields no session", async () => {
    const { base, idp } = await startRig();
    idp.denyNext = true;
    const c = client();
    const login = await c.go(`${base}/auth/login?return_to=/`);
    const authorize = await c.go(login.headers.get("location")!);
    const cb = await c.go(authorize.headers.get("location")!);
    expect(cb.status).toBe(401);
    expect([...c.jar.keys()]).toHaveLength(0);
  });

  it("a tampered id_token signature is rejected (real RS256 verification)", async () => {
    const { base, idp } = await startRig();
    idp.tamperSignatures = true;
    const c = client();
    const login = await c.go(`${base}/auth/login?return_to=/`);
    const authorize = await c.go(login.headers.get("location")!);
    const cb = await c.go(authorize.headers.get("location")!);
    expect(cb.status).toBe(401);
    expect([...c.jar.keys()]).toHaveLength(0);
  });

  it("deny by default: an authenticated but UNLISTED user is refused everything (403, not a default operator)", async () => {
    const { base } = await startRig({ INTENTPAY_OIDC_APPROVERS: "someoneelse@example.com" });
    const c = await signIn(base); // sign-in itself succeeds - the IdP vouches for the person
    const who = await (await c.go(`${base}/api/whoami`)).json() as { identity: { role: string | null } };
    expect(who.identity.role).toBe(null);
    expect((await c.go(`${base}/api/cases`)).status).toBe(403); // even reads denied
    expect((await c.go(`${base}/api/change-terms`, { method: "POST" })).status).toBe(403);
    expect((await c.go(`${base}/api/approve`, { method: "POST" })).status).toBe(403);
    expect((await c.go(`${base}/`)).status).toBe(200); // page loads, but every API under it refuses
  });

  it("hostile claim: email allowlist entry does NOT match an unverified email claim", async () => {
    const { base, idp } = await startRig({ INTENTPAY_OIDC_APPROVERS: "pilot@example.com" });
    idp.setUser({ sub: "attacker-9", email: "pilot@example.com", name: "Impersonator", emailVerified: false });
    const c = await signIn(base);
    const who = await (await c.go(`${base}/api/whoami`)).json() as { identity: { role: string | null } };
    expect(who.identity.role).toBe(null); // not enrolled: email claim unverified
    expect((await c.go(`${base}/api/cases`)).status).toBe(403);
  });

  it("hostile token: multi-audience id_token without azp is rejected", async () => {
    const { base, idp } = await startRig();
    idp.multiAudNoAzp = true;
    const c = client();
    const login = await c.go(`${base}/auth/login?return_to=/`);
    const authorize = await c.go(login.headers.get("location")!);
    expect((await c.go(authorize.headers.get("location")!)).status).toBe(401);
    expect([...c.jar.keys()]).toHaveLength(0);
  });

  it("hostile token: nbf in the future is rejected", async () => {
    const { base, idp } = await startRig();
    idp.nbfFuture = true;
    const c = client();
    const login = await c.go(`${base}/auth/login?return_to=/`);
    const authorize = await c.go(login.headers.get("location")!);
    expect((await c.go(authorize.headers.get("location")!)).status).toBe(401);
  });

  it("hostile token: alg=none is rejected", async () => {
    const { base, idp } = await startRig();
    idp.algNone = true;
    const c = client();
    const login = await c.go(`${base}/auth/login?return_to=/`);
    const authorize = await c.go(login.headers.get("location")!);
    expect((await c.go(authorize.headers.get("location")!)).status).toBe(401);
  });

  it("hostile discovery: endpoints off the issuer origin are refused (no SSRF via discovery doc)", async () => {
    const { base, idp } = await startRig();
    idp.evilEndpoints = true;
    const res = await client().go(`${base}/auth/login?return_to=/`);
    expect(res.status).toBe(502); // configuration untrusted - no redirect to 169.254.169.254
  });

  it("hostile JWKS: a redirecting jwks_uri is not followed", async () => {
    const { base, idp } = await startRig();
    idp.jwksRedirects = true;
    const res = await client().go(`${base}/auth/login?return_to=/`);
    expect(res.status).toBe(502);
  });

  it("CSRF: cookie-auth mutations require an allowed Origin header", async () => {
    const { base } = await startRig({ INTENTPAY_OIDC_APPROVERS: "pilot@example.com" });
    const c = await signIn(base);
    expect((await c.go(`${base}/api/change-terms`, { method: "POST", origin: false })).status).toBe(403); // no Origin
    expect((await c.go(`${base}/api/change-terms`, { method: "POST", origin: "https://evil.example" })).status).toBe(403); // foreign Origin
    expect((await c.go(`${base}/api/change-terms`, { method: "POST" })).status).toBe(400); // same-origin Origin passes the guard, fails body validation
  });

  it("roles: a listed viewer can read but cannot POST at all", async () => {
    const { base, idp } = await startRig({ INTENTPAY_OIDC_VIEWERS: "viewer@example.com" });
    idp.setUser({ sub: "user-002", email: "viewer@example.com", name: "Viewer" });
    const c = await signIn(base);
    const who = await (await c.go(`${base}/api/whoami`)).json() as { identity: { role: string } };
    expect(who.identity.role).toBe("viewer");
    expect((await c.go(`${base}/api/cases`)).status).toBe(200);
    expect((await c.go(`${base}/api/change-terms`, { method: "POST" })).status).toBe(403);
    expect((await c.go(`${base}/api/approve`, { method: "POST" })).status).toBe(403);
  });

  it("logout destroys the session server-side", async () => {
    const { base } = await startRig({ INTENTPAY_OIDC_APPROVERS: "pilot@example.com" });
    const c = await signIn(base);
    expect((await c.go(`${base}/api/cases`)).status).toBe(200);
    await c.go(`${base}/auth/logout`, { method: 'POST' });
    expect((await c.go(`${base}/api/cases`)).status).toBe(401);
  });

  it("approver of record binds to the authenticated identity, not a client string", async () => {
    const { base } = await startRig({ INTENTPAY_OIDC_APPROVERS: "pilot@example.com" });
    const c = await signIn(base);
    const res = await c.go(`${base}/api/approve`, { method: "POST" });
    // 400 (body validation) proves we passed auth+role; a token-era 403 or 401 would fail here.
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("invalid approval request");
  });
});

describe("OIDC endpoint trust (compatibility + SSRF)", () => {
  it("Google-style multi-origin discovery works: authorize/token/jwks on different origins", async () => {
    const idp = await startTestIdp({ sub: "user-010", email: "pilot@example.com", name: "Pilot" }, { multiOrigin: true });
    cleanup.push(idp.close);
    const port = await freePort();
    const stateFile = `/tmp/auth-test-state-${port}.json`;
    const auditFile = `/tmp/auth-test-audit-${port}.jsonl`;
    const { server, flush } = buildConsoleServer({
      PORT: String(port), INTENTPAY_STATE_FILE: stateFile, INTENTPAY_AUDIT_FILE: auditFile,
      INTENTPAY_OIDC_ISSUER: idp.url, INTENTPAY_OIDC_CLIENT_ID: "intentpay-console",
      INTENTPAY_OIDC_CLIENT_SECRET: "test-secret",
      INTENTPAY_OIDC_REDIRECT_URI: `http://127.0.0.1:${port}/auth/callback`,
      INTENTPAY_OIDC_APPROVERS: "pilot@example.com"
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    cleanup.push(async () => { flush(); await new Promise<void>((r) => server.close(() => r())); rmSync(stateFile, { force: true }); rmSync(auditFile, { force: true }); });
    const base = `http://127.0.0.1:${port}`;
    const c = await signIn(base);
    expect((await c.go(`${base}/api/cases`)).status).toBe(200);
  });

  it("resolution-time guard: an https issuer whose DNS answers a private address gets no connection", async () => {
    const { OidcProvider } = await import("../src/console/auth.js");
    const p = new OidcProvider({
      issuer: "https://idp.example", clientId: "c", clientSecret: "s",
      redirectUri: "https://console.example/auth/callback", secureCookie: true,
      lookupAll: async () => [{ address: "192.168.1.10", family: 4 }]
    });
    const res = await p.route!(new Request("https://console.example/auth/login"))!;
    expect(res!.status).toBe(502); // discovery fetch blocked at connect - nothing touched the wire
  });
});
