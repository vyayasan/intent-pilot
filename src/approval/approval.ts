import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { hashIntent } from "../intent/intent.js";
import type { PurchaseIntent } from "../domain/types.js";

// An approval is bound to one intent exactly: case, vendor, cadence, cap, currency, categories,
// the terms hash and the policy version. Change the deal and the approval no longer matches.
export interface Approval {
  caseId: string; intentId: string; intentHash: string; termsHash: string;
  amountCap: number; currency: string; cadence: string; categories: string[];
  policyVersion: string; approver: string; expiresAt: string; nonce: string; rationale: string; sig: string;
}
type Body = Omit<Approval, "sig">;

const canon = (b: Body) => JSON.stringify([b.caseId, b.intentId, b.intentHash, b.termsHash, b.amountCap, b.currency,
  b.cadence, [...b.categories].sort(), b.policyVersion, b.approver, b.expiresAt, b.nonce, b.rationale]);
const sign = (b: Body, key: string) => createHmac("sha256", key).update(canon(b)).digest("hex");

export function issue(caseId: string, intent: PurchaseIntent, policyVersion: string,
  approver: string, key: string, ttlMs: number, now = new Date(), rationale = ""): Approval {
  const body: Body = { caseId, intentId: intent.id, intentHash: hashIntent(intent), termsHash: intent.termsHash,
    amountCap: intent.amountCap, currency: intent.currency, cadence: intent.cadence, categories: [...intent.categories].sort(),
    policyVersion, approver, expiresAt: new Date(now.getTime() + ttlMs).toISOString(), nonce: randomUUID(), rationale: rationale.slice(0, 1024) };
  return { ...body, sig: sign(body, key) };
}

export class ApprovalVerifier {
  // nonce -> expiry (ms). Entries are pruned once the approval could no longer pass the expiry check anyway.
  private used = new Map<string, number>();
  constructor(private key: string) {}
  // Returns null if the approval may be executed against the LIVE intent, else the refusal reason.
  check(a: Approval, liveCaseId: string, live: PurchaseIntent, policyVersion: string, now = new Date()): string | null {
    this.prune(now);
    const { sig, ...body } = a;
    const good = Buffer.from(sign(body, this.key)); const got = Buffer.from(String(sig));
    if (good.length !== got.length || !timingSafeEqual(good, got)) return "bad signature";
    if (this.used.has(a.nonce)) return "approval already used";
    if (Date.parse(a.expiresAt) <= now.getTime()) return "approval expired";
    if (a.caseId !== liveCaseId) return "case mismatch";
    if (a.intentId !== live.id) return "intent mismatch";
    if (a.termsHash !== live.termsHash) return "terms changed";
    if (a.intentHash !== hashIntent(live)) return "intent changed";
    if (a.policyVersion !== policyVersion) return "policy version changed";
    return null;
  }
  consume(a: Approval) { this.used.set(a.nonce, Date.parse(a.expiresAt)); }
  get size() { return this.used.size; }
  private prune(now: Date) { for (const [n, exp] of this.used) if (exp <= now.getTime()) this.used.delete(n); }
}
