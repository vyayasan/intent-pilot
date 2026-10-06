import { describe, it, expect } from "vitest";
import { createConsoleApi, demoCases } from "../../src/console/api.js";
import { AuditLog } from "../../src/audit/audit.js";

// Attacker's goal: drive the console from another origin, without the session token,
// or through endpoints in the wrong order. Everything state-changing is POST + token + origin.

const NOW = new Date("2026-10-06T09:00:00Z");
const setup = () => {
  const audit = new AuditLog(undefined, () => NOW);
  const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases: demoCases() });
  const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    api(new Request(`http://localhost:3000${path}`, { method: init.method ?? "POST", headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }));
  const authed = { "x-console-token": "tok", origin: "http://localhost:3000" };
  return { api, req, authed, audit };
};

describe("redteam: console cross-site and ordering attacks", () => {
  it("every mutating endpoint refuses a foreign origin, a missing token and a wrong token", async () => {
    const { req, authed } = setup();
    for (const path of ["/api/approve", "/api/reject", "/api/create-card", "/api/simulate", "/api/freeze", "/api/reset-demo", "/api/extract"]) {
      expect((await req(path, { headers: { origin: "http://evil.example", "x-console-token": "tok" }, body: {} })).status).toBe(403);
      expect((await req(path, { headers: { origin: "http://localhost:3000" }, body: {} })).status).toBe(403);
      expect((await req(path, { headers: { origin: "http://localhost:3000", "x-console-token": "nope" }, body: {} })).status).toBe(403);
    }
    // and the right credentials do reach the handler
    expect((await req("/api/reset-demo", { headers: authed, body: {} })).status).toBe(200);
  });

  it("GET cannot mutate", async () => {
    const { req, authed } = setup();
    const r = await req("/api/approve?caseId=case_acme", { method: "GET", headers: authed });
    expect([404, 405]).toContain(r.status);
  });

  it("simulate before any card exists fails closed", async () => {
    const { req, authed } = setup();
    const r = await req("/api/simulate", { headers: authed, body: { caseId: "case_acme", kind: "in-policy" } });
    expect([400, 409]).toContain(r.status);
  });

  it("freeze without a card fails closed", async () => {
    const { req, authed } = setup();
    const r = await req("/api/freeze", { headers: authed, body: { caseId: "case_acme" } });
    expect([400, 409]).toContain(r.status);
  });

  it("approving an unknown case is a 404, not a minted approval", async () => {
    const { req, authed } = setup();
    const r = await req("/api/approve", { headers: authed, body: { caseId: "case_nope" } });
    expect(r.status).toBe(404);
  });

  it("extract without a configured model says so instead of pretending", async () => {
    const { req, authed } = setup();
    const r = await req("/api/extract", { headers: authed, body: { caseId: "case_acme" } });
    expect(r.status).toBe(501);
  });
});
