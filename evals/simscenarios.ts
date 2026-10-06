import type { AuthorizationRequest, CardTransactionStatus } from "../src/domain/types.js";

export type SimScenario = {
  id: string; family: string; summary: string;
  wallet: number; limit: number; allowCurrencies: string[]; allowCategories: string[];
  auth: AuthorizationRequest;
  expectedStatus: CardTransactionStatus; expectedReason?: string;
  why: string;
};

const buy = (over: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({ amount: 75, currency: "USD", merchant: "Acme", category: "software", ...over });
const base = { wallet: 1000, limit: 100, allowCurrencies: ["USD"], allowCategories: ["software"] };

export const simScenarios: SimScenario[] = [
  { id: "in-policy-clears", family: "controls", summary: "Inside the intent", ...base, auth: buy(), expectedStatus: "PENDING", why: "Controls pass and funding covers it." },
  { id: "at-limit-clears", family: "controls", summary: "Amount equal to the limit", ...base, auth: buy({ amount: 100 }), expectedStatus: "PENDING", why: "Per-transaction limits are inclusive; the funding check comes after." },
  { id: "over-cap-declined", family: "controls", summary: "One cent over the cap", ...base, auth: buy({ amount: 100.01 }), expectedStatus: "FAILED", expectedReason: "above_approved_cap", why: "The cap is the approved intent; above it the card says no." },
  { id: "wrong-currency", family: "controls", summary: "Off the currency allowlist", ...base, auth: buy({ currency: "EUR" }), expectedStatus: "FAILED", expectedReason: "currency_not_allowed", why: "The intent was approved in USD only." },
  { id: "wrong-category", family: "controls", summary: "Off the category allowlist", ...base, auth: buy({ category: "travel" }), expectedStatus: "FAILED", expectedReason: "category_not_allowed", why: "The intent covers software only." },
  { id: "funding-after-controls", family: "funding", summary: "At the limit with a smaller wallet", ...base, wallet: 50, auth: buy({ amount: 100 }), expectedStatus: "FAILED", expectedReason: "insufficient_funds", why: "Controls pass at the limit, then the funding check says no." },
  { id: "zero-amount", family: "fail closed", summary: "Zero amount", ...base, auth: buy({ amount: 0 }), expectedStatus: "FAILED", expectedReason: "above_approved_cap", why: "A non-positive amount is malformed, declined on the cap rule." },
  { id: "nan-amount", family: "fail closed", summary: "NaN amount", ...base, auth: buy({ amount: NaN }), expectedStatus: "FAILED", expectedReason: "above_approved_cap", why: "A non-finite amount fails closed." },
];
