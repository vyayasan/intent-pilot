/**
 * A REAL local OIDC identity provider for tests: real HTTP, real discovery, real JWKS, real
 * RS256 signatures (node:crypto), real PKCE verification. This is NOT a mock of the console's
 * verification - the console must do everything a production IdP requires. What it is NOT:
 * a production IdP - results are labelled "protocol-verified locally" (needs D3 for the real one).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, createSign, generateKeyPairSync, randomBytes, type JsonWebKey, type KeyObject } from "node:crypto";

export interface TestIdpUser { sub: string; email: string; name: string; emailVerified?: boolean; }

export interface TestIdp {
  url: string;
  kid: string;
  /** Issue id_tokens with a broken signature (attacker path). */
  tamperSignatures: boolean;
  /** Refuse the next /authorize with error=access_denied. */
  denyNext: boolean;
  /** Issue tokens with aud = [clientId, "someone-else"] and no azp. */
  multiAudNoAzp: boolean;
  /** Issue tokens with nbf one hour in the future. */
  nbfFuture: boolean;
  /** Issue unsigned alg=none tokens. */
  algNone: boolean;
  /** Discovery doc points endpoints off-origin (SSRF probe). */
  evilEndpoints: boolean;
  /** /jwks answers with a 302 (redirect-trust probe). */
  jwksRedirects: boolean;
  /** Discovery advertises endpoints on OTHER origins (Google-style layout). */
  multiOrigin: boolean;
  /** The user the next /authorize logs in (switch via setUser). */
  setUser(u: TestIdpUser): void;
  lastTokenRequest?: Record<string, string>;
  close(): Promise<void>;
}

const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url");

export async function startTestIdp(
  user: TestIdpUser = { sub: "user-001", email: "pilot@example.com", name: "Pilot User" },
  opts: { multiOrigin?: boolean } = {}
): Promise<TestIdp> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const kid = "test-key-1";
  const codes = new Map<string, { challenge: string; nonce: string; clientId: string }>();
  let current = user;

  const state: TestIdp = {
    url: "", kid, tamperSignatures: false, denyNext: false, multiAudNoAzp: false, nbfFuture: false, algNone: false, evilEndpoints: false, jwksRedirects: false, multiOrigin: opts.multiOrigin === true,
    setUser(u) { current = u; },
    async close() { await new Promise<void>((r) => server.close(() => r())); }
  };

  const sign = (payload: Record<string, unknown>, priv: KeyObject): string => {
    const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
    const body = b64url(Buffer.from(JSON.stringify(payload)));
    const s = createSign("RSA-SHA256");
    s.update(`${header}.${body}`);
    return `${header}.${body}.${b64url(s.sign(priv))}`;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/openid-configuration") {
      const authzBase = state.evilEndpoints ? "http://169.254.169.254" : state.multiOrigin ? altUrls[0] : state.url;
      const apiBase = state.evilEndpoints ? "http://169.254.169.254" : state.multiOrigin ? altUrls[1] : state.url;
      return json(200, {
        issuer: state.url,
        authorization_endpoint: `${authzBase}/authorize`,
        token_endpoint: `${apiBase}/token`,
        jwks_uri: `${apiBase}/jwks`
      });
    }
    if (url.pathname === "/jwks") {
      if (state.jwksRedirects) { res.writeHead(302, { location: "http://169.254.169.254/jwks" }); return res.end(); }
      return json(200, { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const st = url.searchParams.get("state") ?? "";
      if (state.denyNext) { state.denyNext = false; res.writeHead(302, { location: `${redirectUri}?error=access_denied&state=${encodeURIComponent(st)}` }); return res.end(); }
      for (const p of ["client_id", "redirect_uri", "code_challenge", "nonce"]) if (!url.searchParams.get(p)) return json(400, { error: `missing ${p}` });
      if (url.searchParams.get("code_challenge_method") !== "S256") return json(400, { error: "S256 required" });
      const code = b64url(randomBytes(24));
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, nonce: url.searchParams.get("nonce")!, clientId: url.searchParams.get("client_id")! });
      res.writeHead(302, { location: `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(st)}` });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()).entries());
      state.lastTokenRequest = form;
      const pending = codes.get(form.code ?? "");
      if (!pending) return json(400, { error: "invalid_grant" });
      codes.delete(form.code ?? ""); // one-time use
      if (form.grant_type !== "authorization_code") return json(400, { error: "unsupported_grant_type" });
      if (form.client_id !== pending.clientId || !form.client_secret) return json(401, { error: "invalid_client" });
      const computed = b64url(createHash("sha256").update(form.code_verifier ?? "").digest());
      if (computed !== pending.challenge) return json(400, { error: "invalid_grant", detail: "PKCE verification failed" });
      const nowSec = Math.floor(Date.now() / 1000);
      if (state.algNone) {
        const noneTok = `${b64url(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })))}.${b64url(Buffer.from(JSON.stringify({ iss: state.url, sub: current.sub, aud: pending.clientId, exp: nowSec + 300, iat: nowSec, nonce: pending.nonce, email: current.email })))}.`;
        return json(200, { id_token: noneTok, access_token: "x", token_type: "Bearer", expires_in: 300 });
      }
      const idToken = sign({
        iss: state.url, sub: current.sub,
        aud: state.multiAudNoAzp ? [pending.clientId, "someone-else"] : pending.clientId,
        exp: nowSec + 300, iat: nowSec, nonce: pending.nonce,
        ...(state.nbfFuture ? { nbf: nowSec + 3600 } : {}),
        email: current.email, name: current.name,
        email_verified: current.emailVerified !== false
      }, state.tamperSignatures ? (generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey) : privateKey);
      return json(200, { id_token: idToken, access_token: b64url(randomBytes(16)), token_type: "Bearer", expires_in: 300 });
    }
    json(404, { error: "not found" });
  });

  // Google-style multi-origin layout: endpoints live on sibling origins (different ports).
  const altUrls: string[] = [];
  const extra: Server[] = [];
  if (state.multiOrigin) {
    for (let i = 0; i < 2; i++) {
      const alt: Server = createServer((req, res) => server.emit("request", req, res));
      await new Promise<void>((r) => alt.listen(0, "127.0.0.1", r));
      altUrls.push(`http://127.0.0.1:${(alt.address() as AddressInfo).port}`);
      extra.push(alt);
    }
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const baseClose = state.close.bind(state);
  state.close = async () => { await baseClose(); for (const a of extra) await new Promise<void>((r) => a.close(() => r())); };
  return state;
}
