import { describe, it, expect } from "vitest";
import type { ModelClient, ModelRequest, Block } from "../src/agent/model.js";
import { createConsoleApi, demoCases } from "../src/console/api.js";
import { AuditLog } from "../src/audit/audit.js";
import type { CardTransaction } from "../src/domain/types.js";

const NOW = new Date("2026-10-06T09:00:00Z");

// A scripted model: each entry is the tool the model calls next. "text" simulates a prose reply.
type Step = string | { text: true };
const modelFromScript = (script: Step[], captured?: ModelRequest[]): ModelClient => {
  let i = 0;
  return { step: async (req) => {
    if (captured) captured.push(req);
    const s = script[Math.min(i++, script.length - 1)];
    if (typeof s === "object" && s.text) return [{ type: "text", text: "prose" }];
    const name = s as string;
    if (name === "finish") return [{ type: "tool_use", id: `u${i}`, name: "finish", input: { summary: "done: card issued, purchase executed" } }];
    return [{ type: "tool_use", id: `u${i}`, name, input: {} }];
  } };
};

const setup = (model?: ModelClient, gateway?: any) => {
  const audit = new AuditLog(undefined, () => NOW);
  const api = createConsoleApi({ key: "k", approver: "sandi", now: () => NOW, audit, sessionToken: "tok",
    allowedOrigins: ["http://localhost:3000"], executorModel: model, ...(gateway ? { gateway } : {}) });
  const call = (path: string, body: unknown) =>
    api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
  const approve = async () => (await (await call("/api/approve", { caseId: "case_acme" })).json()).approval;
  return { api, audit, call, approve };
};

describe("execution agent (/api/agent-run)", () => {
  it("drives an approved intent to completion: issue card, execute purchase, finish - all real operations", async () => {
    const captured: ModelRequest[] = [];
    const { call, approve, audit } = setup(modelFromScript(["read_state", "issue_card", "execute_purchase", "finish"], captured));
    const approval = await approve();
    const r = await call("/api/agent-run", { caseId: "case_acme", approval });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.run.ok).toBe(true);
    expect(d.run.steps.join(",")).toContain("issue_card -> 200");
    expect(d.run.steps.join(",")).toContain("execute_purchase -> 200");
    // the purchase really cleared on the real operation path
    const cleared = (d.case.log.join(" ") + JSON.stringify(d.case)).includes("CLEARING");
    expect(cleared).toBe(true);
    expect(d.case.card.status).toBe("ACTIVE");
    // provenance: the run is bracketed in the audit trail
    const events = audit.list().map((e: any) => e.kind ?? e.type);
    expect(events).toContain("agent_run_started");
    expect(events).toContain("agent_run_finished");
    expect(events).toContain("card_created");
    // the model never named an amount: tools take no arguments
    const toolArgs = captured.flatMap((req) => req.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []))
      .filter((b: any) => b.type === "tool_result").map((b: any) => b.content).join(" ");
    expect(toolArgs).toContain("100");
  });

  it("refuses to run before a person approves", async () => {
    const { call } = setup(modelFromScript(["finish"]));
    const r = await call("/api/agent-run", { caseId: "case_acme", approval: { caseId: "case_acme", intentId: "x", intentHash: "y", termsHash: "z" } });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/not approved/);
  });

  it("answers 501 with no model configured - never fakes the agent", async () => {
    const { call, approve } = setup(undefined);
    const approval = await approve();
    const r = await call("/api/agent-run", { caseId: "case_acme", approval });
    expect(r.status).toBe(501);
  });

  it("recovers in-loop when the model calls execute_purchase before issue_card (real operation refuses)", async () => {
    const { call, approve } = setup(modelFromScript(["execute_purchase", "issue_card", "execute_purchase", "finish"]));
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(d.run.steps[0]).toContain("execute_purchase -> 409"); // create the card first
    expect(d.run.ok).toBe(true);
    expect(d.case.card.status).toBe("ACTIVE");
  });

  it("one-shot bound: a second issue_card call is refused in code even if the model asks", async () => {
    const { call, approve } = setup(modelFromScript(["issue_card", "issue_card", "execute_purchase", "finish"]));
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(d.run.ok).toBe(true);
    const issues = d.run.steps.filter((s: string) => s.startsWith("issue_card -> 2"));
    expect(issues.length).toBe(1);
  });

  it("unknown purchase outcome: locks, does not retry, reports reconcile-needed", async () => {
    let auths = 0;
    const gw = {
      async createCardholder(_h: any, _k: string) { return { state: "ok", cardholder: { id: "ch1", name: "S", email: "s@x" } }; },
      async createCard(_r: any, _k: string) { return { id: "card1", cardholderId: "ch1", controls: {}, status: "ACTIVE" }; },
      async authorize() { auths++; throw new Error("socket hang up"); },
      async transactions() { return [] as CardTransaction[]; },
      async freezeCard(id: string) { return { id, status: "FROZEN" }; },
      async closeCard(id: string) { return { id, status: "CLOSED" }; },
      async listCards() { return []; },
    };
    const { call, approve } = setup(modelFromScript(["issue_card", "execute_purchase", "finish"]), gw);
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(auths).toBe(1); // NO blind retry of an ambiguous authorization
    expect(d.run.needsReconcile).toBe(true);
    expect(d.case.pendingAuthorization).toBeTruthy();
    expect(d.case.pendingAuthorization.reconciledAt).toBeUndefined();
  });

  it("a documented decline is a completed outcome - reported, not retried", async () => {
    let auths = 0;
    const gw = {
      async createCardholder(_h: any, _k: string) { return { state: "ok", cardholder: { id: "ch1", name: "S", email: "s@x" } }; },
      async createCard(_r: any, _k: string) { return { id: "card1", cardholderId: "ch1", controls: {}, status: "ACTIVE" }; },
      async authorize(id: string, a: any) { auths++; return { id: "t1", cardId: id, amount: a.amount, currency: a.currency, status: "FAILED", failureReason: "above_approved_cap" }; },
      async transactions() { return [] as CardTransaction[]; },
      async freezeCard(id: string) { return { id, status: "FROZEN" }; },
      async closeCard(id: string) { return { id, status: "CLOSED" }; },
      async listCards() { return []; },
    };
    const { call, approve } = setup(modelFromScript(["issue_card", "execute_purchase", "finish"]), gw);
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(auths).toBe(1);
    expect(d.run.ok).toBe(true);
    expect(d.run.summary).toBeTruthy();
  });

  it("terminates bounded when the model only answers in prose", async () => {
    const { call, approve } = setup(modelFromScript([{ text: true }]));
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(d.run.ok).toBe(false);
    expect(d.run.error).toMatch(/did not call a tool|step budget/);
  });
});
