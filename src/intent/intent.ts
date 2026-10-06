import { createHash, randomUUID } from "node:crypto";
import type { Cadence, PurchaseIntent, Terms } from "../domain/types.js";

// Canonical hashing for terms and intents. The approver sees exact terms; the hash is what the
// approval binds to, so changing any field - price, cadence, cap, currency, category - produces a
// different hash and the old approval no longer matches.

const canonTerms = (t: Terms) => JSON.stringify([t.monthlyPrice, t.annualPrice, t.currency, t.category, t.noticeDays]);
export const hashTerms = (t: Terms) => createHash("sha256").update(canonTerms(t)).digest("hex");

export const hashIntent = (i: PurchaseIntent) =>
  createHash("sha256").update(JSON.stringify([i.vendor, i.cadence, i.amountCap, i.currency, [...i.categories].sort(), i.termsHash])).digest("hex");

export function mintIntent(args: {
  vendor: string; cadence: Cadence; amountCap: number; currency: string;
  categories: string[]; terms: Terms; reconsiderAt: string | null;
}): PurchaseIntent {
  return {
    id: `intent_${randomUUID()}`,
    vendor: args.vendor,
    cadence: args.cadence,
    amountCap: args.amountCap,
    currency: args.currency,
    categories: [...args.categories].sort(),
    termsHash: hashTerms(args.terms),
    reconsiderAt: args.reconsiderAt,
  };
}
