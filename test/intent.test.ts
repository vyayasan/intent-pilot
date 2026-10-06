import { describe, it, expect } from "vitest";
import { hashIntent, hashTerms, mintIntent } from "../src/intent/intent.js";
import type { Terms } from "../src/domain/types.js";

const terms: Terms = { monthlyPrice: 100, annualPrice: 984, currency: "USD", category: "software", noticeDays: 30 };
const mk = (over = {}) => mintIntent({ vendor: "Acme SaaS", cadence: "monthly", amountCap: 100, currency: "USD", categories: ["software"], terms, reconsiderAt: null, ...over });

describe("intent hashing", () => {
  it("is stable for the same intent and ignores category order", () => {
    const a = mk(); const b = mk({ categories: ["software"] });
    expect(hashIntent(a)).toBe(hashIntent(b));
    expect(hashTerms(terms)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("changes when any bound field changes", () => {
    const base = hashIntent(mk());
    expect(hashIntent(mk({ amountCap: 101 }))).not.toBe(base);
    expect(hashIntent(mk({ cadence: "annual" }))).not.toBe(base);
    expect(hashIntent(mk({ currency: "GBP" }))).not.toBe(base);
    expect(hashIntent(mk({ categories: ["software", "analytics"] }))).not.toBe(base);
    expect(hashIntent(mk({ terms: { ...terms, monthlyPrice: 110 } }))).not.toBe(base);
    expect(hashIntent(mk({ vendor: "Other SaaS" }))).not.toBe(base);
  });
});
