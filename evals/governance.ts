import { gate, ProposalSchema, type GateResult } from "../src/agent/planner.js";
import { DEFAULT_POLICY } from "../src/policy/policy.js";
import { forecast, type GovScenario } from "./govscenarios.js";

export type GovOutcome = { id: string; pass: boolean; detail: string; result: GateResult };

// Run one scripted proposal through the same gate the console uses: guardrails, rubric, reasoning
// checks and the policy comparison all live inside gate.
export function runGov(s: GovScenario, now: Date): GovOutcome {
  const proposal = ProposalSchema.parse(s.proposal);
  const result = gate(proposal, s.kase, forecast, DEFAULT_POLICY, now);
  const pass = result.accepted === s.expectAccepted && result.finalCadence === s.expectCadence;
  const gov = result.governance;
  const detail = `accepted=${result.accepted} cadence=${result.finalCadence} guardrails=[${(gov?.guardrailViolations ?? []).map((x) => x.check).join(",")}] reasoning=[${(gov?.reasoningViolations ?? []).map((x) => x.check).join(",")}] band=${gov?.rubric?.band ?? "-"} reasons=${result.reasons.join("; ")}`;
  return { id: s.id, pass, detail, result };
}
