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

  it("recovers in-loop when the model calls execute_purchase before issue_card (pre-gateway refusal preserves the shot)", async () => {
    const { call, approve, audit } = setup(modelFromScript(["execute_purchase", "issue_card", "execute_purchase", "finish"]));
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(d.run.steps[0]).toContain("pre-gateway refusal, shot preserved"); // create the card first
    expect(d.run.steps.join(",")).toContain("execute_purchase -> 200"); // the retry really ran
    expect(d.run.ok).toBe(true);
    const kinds = audit.list().map((e: any) => e.kind ?? e.type);
    expect(kinds.filter((k: string) => k === "authorization_attempt").length).toBe(1); // exactly ONE gateway authorize
    expect(kinds).toContain("authorization_cleared"); // and it actually cleared in the ledger
    expect(d.case.log.join(" ")).toMatch(/cleared/i);
  });

  it("attempted is never complete: a refused purchase followed by finish reports ok=false", async () => {
    const { call, approve } = setup(modelFromScript(["execute_purchase", "finish"]));
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(d.run.ok).toBe(false); // no card existed; nothing reached the gateway; not complete
    expect(d.case.card).toBeFalsy();
  });

  it("strict one-shot after the gateway is reached: a second execute_purchase after a clearing is refused", async () => {
    const { call, approve, audit } = setup(modelFromScript(["issue_card", "execute_purchase", "execute_purchase", "finish"]));
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(d.run.ok).toBe(true);
    expect(d.run.steps.join(",")).toContain("execute_purchase refused - already fired this run");
    const kinds = audit.list().map((e: any) => e.kind ?? e.type);
    expect(kinds.filter((k: string) => k === "authorization_cleared").length).toBe(1); // never a duplicate purchase
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
    const { call, approve, audit } = setup(modelFromScript(["issue_card", "execute_purchase", "finish"]), gw);
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(auths).toBe(1); // NO blind retry of an ambiguous authorization
    expect(d.run.needsReconcile).toBe(true);
    expect(d.run.ok).toBe(false); // REVIEW I1: an unknown money outcome is never reported complete
    const finished = audit.list().find((e: any) => (e.kind ?? e.type) === "agent_run_finished");
    expect(finished).toBeTruthy();
    expect(JSON.stringify(finished)).toContain('"ok":false'); // audit must not claim completion either
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

  it("an authorization with an unexpected status (neither PENDING nor FAILED) is unknown, never complete or declined", async () => {
    let auths = 0;
    const gw = {
      async createCardholder(_h: any, _k: string) { return { state: "ok", cardholder: { id: "ch1", name: "S", email: "s@x" } }; },
      async createCard(_r: any, _k: string) { return { id: "card1", cardholderId: "ch1", controls: {}, status: "ACTIVE" }; },
      async authorize(id: string, a: any) { auths++; return { id: "t1", cardId: id, amount: a.amount, currency: a.currency, status: "SETTLING" }; },
      async transactions() { return [] as CardTransaction[]; },
      async freezeCard(id: string) { return { id, status: "FROZEN" }; },
      async closeCard(id: string) { return { id, status: "CLOSED" }; },
      async listCards() { return []; },
    };
    const { call, approve } = setup(modelFromScript(["issue_card", "execute_purchase", "finish"]), gw);
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(auths).toBe(1);
    expect(d.run.needsReconcile).toBe(true);
    expect(d.run.ok).toBe(false);
    expect(d.case.pendingAuthorization).toBeTruthy();
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

describe("execution agent - review-requested bounds", () => {
  it("refuses a tampered approval: wrong intentHash -> 409 refusal, audit-recorded, no card", async () => {
    const { call, approve, audit } = setup(modelFromScript(["issue_card", "finish"]));
    const approval = await approve();
    approval.intentHash = "0".repeat(64); // tampered: no longer the approved intent
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(d.run.ok).toBe(false);
    expect(d.run.steps.join(",")).toContain("issue_card -> 409");
    expect(d.case.card).toBeFalsy();
    const refusals = audit.list().filter((e: any) => (e.kind ?? e.type) === "refused");
    expect(refusals.length).toBeGreaterThan(0);
  });

  it("rejects a cross-case approval artifact before any model call", async () => {
    const { call, approve } = setup(modelFromScript(["issue_card", "finish"]));
    const approval = await approve();
    approval.caseId = "case_other"; // artifact no longer names the route's case
    const r = await call("/api/agent-run", { caseId: "case_acme", approval });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/different case/);
  });

  it("amount discipline: injected model tool arguments never reach the operation - purchase stays at the approved amount", async () => {
    // A model that tries to steer amounts/vendors through tool input. The executor's tools take
    // no arguments, so this input must be dropped wholesale.
    const injected: ModelClient = (() => {
      const script = ["read_state", "issue_card", "execute_purchase", "finish"];
      let i = 0;
      return { step: async () => {
        const name = script[Math.min(i++, script.length - 1)];
        if (name === "finish") return [{ type: "tool_use", id: `u${i}`, name, input: { summary: "done" } }];
        return [{ type: "tool_use", id: `u${i}`, name, input: { amount: 999999, vendor: "Evil Corp", currency: "XXX", cardLimit: 999999 } }];
      } };
    })();
    const { call, approve } = setup(injected);
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(d.run.ok).toBe(true);
    const blob = JSON.stringify(d.case);
    expect(blob).not.toContain("999999");
    expect(blob).not.toContain("Evil Corp");
    expect(blob).toContain("100"); // the approved monthly amount
  });

  it("notifications fire through the existing outbox hooks on the agent-driven path", async () => {
    const { call, approve, audit } = setup(modelFromScript(["issue_card", "execute_purchase", "finish"]));
    const approval = await approve();
    const d = await (await call("/api/agent-run", { caseId: "case_acme", approval })).json();
    expect(d.run.ok).toBe(true);
    const kinds = audit.list().map((e: any) => e.kind ?? e.type);
    // The same audited state transitions the manual flow produced - the outbox emits on each.
    expect(kinds).toContain("card_created");
    expect(kinds).toContain("authorization_cleared"); // outbox emits purchase_cleared on this transition
  });
});

describe("scenario harness (operator-set purchase kind)", () => {
  it("passes the operator scenario to the typed simulate while the model only executes", async () => {
    const captured: ModelRequest[] = [];
    const { call, approve, audit } = setup(modelFromScript(["read_state", "issue_card", "execute_purchase", "finish"], captured));
    const approval = await approve();
    const r = await call("/api/agent-run", { caseId: "case_acme", approval, scenario: "over-cap" });
    expect(r.status).toBe(200);
    const d = await r.json();
    // a documented decline is a decisive completed outcome for the agent
    expect(d.run.ok).toBe(true);
    expect(d.run.steps.join(",")).toContain("execute_purchase -> 200");
    const events = audit.list().map((e: any) => JSON.stringify(e));
    expect(events.some((e: string) => e.includes("authorization_attempt") && e.includes("\"kind\":\"over-cap\""))).toBe(true);
    expect(events.some((e: string) => e.includes("agent_run_started") && e.includes("\"scenario\":\"over-cap\""))).toBe(true);
    // enforcement: the card declined the over-cap charge
    expect(JSON.stringify(d.case)).toContain("declined");
    // the model never saw or chose the scenario: tool inputs carry no kind
    const toolUses = captured.flatMap((req) => req.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []))
      .filter((b: any) => b.type === "tool_use");
    expect(toolUses.every((b: any) => !JSON.stringify(b.input ?? {}).includes("over-cap"))).toBe(true);
  });
});

describe("scenario harness - symmetric decline kinds", () => {
  for (const scenario of ["wrong-currency", "wrong-category"] as const) {
    it(`operator-set ${scenario} reaches the typed simulate and declines; the model only executes`, async () => {
      const captured: ModelRequest[] = [];
      const { call, approve, audit } = setup(modelFromScript(["read_state", "issue_card", "execute_purchase", "finish"], captured));
      const approval = await approve();
      const r = await call("/api/agent-run", { caseId: "case_acme", approval, scenario });
      expect(r.status).toBe(200);
      const d = await r.json();
      expect(d.run.ok).toBe(true); // documented decline is a decisive completed outcome
      expect(d.run.steps.join(",")).toContain("execute_purchase -> 200");
      const events = audit.list().map((e: any) => JSON.stringify(e));
      expect(events.some((e: string) => e.includes("authorization_attempt") && e.includes(`\"kind\":\"${scenario}\"`))).toBe(true);
      expect(events.some((e: string) => e.includes("agent_run_started") && e.includes(`\"scenario\":\"${scenario}\"`))).toBe(true);
      expect(JSON.stringify(d.case)).toContain("declined");
      const toolUses = captured.flatMap((req) => req.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []))
        .filter((b: any) => b.type === "tool_use");
      expect(toolUses.every((b: any) => !JSON.stringify(b.input ?? {}).includes(scenario))).toBe(true);
    });
  }
});
