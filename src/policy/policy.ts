import { z } from "zod";
import type { Cadence, CardControls, CashForecast, PurchaseIntent, Terms } from "../domain/types.js";

export const PolicySchema = z.object({
  version: z.string(),
  forecastWeeks: z.number().int().positive(), // horizon the cash projection covers
  billingEveryWeeks: z.number().int().positive(), // monthly cadence bills at weeks 0, 4, 8, ...
  // The reserve floor and the forecast inputs are configured here; the sandbox does not enforce them.
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({
  version: "2026-10-06.1", forecastWeeks: 12, billingEveryWeeks: 4,
});

export interface CadenceDecision {
  cadence: Cadence | "ESCALATE";
  reasons: string[];
  savingsPct: number | null; // annual vs monthly over the horizon
  /** 1-based week numbers ("week seven" is the seventh week of the projection), matching the guide's prose. */
  annualBreachWeek: number | null;
  monthlyBreachWeek: number | null;
  reconsiderAt: string | null; // ISO date when the annual choice deserves a second look
}

// Weekly balances after a cadence's charges: annual bills once in week 0, monthly bills every
// billingEveryWeeks starting week 0. Balances beyond the projection are not invented.
function adjustedBalances(base: number[], terms: Terms, cadence: Cadence, pol: Policy): number[] | null {
  if (cadence === "annual") {
    if (terms.annualPrice == null) return null;
    // Paid upfront in week 0 and stays paid: every later week carries the same reduction.
    return base.map((b) => b - (terms.annualPrice as number));
  }
  if (terms.monthlyPrice == null) return null;
  return base.map((b, w) => b - chargesUpTo(w, terms.monthlyPrice as number, pol.billingEveryWeeks));
}
const chargesUpTo = (week: number, monthly: number, every: number) => (Math.floor(week / every) + 1) * monthly;

/** First projection index (0-based) whose adjusted balance drops below the reserve floor, or null. Callers presenting to people add 1. */
export function breachWeek(base: number[], terms: Terms, cadence: Cadence, floor: number, pol: Policy): number | null {
  const adj = adjustedBalances(base, terms, cadence, pol);
  if (!adj) return null;
  const i = adj.findIndex((b) => b < floor);
  return i === -1 ? null : i;
}

/** First week from which the baseline cash could absorb the annual hit and never breach the floor afterwards. */
export function reconsiderWeek(base: number[], annualPrice: number, floor: number): number | null {
  for (let w = 0; w < base.length; w++) {
    if (base.slice(w).every((b) => b - annualPrice >= floor)) return w;
  }
  return null;
}

export function decide(terms: Terms, forecast: CashForecast, pol: Policy, now = new Date()): CadenceDecision {
  const out = (cadence: Cadence | "ESCALATE", reasons: string[], extra: Partial<CadenceDecision> = {}): CadenceDecision => ({
    cadence, reasons, savingsPct: null, annualBreachWeek: null, monthlyBreachWeek: null, reconsiderAt: null, ...extra,
  });

  // Fail closed on malformed inputs before any economics are computed.
  const prices = [terms.monthlyPrice, terms.annualPrice];
  if (prices.some((p) => p != null && (!Number.isFinite(p) || p < 0)))
    return out("ESCALATE", [`invalid price in terms (${prices.map((p) => String(p)).join("/")}): a person must check the source data`]);
  if (!/^[A-Z]{3}$/.test(terms.currency))
    return out("ESCALATE", [`unrecognised currency code "${String(terms.currency).slice(0, 12)}": reserve math is not defined for it`]);
  if (terms.monthlyPrice == null || terms.annualPrice == null)
    return out("ESCALATE", ["terms are missing a monthly or annual price: a person must read the vendor page"]);
  if (!Number.isFinite(forecast.reserveFloor) || forecast.reserveFloor < 0 || forecast.weeklyBalances.length === 0)
    return out("ESCALATE", ["cash forecast is missing or malformed: a person must supply the projection"]);

  const horizon = Math.min(pol.forecastWeeks, forecast.weeklyBalances.length);
  const base = forecast.weeklyBalances.slice(0, horizon);
  const floor = forecast.reserveFloor;

  const a0 = breachWeek(base, terms, "annual", floor, pol);
  const m0 = breachWeek(base, terms, "monthly", floor, pol);
  const annualBreachWeek = a0 == null ? null : a0 + 1; // 1-based for people
  const monthlyBreachWeek = m0 == null ? null : m0 + 1;
  const yearlyMonthly = terms.monthlyPrice * 12;
  const savingsPct = Math.round(((yearlyMonthly - terms.annualPrice) / yearlyMonthly) * 1000) / 10;

  if (annualBreachWeek != null && monthlyBreachWeek != null)
    return out("ESCALATE", [`both cadences breach the reserve floor (annual week ${annualBreachWeek}, monthly week ${monthlyBreachWeek}): a person decides`], { savingsPct, annualBreachWeek, monthlyBreachWeek });

  if (annualBreachWeek != null) {
    const rw = reconsiderWeek(base, terms.annualPrice, floor); // 0-based index; the date marks the start of that week
    const reconsiderAt = rw == null ? null : new Date(now.getTime() + rw * 7 * 86_400_000).toISOString().slice(0, 10);
    return out("monthly", [
      `annual saves ${savingsPct}% but breaches the reserve floor in week ${annualBreachWeek}`,
      rw == null ? "cash never absorbs the annual price inside the forecast: revisit at renewal" : `cash can absorb the annual price from week ${rw + 1}: reconsider on ${reconsiderAt}`,
    ], { savingsPct, annualBreachWeek, monthlyBreachWeek, reconsiderAt });
  }

  return out("annual", [`annual saves ${savingsPct}% and never breaches the reserve floor`], { savingsPct, annualBreachWeek, monthlyBreachWeek });
}

/** The card payload derives from the approved intent and nothing else. Per-transaction limits are inclusive. */
export function cardPayload(intent: PurchaseIntent): CardControls {
  return {
    amountLimit: intent.amountCap,
    currencyAllowlist: [intent.currency],
    merchantCategories: [...intent.categories].sort(),
  };
}

/** A transaction equal to the limit clears: the per-transaction limit is inclusive. */
export const withinLimit = (amount: number, limit: number) => amount <= limit;
