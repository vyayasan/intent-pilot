import { describe, it, expect } from "vitest";
import { createConsoleApi, type CaseState } from "../src/console/api.js";
import { AuditLog } from "../src/audit/audit.js";
import type { IssuingGateway } from "../src/sim/simGateway.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = new Date("2026-10-27T13:00:00Z");
const BALANCES = Array(12).fill(1200);

const setup = (extra: Record<string, unknown> = {}) => {
  const audit = new AuditLog(undefined, () => NOW);
  const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases: [], ...extra });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000", ...headers }, body: JSON.stringify(body) }));
  const intake = (over: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    post("/api/intake", { vendor: "Real Vendor Ltd", rawTerms: "Real Vendor Pro: 50 GBP per month, 500 GBP per year upfront. 30 days notice. Category: software.", weeklyBalances: BALANCES, reserveFloor: 500, sourceNote: "vendor pricing email, 27 Oct", ...over }, headers);
  return { api, audit, post, intake };
};

describe("case intake (acceptance mode, no demo seed)", () => {
  it("starts empty and creates a real case that escalates until terms are extracted", async () => {
    const { api, intake } = setup();
    const before = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    expect(before.cases).toEqual([]);
    const r = await intake();
    expect(r.status).toBe(201);
    const d = await r.json();
    expect(d.case.kase.vendor).toBe("Real Vendor Ltd");
    expect(d.case.kase.id).toMatch(/^case_real-vendor-ltd_[0-9a-f]{6}$/);
    expect(d.case.kase.terms).toBeUndefined();
    expect(d.case.decision.cadence).toBe("ESCALATE");
    expect(d.case.decision.reasons.join(" ")).toContain("terms not extracted yet");
    const after = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    expect(after.cases).toHaveLength(1);
  });

  it("records the intake in the audit trail with its provenance", async () => {
    const { audit, intake } = setup();
    const r = await intake();
    const id = (await r.json()).case.kase.id;
    expect(audit.list().some((e) => e.kind === "case_intake" && e.caseId === id && (e.detail as { sourceNote?: string }).sourceNote?.includes("vendor pricing email"))).toBe(true);
  });

  it("rejects malformed input: missing fields, oversized text, bad forecast", async () => {
    const { intake } = setup();
    expect((await intake({ vendor: "" })).status).toBe(400);
    expect((await intake({ rawTerms: "" })).status).toBe(400);
    expect((await intake({ rawTerms: "x".repeat(8001) })).status).toBe(400);
    expect((await intake({ weeklyBalances: [1, 2, 3] })).status).toBe(400);
    expect((await intake({ weeklyBalances: [...BALANCES.slice(1), -1] })).status).toBe(400);
    expect((await intake({ reserveFloor: -5 })).status).toBe(400);
    expect((await intake({ sourceNote: "" })).status).toBe(400);
    expect((await intake({ weeklyBalances: undefined })).status).toBe(400);
  });

  it("treats rawTerms as inert text: URLs inside it trigger no gateway or model call", async () => {
    let gatewayCalls = 0, plannerCalls = 0;
    const gw: IssuingGateway = new Proxy({} as IssuingGateway, { get: () => async () => { gatewayCalls++; throw new Error("must not be called"); } });
    const { intake } = setup({ gateway: gw, planner: async () => { plannerCalls++; throw new Error("must not be called"); } });
    const r = await intake({ rawTerms: "Terms at https://evil.example/steal?token=abc - 50 GBP/mo. Category: software. 30 days notice." });
    expect(r.status).toBe(201);
    expect(gatewayCalls).toBe(0);
    expect(plannerCalls).toBe(0);
  });

  it("requires the console token and an allowed origin", async () => {
    const { post } = setup();
    const noTok = await post("/api/intake", { vendor: "V", rawTerms: "t", weeklyBalances: BALANCES, reserveFloor: 1, sourceNote: "s" }, { "x-console-token": "wrong" });
    expect(noTok.status).toBe(403);
    const evil = await post("/api/intake", { vendor: "V", rawTerms: "t", weeklyBalances: BALANCES, reserveFloor: 1, sourceNote: "s" }, { origin: "http://evil.example" });
    expect(evil.status).toBe(403);
  });

  it("persists the intake case across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "intentpay-intake-"));
    try {
      const stateFile = join(dir, "state.json");
      const make = () => createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases: [], stateFile });
      const post1 = (body: unknown) => make()(new Request("http://localhost:3000/api/intake", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
      const r = await post1({ vendor: "Real Vendor Ltd", rawTerms: "50 GBP/mo. 30 days notice. Category: software.", weeklyBalances: BALANCES, reserveFloor: 500, sourceNote: "vendor pricing email, 27 Oct" });
      expect(r.status).toBe(201);
      const id = (await r.json()).case.kase.id;
      const reopened = make();
      const d = await (await reopened(new Request("http://localhost:3000/api/cases"))).json();
      expect(d.cases.map((c: { kase: { id: string } }) => c.kase.id)).toContain(id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cannot be approved before terms exist, and extraction locks after approval", async () => {
    const { post, intake } = setup({ planner: async () => ({ ok: false, error: "model off in this test" }) });
    const id = (await (await intake()).json()).case.kase.id;
    const noTerms = await post("/api/approve", { caseId: id });
    expect(noTerms.status).toBe(404); // a term-less case is not approvable
    const terms = { monthlyPrice: 50, annualPrice: 500, currency: "GBP", category: "software", noticeDays: 30 };
    const ct = await post("/api/change-terms", { caseId: id, terms, rawTerms: "Real Vendor Pro: 50 GBP per month, 500 GBP per year upfront. 30 days notice. Category: software." });
    expect(ct.status).toBe(200);
    const ap = await post("/api/approve", { caseId: id });
    expect(ap.status).toBe(200);
    const apd = await ap.json();
    expect(apd.approval.cadence).toBe("annual"); // 500 upfront never breaches the 500 floor on flat 1200 balances, and saves 100
    expect(apd.approval.amountCap).toBe(500);
    const ex = await post("/api/extract", { caseId: id });
    expect(ex.status).toBe(409); // extraction locked after approval
  });
});
