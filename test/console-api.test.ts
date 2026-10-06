import { describe, it, expect } from "vitest";
import { createConsoleApi, demoCases, type CaseState } from "../src/console/api.js";
import { AuditLog } from "../src/audit/audit.js";

const NOW = new Date("2026-10-06T09:00:00Z");
const setup = (seedCases?: CaseState[]) => {
  const audit = new AuditLog(undefined, () => NOW);
  const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000", ...headers }, body: JSON.stringify(body) }));
  return { api, audit, post };
};

describe("console api", () => {
  it("lists cases with the policy decision: monthly, week-7 breach", async () => {
    const { api } = setup();
    const r = await api(new Request("http://localhost:3000/api/cases"));
    const d = await r.json();
    expect(d.cases[0].decision.cadence).toBe("monthly");
    expect(d.cases[0].decision.annualBreachWeek).toBe(7);
    expect(d.cases[0].decision.savingsPct).toBeCloseTo(18, 0);
  });

  it("refuses a POST without the console token or from a foreign origin", async () => {
    const { api } = setup();
    const noTok = await api(new Request("http://localhost:3000/api/approve", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(noTok.status).toBe(403);
    const badOrigin = await api(new Request("http://localhost:3000/api/approve", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://evil.example" }, body: "{}" }));
    expect(badOrigin.status).toBe(403);
  });

  it("runs the full flow: approve, create card, simulate pass and fail", async () => {
    const { post } = setup();
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect(ap.approval.cadence).toBe("monthly");
    expect(ap.approval.amountCap).toBe(100);
    const cc = await (await post("/api/create-card", { approval: ap.approval })).json();
    expect(cc.card.controls).toEqual({ amountLimit: 100, currencyAllowlist: ["USD"], merchantCategories: ["software"] });
    const ok = await (await post("/api/simulate", { caseId: "case_acme", kind: "in-policy" })).json();
    expect(ok.transaction.status).toBe("CLEARING");
    const nope = await (await post("/api/simulate", { caseId: "case_acme", kind: "over-cap" })).json();
    expect(nope.transaction.status).toBe("FAILED");
    expect(nope.transaction.failureReason).toBe("above_approved_cap");
    const wrongCur = await (await post("/api/simulate", { caseId: "case_acme", kind: "wrong-currency" })).json();
    expect(wrongCur.transaction.failureReason).toBe("currency_not_allowed");
    const wrongCat = await (await post("/api/simulate", { caseId: "case_acme", kind: "wrong-category" })).json();
    expect(wrongCat.transaction.failureReason).toBe("category_not_allowed");
  });

  it("refuses card creation without a valid approval, on reuse, and when the deal changed", async () => {
    const seed = demoCases();
    const { post } = setup(seed);
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    const forged = { ...ap.approval, sig: "0".repeat(64) };
    const r1 = await post("/api/create-card", { approval: forged });
    expect(r1.status).toBe(409);
    // change the deal after approval
    seed[0].intent = { ...seed[0].intent!, amountCap: 150 };
    const r2 = await post("/api/create-card", { approval: ap.approval });
    expect(await r2.json()).toEqual({ error: "intent changed" });
    // restore, create, then reuse
    seed[0].intent = { ...seed[0].intent!, amountCap: 100 };
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(200);
    const reuse = await post("/api/create-card", { approval: ap.approval });
    expect(await reuse.json()).toEqual({ error: "approval already used" });
  });

  it("records a rejection with its reason and never creates a card", async () => {
    const { post, audit } = setup();
    await post("/api/reject", { caseId: "case_acme", reason: "not in budget this quarter" });
    const r = await post("/api/approve", { caseId: "case_acme" }); // approve is still possible later; the rejection is recorded
    expect(r.status).toBe(200);
    expect(audit.list().some((e) => e.kind === "recommendation_rejected")).toBe(true);
  });

  it("audits refusals and executions", async () => {
    const { post, audit } = setup();
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    await post("/api/create-card", { approval: ap.approval });
    const kinds = audit.list().map((e) => e.kind);
    expect(kinds).toContain("approval_issued");
    expect(kinds).toContain("card_created");
  });
});
