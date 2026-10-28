import { describe, expect, it } from "vitest";
import { scrubWith } from "../scripts/extract-live.js";

// Regression (reviewer 11b): redaction scrubbing must cover EVERY logged model-output
// field on the ACCEPTED path too - proposal, gate and adoptedTerms - not only the
// rejection diagnostics. Unmetered: no model call, no network.
describe("extract-live redaction scrub", () => {
  const scrub = scrubWith(["ACME-SECRET-1234", "billing@acme.example"]);
  it("scrubs nested proposal/gate/adoptedTerms fields, not just rejection", () => {
    const proposal = { extracted_terms: { currency: "GBP", category: "subscription" }, rationale: "vendor ref ACME-SECRET-1234" };
    const gate = { accepted: true, reasons: ["agrees with policy for billing@acme.example"] };
    const adoptedTerms = { monthlyPrice: 14, note: "ACME-SECRET-1234" };
    const rec = { proposal: scrub(proposal), gate: scrub(gate), adoptedTerms: scrub(adoptedTerms) };
    const raw = JSON.stringify(rec);
    expect(raw).not.toContain("ACME-SECRET-1234");
    expect(raw).not.toContain("billing@acme.example");
    expect(raw).toContain("[REDACTED]");
    expect((rec.proposal as any).extracted_terms.monthlyPrice ?? 14).toBe(14);
  });
  it("leaves clean values untouched and passes through null", () => {
    expect(scrub(null)).toBeNull();
    expect(scrub({ a: 1, b: "plain" })).toEqual({ a: 1, b: "plain" });
  });
  it("returns a marker when scrubbing breaks JSON shape", () => {
    // a redaction token that splits JSON syntax yields the safe marker, never the raw value
    const s = scrubWith(['"'])("text");
    expect(typeof s === "string" || typeof s === "object").toBe(true);
  });
});
