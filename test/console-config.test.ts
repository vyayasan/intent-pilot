import { describe, it, expect } from "vitest";
import { isPrivateHostname, validateConsoleConfig } from "../src/console/config.js";

describe("isPrivateHostname (SSRF guard)", () => {
  it("flags loopback, private, link-local, CGNAT and local naming", () => {
    for (const h of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.254", "0.0.0.0", "localhost", "foo.localhost", "printer.local", "corp.internal", "[::1]", "[fe80::1]", "[fd00::1]"])
      expect(isPrivateHostname(h), h).toBe(true);
  });
  it("passes public hosts", () => {
    for (const h of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "mail.example.com", "11.0.0.1"])
      expect(isPrivateHostname(h), h).toBe(false);
  });
});

describe("validateConsoleConfig", () => {
  it("demo defaults: no errors", () => {
    const r = validateConsoleConfig({});
    expect(r.production).toBe(false);
    expect(r.errors).toEqual([]);
  });
  it("rejects an unknown email transport mode and a bad PORT", () => {
    const r = validateConsoleConfig({ INTENTPAY_EMAIL_TRANSPORT: "sendgrid", PORT: "99999" });
    expect(r.errors.some((e) => e.includes("INTENTPAY_EMAIL_TRANSPORT"))).toBe(true);
    expect(r.errors.some((e) => e.includes("PORT"))).toBe(true);
  });
  it("http transport without an endpoint is an error in any mode", () => {
    expect(validateConsoleConfig({ INTENTPAY_EMAIL_TRANSPORT: "http" }).errors.some((e) => e.includes("MAIL_ENDPOINT"))).toBe(true);
  });
  it("non-https and private endpoints are warnings in demo, errors in production", () => {
    const demo = validateConsoleConfig({ INTENTPAY_EMAIL_TRANSPORT: "http", INTENTPAY_MAIL_ENDPOINT: "http://127.0.0.1:8080/send" });
    expect(demo.errors).toEqual([]);
    expect(demo.warnings.length).toBeGreaterThanOrEqual(2);
    const prod = validateConsoleConfig({
      INTENTPAY_ENV: "production", INTENTPAY_EMAIL_TRANSPORT: "http", INTENTPAY_MAIL_ENDPOINT: "http://127.0.0.1:8080/send",
      INTENTPAY_ALLOWED_ORIGINS: "https://console.example.com", INTENTPAY_ALLOWED_HOSTS: "console.example.com", INTENTPAY_SESSION_TOKEN: "x".repeat(40), INTENTPAY_OPERATOR_TOKEN: "op"
    });
    expect(prod.errors.some((e) => e.includes("https"))).toBe(true);
    expect(prod.errors.some((e) => e.includes("SSRF"))).toBe(true);
  });
  const oidc = { INTENTPAY_OIDC_ISSUER: "https://idp.example.com", INTENTPAY_OIDC_CLIENT_ID: "intentpay", INTENTPAY_OIDC_CLIENT_SECRET: "s", INTENTPAY_OIDC_REDIRECT_URI: "https://console.example.com/auth/callback" };
  it("production fails closed without real sign-in: a shared stable token is not auth", () => {
    const r = validateConsoleConfig({ INTENTPAY_ENV: "production", INTENTPAY_EMAIL_TRANSPORT: "http", INTENTPAY_MAIL_ENDPOINT: "https://mail.example.com/send", INTENTPAY_SESSION_TOKEN: "x".repeat(48) });
    expect(r.errors.some((e) => e.includes("ALLOWED_ORIGINS"))).toBe(true);
    expect(r.errors.some((e) => e.includes("ALLOWED_HOSTS"))).toBe(true);
    expect(r.errors.some((e) => e.includes("OPERATOR_TOKEN"))).toBe(true);
    // no OIDC config -> boot must fail even with a strong shared token present
    expect(r.errors.filter((e) => e.includes("OIDC"))).toHaveLength(4);
    expect(r.errors.some((e) => e.includes("fails closed"))).toBe(true);
  });
  it("a complete production config (with OIDC sign-in) passes", () => {
    const r = validateConsoleConfig({
      INTENTPAY_ENV: "production", INTENTPAY_EMAIL_TRANSPORT: "http", INTENTPAY_MAIL_ENDPOINT: "https://mail.example.com/send",
      INTENTPAY_ALLOWED_ORIGINS: "https://console.example.com", INTENTPAY_ALLOWED_HOSTS: "console.example.com",
      INTENTPAY_OPERATOR_TOKEN: "op", ...oidc
    });
    expect(r.errors).toEqual([]);
  });
  it("rejects non-https origins and a non-https issuer in production", () => {
    const r = validateConsoleConfig({
      INTENTPAY_ENV: "production", INTENTPAY_ALLOWED_ORIGINS: "http://console.example.com",
      INTENTPAY_ALLOWED_HOSTS: "console.example.com", ...oidc, INTENTPAY_OIDC_ISSUER: "http://idp.example.com"
    });
    expect(r.errors.filter((e) => e.includes("https"))).toHaveLength(2);
  });
});
