import { describe, expect, it } from "vitest";
import { decide, DEFAULT_POLICY } from "../src/policy/policy.js";
import { makeSim } from "../src/sim/simGateway.js";
import { scenarios, evalNow } from "./scenarios.js";
import { simScenarios } from "./simscenarios.js";
import { runGov } from "./governance.js";
import { govScenarios } from "./govscenarios.js";

describe("policy eval scenarios", () => {
  for (const s of scenarios) {
    it(`${s.id}: ${s.summary}`, () => {
      const d = decide(s.terms, s.forecast, DEFAULT_POLICY, evalNow);
      expect(d.cadence).toBe(s.expected);
      if (s.expected !== "ESCALATE") {
        expect(d.annualBreachWeek).toBe(s.expectBreachWeek ?? null);
        expect(d.reconsiderAt != null).toBe(s.expectReconsider);
      }
    });
  }
});
describe("card simulation eval scenarios", () => {
  for (const s of simScenarios) {
    it(`${s.id}: ${s.summary}`, () => {
      const sim = makeSim({ walletBalance: s.wallet });
      const holder = sim.createCardholder({ name: "Eval", email: "evals@example.com" });
      const card = sim.createCard({ cardholderId: holder.id, controls: { amountLimit: s.limit, currencyAllowlist: s.allowCurrencies, merchantCategories: s.allowCategories } });
      const t = sim.authorize(card.id, s.auth);
      expect(t.status).toBe(s.expectedStatus);
      if (s.expectedReason) expect(t.failureReason).toBe(s.expectedReason);
    });
  }
});
describe("governance eval scenarios", () => {
  for (const s of govScenarios) {
    it(`${s.id}: ${s.summary}`, () => {
      expect(runGov(s, evalNow).pass).toBe(true);
    });
  }
});
