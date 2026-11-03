import { it, expect } from "vitest";
import { runAgent } from "../src/agent/executor.js";
import type { ModelClient } from "../src/agent/model.js";

it("blocks every subsequent tool after an unknown issuance, even when the model ignores the stop", async () => {
  const script = ["issue_card", "execute_purchase", "read_state", "finish"];
  let i = 0;
  const model: ModelClient = { step: async () => [{ type: "tool_use", id: String(i), name: script[i++], input: { summary: "done" } }] };
  const paths: string[] = [];
  const run = await runAgent(model, "c", {}, async (p) => { paths.push(p); return { status: 502, body: { error: "issuance outcome unknown; reconcile" } }; });
  expect(paths).toEqual(["/api/create-card"]);
  expect(run.needsReconcile).toBe(true);
  expect(run.ok).toBe(false);
});
it("does not accept a malformed 200 transaction as a final purchase", async () => {
  let i = 0;
  const model: ModelClient = { step: async () => [{ type: "tool_use", id: String(i), name: ["execute_purchase", "finish"][i++], input: { summary: "done" } }] };
  const run = await runAgent(model, "c", {}, async () => ({ status: 200, body: { transaction: { status: "PENDING" } } }));
  expect(run.ok).toBe(false); expect(run.needsReconcile).toBe(true);
});
