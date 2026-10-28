import { describe, it, expect } from "vitest";
import { createConsoleApi, demoCases } from "../../src/console/api.js";
import { AuditLog } from "../../src/audit/audit.js";

// Attacker's goal: turn a person's approval of one deal into a card for another deal,
// or stretch one approval into two cards. Every attempt must fail closed.

const NOW = new Date("2026-10-06T09:00:00Z");
const setup = () => {
  const audit = new AuditLog(undefined, () => NOW);
  const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases: demoCases() });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000", ...headers }, body: JSON.stringify(body) }));
  return { api, post, audit };
};

describe("redteam: approval misuse", () => {
  it("an approval for one case cannot create a card against another case's intent", async () => {
    const { post, api } = setup();
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    // Swap the case id inside the approval envelope: the signature no longer matches.
    const swapped = { ...ap.approval, caseId: "case_flowdesk" };
    const r = await post("/api/create-card", { approval: swapped });
    // Fails closed: flowdesk has no live intent, so there is nothing to bind the stolen approval to.
    expect([404, 409]).toContain(r.status);
    const cases = await (await api(new Request("http://localhost:3000/api/cases"))).json();
    expect(cases.cases.every((c: Record<string, unknown>) => !c["card"] || c["id"] === "case_acme")).toBe(true);
  });

  it("editing the approved cap inside the envelope fails the signature check", async () => {
    const { post } = setup();
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    const inflated = { ...ap.approval, amountCap: 100000 };
    const r = await post("/api/create-card", { approval: inflated });
    expect(r.status).toBe(409);
  });

  it("one approval creates exactly one card even when the request is fired twice", async () => {
    const { post } = setup();
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    const [r1, r2] = await Promise.all([post("/api/create-card", { approval: ap.approval }), post("/api/create-card", { approval: ap.approval })]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]); // exactly one succeeds; the other is told the approval is used
  });

  it("an approval minted for a rejected-then-approved case still binds to the live intent only", async () => {
    const { post } = setup();
    await post("/api/reject", { caseId: "case_acme", reason: "thinking about it" });
    const ap = await (await post("/api/approve", { caseId: "case_acme" })).json();
    expect((await post("/api/create-card", { approval: ap.approval })).status).toBe(200);
  });
});
