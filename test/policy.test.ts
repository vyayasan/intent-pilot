import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, breachWeek, cardPayload, decide, reconsiderWeek, withinLimit } from "../src/policy/policy.js";
import { mintIntent } from "../src/intent/intent.js";
import type { CashForecast, Terms } from "../src/domain/types.js";

// The Builder Guide scenario: annual costs 18% less but breaches the reserve floor in week 7.
const terms: Terms = { monthlyPrice: 100, annualPrice: 984, currency: "USD", category: "software", noticeDays: 30 };
// Baseline sits just above the floor: an upfront 984 drops the seventh week below it, 100 every 4 weeks does not.
const floor = 500;
// Weeks one to six absorb the 984 annual hit (1500 - 984 = 516 >= 500); week seven does not (1400 - 984 = 416 < 500).
// Reported week numbers are 1-based, matching the guide's prose; raw breachWeek/reconsiderWeek stay 0-based indexes.
const balances = [1500, 1500, 1500, 1500, 1500, 1500, 1400, 1400, 1400, 1400, 1400, 1400];
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
    expect(d.annualBreachWeek).toBe(8); // index 7, reported 1-based
    expect(d.reconsiderAt).not.toBeNull();
    expect(reconsiderWeek(recovering, 984, floor)).toBe(8); // raw 0-based index
  });

  it("escalates when both cadences breach", () => {
    const poor: CashForecast = { weeklyBalances: balances.map((b) => b - 900), reserveFloor: floor, breachWeek: null };
    expect(decide(terms, poor, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
  });

  it("fails closed on bad prices, currency and forecast", () => {
    expect(decide({ ...terms, monthlyPrice: NaN }, forecast, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
    expect(decide({ ...terms, annualPrice: -5 }, forecast, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
    expect(decide({ ...terms, currency: "usd" }, forecast, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
    expect(decide({ monthlyPrice: null, annualPrice: null, currency: "USD", category: "software", noticeDays: 30 }, forecast, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
    expect(decide(terms, { weeklyBalances: [], reserveFloor: floor, breachWeek: null }, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
  });

  it("treats a monthly-only offer as complete pricing, not missing data", () => {
    const monthlyOnly: Terms = { ...terms, annualPrice: null };
    const d = decide(monthlyOnly, forecast, DEFAULT_POLICY, now);
    expect(d.cadence).toBe("monthly");
    expect(d.savingsPct).toBeNull();
    expect(d.annualBreachWeek).toBeNull();
    expect(d.reasons[0]).toMatch(/monthly billing only/);
  });

  it("escalates a monthly-only offer that breaches the floor, with the breach week", () => {
    const tight: CashForecast = { weeklyBalances: balances.map((b) => b - 950), reserveFloor: floor, breachWeek: null };
    const d = decide({ ...terms, annualPrice: null }, tight, DEFAULT_POLICY, now);
    expect(d.cadence).toBe("ESCALATE");
    expect(d.monthlyBreachWeek).toBe(1);
    expect(d.reasons[0]).toMatch(/monthly billing only.*breaches.*week 1/);
  });

  it("treats an annual-only offer as complete pricing, not missing data", () => {
    const rich: CashForecast = { weeklyBalances: balances.map((b) => b + 2000), reserveFloor: floor, breachWeek: null };
    const d = decide({ ...terms, monthlyPrice: null }, rich, DEFAULT_POLICY, now);
    expect(d.cadence).toBe("annual");
    expect(d.savingsPct).toBeNull();
    expect(d.reasons[0]).toMatch(/annual billing only/);
  });

  it("escalates an annual-only offer that breaches, noting when cash could absorb it if deferred", () => {
    const d = decide({ ...terms, monthlyPrice: null }, forecast, DEFAULT_POLICY, now);
    expect(d.cadence).toBe("ESCALATE");
    expect(d.annualBreachWeek).toBe(7);
    expect(d.reasons.join(" ")).toMatch(/never absorbs/);
    const recovering = [1500, 1500, 1500, 1500, 1500, 1500, 1500, 1400, 1500, 1600, 1700, 1800];
    const d2 = decide({ ...terms, monthlyPrice: null }, { weeklyBalances: recovering, reserveFloor: floor, breachWeek: null }, DEFAULT_POLICY, now);
    expect(d2.cadence).toBe("ESCALATE");
    expect(d2.reasons.join(" ")).toMatch(/from week 9 if the purchase is deferred/);
  });

  it("fails closed on a zero price: a trial or a data error", () => {
    expect(decide({ ...terms, monthlyPrice: 0 }, forecast, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
    expect(decide({ ...terms, annualPrice: 0 }, forecast, DEFAULT_POLICY, now).cadence).toBe("ESCALATE");
  });

  it("computes breach weeks from the projection", () => {
    expect(breachWeek(balances, terms, "annual", floor, DEFAULT_POLICY)).toBe(6); // raw 0-based index
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
