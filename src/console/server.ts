import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createConsoleApi } from "./api.js";
import { validateConsoleConfig } from "./config.js";
import { OidcProvider } from "./auth.js";
import { AllowlistMailTransport, DryRunTransport, HttpMailTransport } from "../notify/transport.js";
import { GmailApiTransport } from "../notify/gmailTransport.js";
import { page, pageCss, pageJs } from "./page.js";
import { DropCreateResponseGateway } from "../gateway/drop-create.js";
import { AuditLog } from "../audit/audit.js";
import { AirwallexClient } from "../gateway/airwallex.js";
import { LiveIssuingGateway } from "../gateway/live.js";
import { DEFAULT_MODEL, modelFromEnv } from "../agent/model.js";
import { makeSim } from "../sim/simGateway.js";
import { extractTerms } from "../agent/planner.js";

const MAX_BODY_BYTES = 256 * 1024; // vendor terms are small; a larger body is an attack or a bug

// Approval HMAC key (round-2): a per-boot random key silently invalidates every outstanding
// approval on restart. Production loads or creates a persisted 0600 key file (or takes
// INTENTPAY_HMAC_KEY); the demo keeps the per-boot key - restart-invalidated approvals are
// fail-closed and acceptable there.
function loadOrCreateHmacKey(file: string): string {
  if (existsSync(file)) {
    const k = readFileSync(file, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(k)) throw new Error(`HMAC key file ${file} is malformed - refusing to boot`);
    return k;
  }
  const k = randomBytes(32).toString("hex");
  writeFileSync(file, k, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return k;
}
const SECURITY_HEADERS: Record<string, string> = {
  // No inline script at all: the console JS is served from /console.js (script-src 'self'),
  // so injected markup can never execute. Style attributes still need style-src 'unsafe-inline'
  // (presentational only, no script execution); the stylesheet itself is same-origin.
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin"
};

export function buildConsoleServer(env: NodeJS.ProcessEnv = process.env) {
  const { errors, warnings, production } = validateConsoleConfig(env);
  for (const w of warnings) console.warn(`config warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`config error: ${e}`);
    throw new Error(`invalid console configuration (${errors.length} error${errors.length === 1 ? "" : "s"})`);
  }

  const PORT = Number(env.PORT ?? 3000);

  // Real sign-in. When the OIDC block is configured (mandatory in production), the console
  // authenticates with authorization-code + PKCE and server-side sessions in HttpOnly cookies.
  // Without OIDC config the console is DEMO-ONLY: a per-run random token in the page meta tag -
  // never production auth, and production config validation fails closed without OIDC.
  const splitList = (v?: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const oidc = env.INTENTPAY_OIDC_ISSUER && env.INTENTPAY_OIDC_CLIENT_ID && env.INTENTPAY_OIDC_CLIENT_SECRET && env.INTENTPAY_OIDC_REDIRECT_URI
    ? new OidcProvider({
        issuer: env.INTENTPAY_OIDC_ISSUER, clientId: env.INTENTPAY_OIDC_CLIENT_ID,
        clientSecret: env.INTENTPAY_OIDC_CLIENT_SECRET, redirectUri: env.INTENTPAY_OIDC_REDIRECT_URI,
        // Secure cookies follow https: mandatory in production, opt-in elsewhere via
        // INTENTPAY_SESSION_COOKIE_SECURE=1 (a real-OIDC preview over an https tunnel needs it).
        secureCookie: production || env.INTENTPAY_SESSION_COOKIE_SECURE === "1",
        approvers: splitList(env.INTENTPAY_OIDC_APPROVERS),
        viewers: splitList(env.INTENTPAY_OIDC_VIEWERS)
      })
    : undefined;
  if (production && !oidc) throw new Error("production requires the INTENTPAY_OIDC_* block (real sign-in); refusing to boot");
  const sessionToken = oidc ? undefined : randomBytes(24).toString("hex");
  let serverRef: Server | undefined;
  // Demo mode derives host/origin allowlists from the ACTUAL bound port, so an ephemeral port
  // (PORT=0 in tests) is still covered. An explicit env list wins in ANY mode (production requires
  // one): the exact-match list is the principled boundary for a real-OIDC preview on a tunnel
  // host, never a wildcard.
  const currentHosts = () => {
    const a = serverRef?.address();
    const p = a && typeof a === "object" ? a.port : PORT;
    return [`localhost:${p}`, `127.0.0.1:${p}`];
  };
  const allowedHosts = env.INTENTPAY_ALLOWED_HOSTS ? env.INTENTPAY_ALLOWED_HOSTS.split(",").map((h) => h.trim()) : undefined;
  const hostAllowed = (host: string) => (allowedHosts ?? currentHosts()).includes(host);
  const allowedOrigins = env.INTENTPAY_ALLOWED_ORIGINS
    ? env.INTENTPAY_ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : () => currentHosts().map((h) => `http://${h}`);
  const bind = env.INTENTPAY_BIND ?? "127.0.0.1";
  const rateLimitPerMin = Math.max(1, Number(env.INTENTPAY_RATE_LIMIT_PER_MIN ?? 120));

  // Set AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY to run against the Airwallex sandbox; otherwise the in-memory simulator is used.
  const makeGateway = () => {
    const g = env.AIRWALLEX_CLIENT_ID && env.AIRWALLEX_API_KEY
      ? new LiveIssuingGateway(new AirwallexClient({ clientId: env.AIRWALLEX_CLIENT_ID, apiKey: env.AIRWALLEX_API_KEY }))
      : undefined;
    // Case-7 drill seam (non-production only): wrap the LIVE gateway so exactly one createCard
    // response is discarded after the real vendor commit. The request, origin and credentials are
    // untouched; this instruments the response path, never bypasses a guard.
    if (g && env.INTENTPAY_DROP_CREATE_RESPONSE === "1") {
      if (production) throw new Error("INTENTPAY_DROP_CREATE_RESPONSE is a non-production drill seam; refusing to arm it in production");
      return new DropCreateResponseGateway(g);
    }
    return g;
  };
  const live = makeGateway();
  // A model (ANTHROPIC_API_KEY, or EXTRACTION_BASE_URL+EXTRACTION_MODEL for any OpenAI-compatible endpoint) turns on the model extractor. Without one /api/extract answers 501 and terms stay human-entered.
  // Usage capture: each successful Anthropic response appends its reported token counts to the audit
  // trail, so cost reconciliation reads the append-only record instead of an operator's estimate.
  // Scope is narrow: failed/timed-out requests and any OpenAI-compatible extractor path are NOT
  // captured here, so this is not a complete bill. Token counts only - never prompts, keys or responses.
  const auditLog = new AuditLog(env.INTENTPAY_AUDIT_FILE ?? "audit.jsonl");
  const model = modelFromEnv(env, { onUsage: (u) => auditLog.append("model_usage", { model: env.ANTHROPIC_MODEL ?? DEFAULT_MODEL, inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null }) });
  // Email transport: preview (nothing sent) unless the operator explicitly selects one.
  // dry-run exercises the pipeline without a provider; http is EXPERIMENTAL and posts to
  // INTENTPAY_MAIL_ENDPOINT - never a real provider account, which is an owner-approved decision.
  const emailMode = env.INTENTPAY_EMAIL_TRANSPORT ?? "preview";
  const emailTransport = emailMode === "dry-run" ? new DryRunTransport()
    // The http transport carries the production SSRF guard (https only, no private literal hosts,
    // resolution-time address validation, no redirect following) once production boot is enabled.
    : emailMode === "http" ? new HttpMailTransport(env.INTENTPAY_MAIL_ENDPOINT, env.INTENTPAY_MAIL_TOKEN, fetch, 10_000, { guard: production ? "production" : "off" })
    // gmail = real provider via the owner-approved OAuth client (config validation requires the
    // full credential set; the documented send/reject contract classifies outcomes, never resent).
    : emailMode === "gmail" ? new GmailApiTransport({ clientId: env.INTENTPAY_GMAIL_CLIENT_ID!, clientSecret: env.INTENTPAY_GMAIL_CLIENT_SECRET!, refreshToken: env.INTENTPAY_GMAIL_REFRESH_TOKEN! })
    : null;
  // Hard send boundary: when the owner approved a specific send scope, the allowlist wrapper
  // enforces it at the transport - error and cleanup paths that emit other records stay unsent.
  const allowKinds = env.INTENTPAY_EMAIL_ALLOW_KINDS?.split(",").map((x) => x.trim()).filter(Boolean);
  const allowTo = env.INTENTPAY_EMAIL_ALLOW_TO?.trim();
  // No case-id env: an intake id is random, so a case scope cannot be configured pre-boot.
  // Single-case scope comes from fresh isolated state (INTENTPAY_SEED=none) + one intake.
  const allowMax = env.INTENTPAY_EMAIL_ALLOW_MAX ? Number(env.INTENTPAY_EMAIL_ALLOW_MAX) : undefined;
  const gatedTransport = emailTransport && emailTransport.name !== "dry-run" && (allowKinds?.length || allowTo || allowMax !== undefined)
    ? new AllowlistMailTransport(emailTransport, { kinds: allowKinds?.length ? allowKinds : undefined, to: allowTo, maxSends: allowMax })
    : emailTransport;
  // INTENTPAY_OPERATOR_TOKEN gates promotion of dry-run email records to real sends (http mode).
  const api = createConsoleApi({ gateway: live, seedCases: env.INTENTPAY_SEED === "none" ? [] : undefined, makeGateway: () => makeGateway() ?? makeSim(), emailTransport: gatedTransport, operatorToken: env.INTENTPAY_OPERATOR_TOKEN, live: !!live, planner: model ? (kase, forecast) => extractTerms(model, kase, forecast) : undefined, key: env.INTENTPAY_HMAC_KEY ?? (production ? loadOrCreateHmacKey(env.INTENTPAY_HMAC_KEY_FILE ?? `${env.INTENTPAY_STATE_FILE ?? "console-state.db"}.hmac.key`) : randomBytes(32).toString("hex")), approver: "demo-reviewer", sessionToken, auth: oidc, allowedOrigins, audit: auditLog, drillCrashAt: production ? undefined : env.INTENTPAY_DRILL_CRASH_AT, stateFile: env.INTENTPAY_STATE_FILE ?? (production ? "console-state.db" : "console-state.json"), stateEngine: (env.INTENTPAY_STATE_ENGINE as "json" | "sqlite" | undefined) ?? (production ? "sqlite" : "json") });

  // Fixed-window POST rate limit per client IP: brute-forcing the session token and abuse of
  // mutating endpoints both need volume; normal console use is a handful of POSTs per action.
  const hits = new Map<string, { count: number; resetAt: number }>();
  const rateLimited = (ip: string) => {
    const nowMs = Date.now();
    let h = hits.get(ip);
    if (!h || nowMs >= h.resetAt) { h = { count: 0, resetAt: nowMs + 60_000 }; hits.set(ip, h); }
    h.count++;
    if (hits.size > 10_000) { for (const [k, v] of hits) if (nowMs >= v.resetAt) hits.delete(k); }
    return h.count > rateLimitPerMin;
  };

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, headers: Record<string, string>, body: string | Buffer) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
      res.end(body);
    };
    try {
      // Host allowlist blocks DNS-rebinding: a rebound hostname will not match.
      if (!hostAllowed(String(req.headers.host))) { send(403, { "content-type": "text/plain; charset=utf-8" }, "bad host"); return; }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz" && req.method === "GET") { send(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify({ ok: true })); return; }
      if (url.pathname === "/readyz" && req.method === "GET") {
        const ready = api.readyCheck();
        send(ready ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify(ready ? { ok: true } : { ok: false, reason: "persisted state unreadable (fail-closed)" }));
        return;
      }
      // Auth protocol routes (/auth/login, /auth/callback, /auth/logout) are handled by the provider.
      if (oidc && url.pathname.startsWith("/auth/")) {
        const request = new Request(new URL(req.url ?? "/", `http://${req.headers.host}`), { method: req.method, headers: req.headers as HeadersInit });
        const response = await oidc.route(request);
        if (response) {
          const headers = Object.fromEntries(response.headers.entries());
          const cookies = response.headers.getSetCookie();
          if (cookies.length) headers["set-cookie"] = cookies as unknown as string;
          res.writeHead(response.status, { ...SECURITY_HEADERS, ...headers });
          res.end(Buffer.from(await response.arrayBuffer()));
        } else send(404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
        return;
      }
      // Static console assets. No secrets inside (the demo token rides the page meta tag, not
      // these files), so they are served without auth; cookies/CSRF checks only gate mutations.
      if (url.pathname === "/console.js" && req.method === "GET") {
        send(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }, pageJs); return;
      }
      if (url.pathname === "/console.css" && req.method === "GET") {
        send(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" }, pageCss); return;
      }
      if (url.pathname === "/" && req.method === "GET") {
        // With real auth the page itself is gated: unauthenticated visitors go to sign-in, and
        // no bearer token is ever embedded in the HTML (cookie session only).
        if (oidc) {
          const probe = new Request(new URL("/", `http://${req.headers.host}`), { headers: req.headers as HeadersInit });
          if (!oidc.authenticate(probe)) { send(302, { location: "/auth/login?return_to=/" }, ""); return; }
        }
        let html = page.replace("__GATEWAY_MODE__", live ? "live Airwallex sandbox" : "local simulator - no live API calls").replace("__GATEWAY_FOOTER__", live ? "Connected to Airwallex sandbox API" : "Simulator only - no live rail proof");
        if (sessionToken) html = html.replace("</head>", `<meta name="console-token" content="${sessionToken}"></head>`);
        send(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, html); return;
      }
      if (url.pathname.startsWith("/api/")) {
        const ip = String(req.socket.remoteAddress ?? "unknown");
        if (req.method === "POST" && rateLimited(ip)) {
          console.warn(`rate limited POST ${url.pathname} from ${ip}`);
          send(429, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ error: "rate limited - slow down" }));
          return;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        let tooBig = false;
        for await (const chunk of req) {
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          size += buf.length;
          if (size > MAX_BODY_BYTES) { tooBig = true; break; }
          chunks.push(buf);
        }
        if (tooBig) { send(413, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ error: "request body too large" })); return; }
        const body = chunks.length ? Buffer.concat(chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c))) : undefined;
        const request = new Request(url, { method: req.method, headers: req.headers as HeadersInit, body });
        const response = await api(request);
        send(response.status, Object.fromEntries(response.headers.entries()), Buffer.from(await response.arrayBuffer())); return;
      }
      send(404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
    } catch (error) {
      // Never leak internals: the stack/message stays in the server log, the client gets a generic body.
      console.error("unhandled console error:", error);
      send(500, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ error: "internal error" }));
    }
  });
  serverRef = server;
  return { server, port: PORT, bind, flush: () => api.flush(), production };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { server, port, bind, flush } = buildConsoleServer();
  server.listen(port, bind, () => console.log(`intent-pilot console: http://${bind}:${port}`));
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    try { flush(); } catch (e) { console.error("final state flush failed:", e); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
