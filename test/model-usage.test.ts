import { describe, it, expect } from "vitest";
import { AnthropicModel, modelFromEnv } from "../src/agent/model.js";

const stubFetch = (usage: { input_tokens: number; output_tokens: number }) =>
  (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

const req = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

describe("model usage capture", () => {
  it("AnthropicModel reports the response usage to the onUsage hook", async () => {
    const seen: Array<{ input_tokens?: number; output_tokens?: number }> = [];
    const m = new AnthropicModel({ apiKey: "k", fetchImpl: stubFetch({ input_tokens: 12, output_tokens: 5 }), onUsage: (u) => seen.push(u) });
    await m.step(req);
    expect(seen).toEqual([{ input_tokens: 12, output_tokens: 5 }]);
  });

  it("no hook means no report, and a response without usage reports nothing", async () => {
    const noUsage = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 })) as typeof fetch;
    const m = new AnthropicModel({ apiKey: "k", fetchImpl: noUsage });
    await expect(m.step(req)).resolves.toEqual([{ type: "text", text: "ok" }]);
  });

  it("modelFromEnv passes the usage hook through to the Anthropic client it builds", async () => {
    const seen: Array<{ input_tokens?: number; output_tokens?: number }> = [];
    const m = modelFromEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "m-test" }, { onUsage: (u) => seen.push(u), fetchImpl: stubFetch({ input_tokens: 7, output_tokens: 3 }) });
    expect(m).toBeDefined();
    await m!.step(req);
    expect(seen).toEqual([{ input_tokens: 7, output_tokens: 3 }]);
  });
});
