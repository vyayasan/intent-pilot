// Google sign-in proof without a long-lived server: the console's pending map is in-memory,
// but the OAuth/PKCE exchange itself is stateless given the verifier. This script mints the
// same consent URL the console's /auth/login builds (state, nonce, PKCE S256) with the state
// file on disk, then completes the exchange when the pasted callback URL comes back. It
// applies the same verification rules as src/console/auth.ts: discovery+issuer match, JWKS
// RS256 only, exact issuer/audience, azp when multi-aud, nonce echo, sub, email only when
// email_verified. The client secret comes from the environment and is never logged or written.
// Usage:
//   INTENTPAY_OIDC_CLIENT_ID=... INTENTPAY_OIDC_CLIENT_SECRET=... npx tsx scripts/signin-exchange.ts --mint
//   INTENTPAY_OIDC_CLIENT_ID=... INTENTPAY_OIDC_CLIENT_SECRET=... npx tsx scripts/signin-exchange.ts --complete "<pasted localhost callback URL>"
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, mkdirSync, appendFileSync } from "node:fs";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";

const ISSUER = "https://accounts.google.com";
const REDIRECT_URI = "http://localhost:8787/auth/callback";
const STATE_FILE = "runs/signin-exchange-state.json";
const LOG = "runs/signin-exchange.jsonl";
const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url");
const clientId = process.env.INTENTPAY_OIDC_CLIENT_ID;
const clientSecret = process.env.INTENTPAY_OIDC_CLIENT_SECRET;
if (!clientId || !clientSecret) throw new Error("INTENTPAY_OIDC_CLIENT_ID and INTENTPAY_OIDC_CLIENT_SECRET are required (secret from the vault file, never typed)");
mkdirSync("runs", { recursive: true });
const log = (rec: Record<string, unknown>) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n");

async function discovery() {
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  const doc = (await res.json()) as { issuer?: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
  if (doc.issuer && doc.issuer.replace(/\/$/, "") !== ISSUER) throw new Error("OIDC discovery issuer mismatch");
  for (const e of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri])
    if (!String(e).startsWith("https://")) throw new Error(`non-https endpoint in discovery: ${e}`);
  return doc;
}

if (process.argv.includes("--mint")) {
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  writeFileSync(STATE_FILE, JSON.stringify({ state, nonce, verifier, mintedAt: new Date().toISOString() }), { mode: 0o600 });
  try { chmodSync(STATE_FILE, 0o600); } catch { /* best effort */ }
  const doc = await discovery();
  const target = new URL(doc.authorization_endpoint);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", clientId);
  target.searchParams.set("redirect_uri", REDIRECT_URI);
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state);
  target.searchParams.set("nonce", nonce);
  target.searchParams.set("code_challenge", challenge);
  target.searchParams.set("code_challenge_method", "S256");
  log({ phase: "mint", clientId });
  console.log(target.toString());
} else {
  const i = process.argv.indexOf("--complete");
  const pasted = i >= 0 ? process.argv[i + 1] : undefined;
  if (!pasted) throw new Error('pass the pasted callback URL after --complete, quoted');
  const saved = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { state: string; nonce: string; verifier: string; mintedAt: string };
  if (Date.now() - new Date(saved.mintedAt).getTime() > 10 * 60_000) throw new Error("minted state older than 10 minutes - mint again");
  const u = new URL(pasted.trim());
  const state = u.searchParams.get("state") ?? "";
  const code = u.searchParams.get("code") ?? "";
  const errParam = u.searchParams.get("error");
  if (errParam) throw new Error(`sign-in refused by the identity provider (${errParam})`);
  if (!code || state !== saved.state) throw new Error("state mismatch or missing code - not completing (possible mix-up or CSRF)");
  const doc = await discovery();
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, client_secret: clientSecret, code_verifier: saved.verifier });
  const tokenRes = await fetch(doc.token_endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(10_000) });
  if (!tokenRes.ok) { log({ phase: "complete", ok: false, tokenStatus: tokenRes.status }); throw new Error(`token exchange refused by the identity provider (HTTP ${tokenRes.status})`); }
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("identity provider returned no id_token");
  const verifyWith = async (keys: JSONWebKeySet["keys"]): Promise<JWTPayload | null> => {
    try {
      const { payload } = await jwtVerify(tokens.id_token!, createLocalJWKSet({ keys }), { issuer: ISSUER, audience: clientId, algorithms: ["RS256"], clockTolerance: 60 });
      return payload;
    } catch { return null; }
  };
  const jwksRes = await fetch(doc.jwks_uri, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!jwksRes.ok) throw new Error(`JWKS fetch failed: HTTP ${jwksRes.status}`);
  let payload = await verifyWith(((await jwksRes.json()) as JSONWebKeySet).keys);
  if (!payload) { // one JWKS refresh for key rotation, same rule as auth.ts
    const fresh = await fetch(doc.jwks_uri, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (fresh.ok) payload = await verifyWith(((await fresh.json()) as JSONWebKeySet).keys);
  }
  if (!payload) { log({ phase: "complete", ok: false, reason: "id_token verification failed" }); throw new Error("id_token failed verification (signature/issuer/audience/expiry)"); }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) throw new Error("multi-audience id_token without matching azp - rejected");
  if (payload.nonce !== saved.nonce) throw new Error("nonce mismatch - rejected");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("no sub - rejected");
  const emailVerified = payload.email_verified === true;
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const approvers = (process.env.INTENTPAY_OIDC_APPROVERS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const role = emailVerified && email && approvers.includes(email.toLowerCase()) ? "approver" : approvers.includes(payload.sub) ? "approver" : "NO ROLE (refused by the console rule: deny by default)";
  log({ phase: "complete", ok: true, sub: payload.sub, email, emailVerified, role });
  console.log(JSON.stringify({ ok: true, sub: payload.sub, email, emailVerified, name: payload.name ?? null, role, issuer: ISSUER, clientId }, null, 2));
}
