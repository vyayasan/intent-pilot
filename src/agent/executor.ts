import { z } from "zod";
import type { Block, Message, ModelClient, ToolSpec } from "./model.js";

// The execution agent carries an APPROVED purchase intent to completion: it issues the card
// bound to the approval, executes the in-policy purchase, reads the outcome and stops.
// It is a goal-directed tool-use loop, not a script: the model reads live state and chooses
// the next step. Every hard bound lives in code outside the model:
//   - it only runs on a case a person already approved (checked by the caller before start);
//   - the approval artifact comes from the human's approval action, never from the model;
//   - amounts, currency and categories are derived server-side from the approved intent -
//     the model cannot name an amount, a merchant, a card limit or a new destination;
//   - each mutating tool fires at most once per run; an ambiguous outcome ends the run -
//     the existing authorization lock then governs retries, never the model;
//   - the agent can never approve, reject, change terms, freeze, close or reconcile-manually.
// Notifications are emitted by the existing outbox on each state change, not by the agent.

export const EXEC_TOOLS: ToolSpec[] = [
  { name: "read_state", description: "Read the live case state: intent, card, transactions, locks. Read-only.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "issue_card", description: "Issue the card bound to the human's approval. One shot. Only valid while no active card exists.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "execute_purchase", description: "Execute the approved purchase on the issued card: exactly the approved vendor, category, currency, at most the approved cap. One shot. Only valid with an ACTIVE card.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "finish", description: "End the run with a plain-language summary of what happened and anything a person must do.",
    input_schema: { type: "object", properties: { summary: { type: "string", description: "Max 600 characters." } }, required: ["summary"] } },
];

export const EXEC_SYSTEM_PROMPT = [
  "You are the execution agent inside IntentPay. A person has already approved this purchase intent.",
  "Your goal: carry that exact approved intent to completion - issue the card from the approval, execute the purchase, then finish with an honest summary.",
  "Always act by calling a tool, never in prose. Call one tool per reply and read the result before choosing the next.",
  "You cannot set amounts, vendors, currencies, categories, limits or recipients; the server derives all of them from the approved intent.",
  "You cannot approve anything, change the deal, unfreeze, or retry. If a tool reports an error, an unresolved outcome or a lock, do not retry that action - finish and say what a person must do.",
  "A documented decline is a completed outcome, not a failure to retry: report it and finish.",
  "Keep the run short: read_state first, then issue_card, then execute_purchase, then finish. Never call the same mutating tool twice.",
].join("\n");

export interface ExecutorCallApi { (path: string, body: unknown): Promise<{ status: number; body: any }> }

export interface AgentRunResult {
  ok: boolean;
  /** One line per executed step, in order - the run's own provenance. */
  steps: string[];
  summary?: string;
  error?: string;
  /** True when the run ended on a lock/unresolved outcome a person must reconcile. */
  needsReconcile?: boolean;
}

const MAX_STEPS = 8;

