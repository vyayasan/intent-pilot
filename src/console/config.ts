/**
 * Console configuration validation. The console fails fast on startup when configuration is
 * invalid rather than degrading in production. INTENTPAY_ENV=production turns the warnings
 * into errors and requires explicit origins plus a real OIDC sign-in configuration - a shared
 * session token is a demo artifact and production boot fails closed without an identity provider.
 */

export interface ConsoleConfigResult {
  errors: string[];
  warnings: string[];
  production: boolean;
}

import { isPrivateHostname } from "../net/ssrf.js";

const EMAIL_MODES = new Set(["preview", "dry-run", "http", "gmail"]);
export { isPrivateHostname };

export function validateConsoleConfig(env: NodeJS.ProcessEnv): ConsoleConfigResult {
  const production = env.INTENTPAY_ENV === "production";
  const errors: string[] = [];
  const warnings: string[] = [];
  const strict = (msg: string) => (production ? errors : warnings).push(msg);

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`PORT must be an integer 1-65535, got "${env.PORT}"`);

  const mode = env.INTENTPAY_EMAIL_TRANSPORT ?? "preview";
  if (!EMAIL_MODES.has(mode)) errors.push(`INTENTPAY_EMAIL_TRANSPORT must be preview|dry-run|http|gmail, got "${mode}"`);

  if (mode === "gmail") {
    // Real-provider mode: the OAuth client and its scopes are an owner-approved Google config
    // change; boot fails closed without the full credential set.
    for (const v of ["INTENTPAY_GMAIL_CLIENT_ID", "INTENTPAY_GMAIL_CLIENT_SECRET", "INTENTPAY_GMAIL_REFRESH_TOKEN"])
      if (!env[v]) errors.push(`${v} is required when INTENTPAY_EMAIL_TRANSPORT=gmail`);
  }

  if (mode === "http") {
    const endpoint = env.INTENTPAY_MAIL_ENDPOINT;
    if (!endpoint) {
      errors.push("INTENTPAY_MAIL_ENDPOINT is required when INTENTPAY_EMAIL_TRANSPORT=http");
    } else {
      let u: URL | undefined;
      try { u = new URL(endpoint); } catch { errors.push("INTENTPAY_MAIL_ENDPOINT is not a valid URL"); }
      if (u) {
        if (u.protocol !== "https:") strict(`mail endpoint should be https, got ${u.protocol}// (credentials and content otherwise cross the network in plaintext)`);
        if (isPrivateHostname(u.hostname)) strict("mail endpoint host is a private/internal address - SSRF guard refuses it in production");
      }
    }
    if (production && !env.INTENTPAY_OPERATOR_TOKEN)
      errors.push("INTENTPAY_OPERATOR_TOKEN is required in production with http email transport (it gates dry-run promotion)");
  }

  if (production) {
    const origins = env.INTENTPAY_ALLOWED_ORIGINS;
    if (!origins) {
      errors.push("INTENTPAY_ALLOWED_ORIGINS (comma-separated https origins) is required in production");
    } else {
      for (const o of origins.split(",")) {
        try {
          const u = new URL(o.trim());
          if (u.protocol !== "https:") errors.push(`allowed origin must be https: ${o.trim()}`);
        } catch { errors.push(`allowed origin is not a valid URL: ${o.trim()}`); }
      }
    }
    if (!env.INTENTPAY_ALLOWED_HOSTS) errors.push("INTENTPAY_ALLOWED_HOSTS (comma-separated hostnames) is required in production");
    // Production must authenticate users with a real identity provider. A shared stable token
    // (INTENTPAY_SESSION_TOKEN) is a demo artifact, not auth - the boot fails closed without OIDC.
    for (const v of ["INTENTPAY_OIDC_ISSUER", "INTENTPAY_OIDC_CLIENT_ID", "INTENTPAY_OIDC_CLIENT_SECRET", "INTENTPAY_OIDC_REDIRECT_URI"])
      if (!env[v]) errors.push(`${v} is required in production (real sign-in via OIDC; the demo token model fails closed here)`);
    // Drill instrumentation must never reach production.
    if (env.INTENTPAY_DRILL_CRASH_AT) errors.push("INTENTPAY_DRILL_CRASH_AT is drill-only fault injection and is forbidden in production");
    const issuer = env.INTENTPAY_OIDC_ISSUER;
    if (issuer) {
      try { if (new URL(issuer).protocol !== "https:") errors.push("INTENTPAY_OIDC_ISSUER must be https"); } catch { errors.push("INTENTPAY_OIDC_ISSUER is not a valid URL"); }
    }
  }
  return { errors, warnings, production };
}
