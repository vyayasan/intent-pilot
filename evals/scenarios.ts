import type { CashForecast, Terms } from "../src/domain/types.js";

export type PolicyScenario = {
  id: string; family: string; summary: string;
  terms: Terms; forecast: CashForecast;
  expected: "monthly" | "annual" | "ESCALATE";
  expectBreachWeek?: number | null;
  expectReconsider: boolean;
  why: string;
  securityExpectation?: boolean;
};

export const evalNow = new Date("2026-10-06T12:00:00.000Z");

const fc = (weeklyBalances: number[], reserveFloor = 500): CashForecast => ({ weeklyBalances, reserveFloor, breachWeek: null });
// Weeks 0-6 absorb the 984 annual hit; week 7 does not. The Builder Guide scenario.
const guideForecast = fc([1500, 1500, 1500, 1500, 1500, 1500, 1500, 1400, 1400, 1400, 1400, 1400]);
const rich = fc(Array(12).fill(3000));
const poor = fc(Array(12).fill(600));
const recovering = fc([1500, 1500, 1500, 1500, 1500, 1500, 1500, 1400, 1500, 1600, 1700, 1800]);
const terms = (over: Partial<Terms> = {}): Terms => ({ monthlyPrice: 100, annualPrice: 984, currency: "USD", category: "software", noticeDays: 30, ...over });

// Deterministic policy contract fixtures.
export const scenarios: PolicyScenario[] = [
  { id: "guide-scenario", family: "builder guide", summary: "Annual saves 18% but breaches the floor in week 7", terms: terms(), forecast: guideForecast, expected: "monthly", expectBreachWeek: 7, expectReconsider: false, why: "The kit's own scenario: monthly keeps cash free, annual breaches in week 7." },
  { id: "rich-annual", family: "cadence", summary: "Healthy cash: annual wins", terms: terms(), forecast: rich, expected: "annual", expectBreachWeek: null, expectReconsider: false, why: "No breach under annual billing, and it is cheaper." },
  { id: "poor-escalate", family: "cadence", summary: "Tight cash: both cadences breach", terms: terms(), forecast: poor, expected: "ESCALATE", expectBreachWeek: 0, expectReconsider: false, why: "Monthly also breaches the floor quickly; a person must decide." },
  { id: "recovering-reconsider", family: "cadence", summary: "Cash recovers in week 8", terms: terms(), forecast: recovering, expected: "monthly", expectBreachWeek: 7, expectReconsider: true, why: "From week 8 the cash absorbs the annual price, so a reconsider date is recorded." },
  { id: "breach-at-floor-boundary", family: "boundary", summary: "Balance equal to the floor is not a breach", terms: terms({ annualPrice: 900 }), forecast: fc(Array(12).fill(1400)), expected: "annual", expectBreachWeek: null, expectReconsider: false, why: "1400 - 900 = 500 equals the floor; only a drop below breaches." },
  { id: "breach-week-zero", family: "boundary", summary: "Annual upfront hit breaches immediately", terms: terms({ annualPrice: 984 }), forecast: fc([1200, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000]), expected: "monthly", expectBreachWeek: 0, expectReconsider: true, why: "Week 0 cannot absorb the annual price even though later weeks can." },
  { id: "short-forecast", family: "boundary", summary: "Projection covers only 4 weeks", terms: terms(), forecast: fc([1500, 1500, 1500, 1500]), expected: "annual", expectBreachWeek: null, expectReconsider: false, why: "A shorter projection is used as-is; the horizon is the smaller of policy and projection, and nothing is invented beyond it." },
  { id: "no-discount-annual", family: "cadence", summary: "Annual price is not a discount", terms: terms({ annualPrice: 1200 }), forecast: rich, expected: "annual", expectBreachWeek: null, expectReconsider: false, why: "Annual equals twelve monthly payments; savings are 0% but cash is healthy, so the cheaper-or-equal cadence still wins. A guardrail warning flags the oddity." },
  { id: "nan-price", family: "fail closed", summary: "NaN monthly price", terms: terms({ monthlyPrice: NaN }), forecast: guideForecast, expected: "ESCALATE", why: "Malformed price: a person must check the source data.", securityExpectation: true },
  { id: "negative-price", family: "fail closed", summary: "Negative annual price", terms: terms({ annualPrice: -10 }), forecast: guideForecast, expected: "ESCALATE", why: "A negative price is a data error, not a bargain.", securityExpectation: true },
  { id: "bad-currency", family: "fail closed", summary: "Lowercase currency code", terms: terms({ currency: "usd" }), forecast: guideForecast, expected: "ESCALATE", why: "Reserve math is only defined for ISO codes.", securityExpectation: true },
  { id: "missing-price", family: "fail closed", summary: "Only one price found", terms: terms({ annualPrice: null }), forecast: guideForecast, expected: "ESCALATE", why: "The annual-vs-monthly comparison needs both prices.", securityExpectation: true },
  { id: "empty-forecast", family: "fail closed", summary: "No projection supplied", terms: terms(), forecast: fc([]), expected: "ESCALATE", why: "No forecast, no decision.", securityExpectation: true },
  { id: "negative-floor", family: "fail closed", summary: "Negative reserve floor", terms: terms(), forecast: fc([1500], -1), expected: "ESCALATE", why: "A negative floor is a misconfiguration.", securityExpectation: true },
];