export async function runAgent(
  model: ModelClient,
  caseId: string,
  approval: unknown,
  callApi: ExecutorCallApi,
  opts: { maxSteps?: number } = {},
): Promise<AgentRunResult> {
  const steps: string[] = [];
  const used = new Set<string>();
  let needsReconcile = false;
  // Decisive-operation completion: true ONLY on a successful response carrying the final
  // transaction. Attempted is never complete (review I1/v3).
  let purchaseCompleted = false;

  const messages: Message[] = [{ role: "user", content: `Case ${caseId} is approved. Carry the approved intent to completion now.` }];
  const maxSteps = opts.maxSteps ?? MAX_STEPS;

  // Serial by construction: one tool per reply, awaited before the next model call - no
  // concurrent mutations exist inside a run, so terms cannot change beneath an in-flight tool.
  const callTool = async (name: string): Promise<{ content: string; isError?: boolean }> => {
    if ((name === "issue_card" || name === "execute_purchase") && used.has(name)) {
      steps.push(`${name} refused - already fired this run`); // refusals are provenance too
      return { isError: true, content: `${name} already fired this run. One shot only - do not retry; finish instead.` };
    }
    if (name === "read_state") {
      const r = await callApi("/api/cases?view=one&caseId=" + encodeURIComponent(caseId), undefined).catch((e) => ({ status: 0, body: { error: String(e) } }));
      // GET via the same handler; fall back to the full list when the single-case view is not routed.
      const b = r.status === 200 ? r.body : (await callApi("/api/cases", undefined)).body;
      const c = (b.cases ?? [b.case]).filter(Boolean).find((x: any) => (x.kase?.id ?? x.id) === caseId) ?? b;
      steps.push("read_state");
      return { content: JSON.stringify(c).slice(0, 6000) };
    }
    if (name === "issue_card") {
      used.add(name);
      const r = await callApi("/api/create-card", { approval });
      steps.push(`issue_card -> ${r.status}`);
      // REVIEW LIMITATION (I2, deferred with main's sign-off): reconcile-detection is a string
      // match on the route's error body, not a typed state. Fails safe: a refusal we don't
      // recognize still ends the run without card; a following execute_purchase on a missing
      // card is itself refused and flips needsReconcile. Typed error codes need an api.ts
      // contract change - deferred to keep this patch minimal before live staging.
      if (r.status !== 200) needsReconcile = /unresolved|reconcile/i.test(JSON.stringify(r.body));
      return { isError: r.status !== 200, content: JSON.stringify(r.body).slice(0, 4000) };
    }
    if (name === "execute_purchase") {
      const r = await callApi("/api/simulate", { caseId, kind: "in-policy" });
      const body = JSON.stringify(r.body);
      // A pre-gateway refusal ("create the card first") never reached the provider: the shot is
      // NOT consumed - the model may correct the sequence. Anything past this point reached the
      // gateway or left its outcome unknown: strict one-shot from here, no retry ever.
      if (r.status === 409 && /create the card first/i.test(body)) {
        steps.push(`execute_purchase -> 409 (pre-gateway refusal, shot preserved)`);
        return { isError: true, content: body.slice(0, 4000) };
      }
      used.add(name);
      steps.push(`execute_purchase -> ${r.status}`);
      // Completion is DECISIVE only: the route's 200 carries the final transaction (cleared OR
      // documented decline - both completed outcomes). Everything else (4xx/5xx error codes,
      // unconfirmed capture) is an unknown or locked outcome: stop, never call this complete.
      if (r.status === 200 && r.body && r.body.transaction) {
        purchaseCompleted = true;
        return { content: body.slice(0, 4000) };
      }
      needsReconcile = true;
      return { isError: true, content: body.slice(0, 4000) };
    }
    return { isError: true, content: `unknown tool ${name}` };
  };

  for (let step = 0; step < maxSteps; step++) {
    let blocks: Block[];
    try {
      blocks = await model.step({ system: EXEC_SYSTEM_PROMPT, messages, tools: EXEC_TOOLS });
    } catch (e) {
      return { ok: false, steps, needsReconcile, error: `model call failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const uses = blocks.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    if (uses.length === 0) {
      if (step === maxSteps - 1) return { ok: false, steps, needsReconcile, error: "model did not call a tool" };
      messages.push({ role: "assistant", content: blocks }, { role: "user", content: "Call exactly one tool now. Do not answer in prose." });
      continue;
    }
    const u = uses[0]; // one action per reply keeps the run auditable step by step
    if (u.name === "finish") {
      const parsed = z.object({ summary: z.string().max(600) }).safeParse(u.input);
      const summary = parsed.success ? parsed.data.summary : "run finished";
      steps.push("finish");
      // ok means a DECISIVE completed operation, never an attempt: an ambiguous money outcome
      // (needsReconcile) or a run that never reached a final transaction is not "complete".
      return { ok: purchaseCompleted && !needsReconcile, steps, summary, needsReconcile };
    }
    if (!EXEC_TOOLS.some((t) => t.name === u.name)) {
      messages.push({ role: "assistant", content: blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: u.id, is_error: true, content: "unknown tool" }] });
      continue;
    }
    const result = await callTool(u.name);
    messages.push({ role: "assistant", content: blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: u.id, content: result.content, is_error: result.isError }] });
    // A lock or unresolved outcome is a stop condition, decided in code: give the model one
    // chance to finish honestly, then cut the run regardless.
    if (needsReconcile && u.name !== "read_state") {
      messages.push({ role: "user", content: "The last action left the outcome unresolved or locked. Call finish now with what a person must do. Do not call any other tool." });
    }
  }
  return { ok: false, steps, needsReconcile, error: "run exceeded its step budget" };
}
