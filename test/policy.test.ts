import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, breachWeek, cardPayload, decide, reconsiderWeek, withinLimit } from "../src/policy/policy.js";
import { mintIntent } from "../src/intent/intent.js";
import type { CashForecast, Terms } from "../src/domain/types.js";

// The Builder Guide scenario: annual costs 18% less but breaches the reserve floor in week 7.
const terms: Terms = { monthlyPrice: 100, annualPrice: 984, currency: "USD", category: "software", noticeDays: 30 };
// Baseline sits just above the floor: an upfront 984 drops week 7 below it, 100 every 4 weeks does not.
const floor = 500;
// Weeks 0-6 absorb the 984 annual hit (1500 - 984 = 516 >= 500); week 7 does not (1400 - 984 = 416 < 500).
const balances = [1500, 1500, 1500, 1500, 1500, 1500, 1500, 1400, 1400, 1400, 1400, 1400];
const forecast: CashForecast = { weeklyBalances: balances, reserveFloor: floor, breachWeek: null };
const now = new Date("2026-10-06T09:00:00Z");

describe("cadence decision", () => {
  it("chooses monthly when annual breaches the floor and records when to reconsider", () => {
    const d = decide(terms, forecast, DEFAULT_POLICY, now);
    expect(d.cadence).toBe("monthly");
    expect(d.annualBreachWeek).toBe(7);
    expect(d.monthlyBreachWeek).toBeNull();
    expect(d.savingsPct).toBeCloseTo(18, 0);
    expect(d.reconsiderAt).toBeNull(); // cash never absorbs 984 above the floor in this projection
    expect(d.reasons[0]).toContain("week 7");
  });

  it("chooses annual when nothing breaches", () => {
    const rich: CashForecast = { weeklyBalances: balances.map((b) => b + 2000), reserveFloor: floor, breachWeek: null };
    const d = decide(terms, rich, DEFAULT_POLICY, now);
    expect(d.cadence).toBe("annual");
    expect(d.reasons[0]).toContain("18%");
  });

  it("sets a reconsider date when the cash later absorbs the annual price", () => {
    const recovering = [1500, 1500, 1500, 1500, 1500, 1500, 1500, 1400, 1500, 1600, 1700, 1800];
    const d = decide(terms, { weeklyBalances: recovering, reserveFloor: floor, breachWeek: null }, DEFAULT_POLICY, now);
    expect(d.cadence).toBe("monthly");
    expect(d.annualBreachWeek).toBe(7);
    expect(d.reconsiderAt).not.toBeNull();
    expect(reconsiderWeek(recovering, 984, floor)).toBe(8);
  });

  it("escalates when both cadences breach", () => {
    const poor: CashForecast = { weeklyBalances: balances.map((b) => b - 900), reserveFloor: floor, breachWeek: null };
    expect(decide(terms, poor, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
  });

  it("fails closed on bad prices, currency and forecast", () => {
    expect(decide({ ...terms, monthlyPrice: NaN }, forecast, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
    expect(decide({ ...terms, annualPrice: -5 }, forecast, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
    expect(decide({ ...terms, currency: "usd" }, forecast, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
    expect(decide({ ...terms, monthlyPrice: null }, forecast, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
    expect(decide(terms, { weeklyBalances: [], reserveFloor: floor, breachWeek: null }, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
  });

  it("computes breach weeks from the projection", () => {
    expect(breachWeek(balances, terms, "annual", floor, DEFAULT_POLICY)).toBe(7);
    expect(breachWeek(balances, terms, "monthly", floor, DEFAULT_POLICY)).toBeNull();
  });
});

describe("card payload", () => {
  it("derives the controls from the approved intent", () => {
    const intent = mintIntent({ vendor: "Acme SaaS", cadence: "monthly", amountCap: 100, currency: "USD", categories: ["software"], terms, reconsiderAt: null });
    expect(cardPayload(intent)).toEqual({ amountLimit: 100, currencyAllowlist: ["USD"], merchantCategories: ["software"] });
  });

  it("treats the per-transaction limit as inclusive", () => {
    expect(withinLimit(100, 100)).toBe(true);
    expect(withinLimit(100.01, 100)).toBe(false);
  });
});
