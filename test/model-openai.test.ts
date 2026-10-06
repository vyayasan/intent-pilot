import { describe, it, expect } from "vitest";
import { OpenAICompatibleModel, modelFromEnv } from "../src/agent/model.js";
import { extractTerms } from "../src/agent/planner.js";
import type { PurchaseCase } from "../src/domain/types.js";

const kase: PurchaseCase = {
  id: "case_acme", vendor: "Acme Analytics",
  rawTerms: "Acme Analytics Pro: $100 per month, or $984 per year billed upfront (save 18%). 30 days notice on monthly plans. Billed in USD. Category: software.",
};
const forecast = { weeklyBalances: [1500, 1500, 1500, 1500, 1500, 1500, 1400, 1400, 1400, 1400, 1400, 1400], reserveFloor: 500 };
const NOW = new Date("2026-10-06T09:00:00Z");

/** A fetch stub that plays an OpenAI-compatible server and records what it was sent. */
function fakeServer(replies: any[]) {
  const seen: any[] = [];
  const fetchImpl = async (_url: any, init: any) => {
    seen.push(JSON.parse(init.body));
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const readTermsReply = { choices: [{ message: { role: "assistant", content: null, tool_calls: [
  { id: "call_1", type: "function", function: { name: "read_terms", arguments: JSON.stringify({ case_id: "case_acme" }) } },
] } } ] };

const proposal = {
  cadence: "monthly", confidence: 0.7,
  rationale: "The text offers 100 per month or 984 per year. Annual breaches the reserve floor in week 7, so monthly keeps the cash free.",
  extracted_terms: { monthlyPrice: 100, annualPrice: 984, currency: "USD", category: "software", noticeDays: 30 },
  cited_facts: ["$100 per month", "$984 per year billed upfront"],
  rubric: {
    cash_fit: { score: 4, cites: ["$984 per year billed upfront"], note: "annual billed upfront; the forecast says the floor breaks in week 7" },
    terms_clarity: { score: 5, cites: ["$100 per month", "$984 per year"], note: "both prices, currency and notice are explicit" },
    vendor_signals: { score: 3, cites: ["30 days notice on monthly plans"], note: "ordinary terms" },
    policy_fit: { score: 4, cites: ["Category: software"], note: "inside policy categories" },
  },
};
const proposeReply = { choices: [{ message: { role: "assistant", content: null, tool_calls: [
  { id: "call_2", type: "function", function: { name: "propose_terms", arguments: JSON.stringify(proposal) } },
] } } ] };

describe("OpenAICompatibleModel", () => {
  it("requires a base URL and a model", () => {
    expect(() => new OpenAICompatibleModel({ baseUrl: "", model: "x" })).toThrow();
    expect(() => new OpenAICompatibleModel({ baseUrl: "http://x", model: "" })).toThrow();
  });

  it("translates tools and tool_use blocks to and from the OpenAI shape", async () => {
    const { seen, fetchImpl } = fakeServer([readTermsReply, proposeReply]);
    const model = new OpenAICompatibleModel({ baseUrl: "http://fake.local/v1/", model: "oss-model", fetchImpl });
    const result = await extractTerms(model, kase, forecast, { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.proposal?.extracted_terms.monthlyPrice).toBe(100);
    expect(result.gate?.accepted).toBe(true);

    // First call: system + user, function tools, no key header needed.
    expect(seen[0].messages[0].role).toBe("system");
    expect(seen[0].messages[1]).toEqual({ role: "user", content: expect.stringContaining("case_acme") });
    expect(seen[0].tools[0].function.name).toBe("read_terms");
    expect(seen[0].tool_choice).toBe("auto");

    // Second call: assistant tool_calls echoed back, then a tool message with the terms JSON.
    const roles = seen[1].messages.map((m: any) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    const assistant = seen[1].messages[2];
    expect(assistant.tool_calls[0].function.name).toBe("read_terms");
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ case_id: "case_acme" });
    const toolMsg = seen[1].messages[3];
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(toolMsg.content).toContain("vendor_terms");
  });

  it("surfaces prose replies so the planner can nudge back to the tools", async () => {
    const { fetchImpl } = fakeServer([
      { choices: [{ message: { role: "assistant", content: "The answer is monthly.", tool_calls: [] } } ] },
      proposeReply,
    ]);
    const model = new OpenAICompatibleModel({ baseUrl: "http://fake.local/v1", model: "oss-model", fetchImpl });
    const result = await extractTerms(model, kase, forecast, { now: NOW });
    expect(result.ok).toBe(true);
  });

  it("drops tool calls whose arguments are not valid JSON", async () => {
    const { fetchImpl } = fakeServer([
      { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "call_9", type: "function", function: { name: "propose_terms", arguments: "{not json" } },
      ] } } ] },
      proposeReply,
    ]);
    const model = new OpenAICompatibleModel({ baseUrl: "http://fake.local/v1", model: "oss-model", fetchImpl });
    const result = await extractTerms(model, kase, forecast, { now: NOW });
    expect(result.ok).toBe(true);
  });

  it("fails closed on provider errors without leaking the request", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { type: "rate_limit_exceeded" } }), { status: 429 })) as unknown as typeof fetch;
    const model = new OpenAICompatibleModel({ baseUrl: "http://fake.local/v1", model: "oss-model", fetchImpl, apiKey: "sk-secret" });
    const result = await extractTerms(model, kase, forecast, { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("429");
    expect(result.error).not.toContain("sk-secret");
  });

  it("never puts the API key in error messages", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 500 })) as unknown as typeof fetch;
    const model = new OpenAICompatibleModel({ baseUrl: "http://fake.local/v1", model: "oss-model", fetchImpl, apiKey: "sk-secret" });
    const result = await extractTerms(model, kase, forecast, { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("sk-secret");
  });
});

describe("modelFromEnv", () => {
  it("prefers the Anthropic client when both backends are configured", () => {
    const m = modelFromEnv({ ANTHROPIC_API_KEY: "k", EXTRACTION_BASE_URL: "http://x", EXTRACTION_MODEL: "y" });
    expect(m?.constructor.name).toBe("AnthropicModel");
  });
  it("builds the OpenAI-compatible client from EXTRACTION_* when no Anthropic key is set", () => {
    const m = modelFromEnv({ EXTRACTION_BASE_URL: "http://x", EXTRACTION_MODEL: "y" });
    expect(m?.constructor.name).toBe("OpenAICompatibleModel");
  });
  it("needs both EXTRACTION_BASE_URL and EXTRACTION_MODEL", () => {
    expect(modelFromEnv({ EXTRACTION_BASE_URL: "http://x" })).toBeUndefined();
    expect(modelFromEnv({ EXTRACTION_MODEL: "y" })).toBeUndefined();
    expect(modelFromEnv({})).toBeUndefined();
  });
});
