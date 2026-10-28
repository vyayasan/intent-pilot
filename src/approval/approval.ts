import { createHash, createHmac, randomUUID, sign as signDetached, timingSafeEqual, verify as verifyDetached } from "node:crypto";
import { hashIntent } from "../intent/intent.js";
import type { PurchaseIntent } from "../domain/types.js";

// An approval is bound to one intent exactly: case, vendor, cadence, cap, currency, categories,
// the terms hash and the policy version. Change the deal and the approval no longer matches.
export interface Approval {
  caseId: string; intentId: string; intentHash: string; termsHash: string;
  amountCap: number; currency: string; cadence: string; categories: string[];
  policyVersion: string; approver: string; expiresAt: string; nonce: string; rationale: string; sig: string;
  /** Set when the console runs with an approver keypair: the approver's own ed25519 signature over the
   *  canonical body + server sig, and the fingerprint of the approver's public key. Demo-grade local
   *  identity - production binds approvals to SSO; this makes "only they can approve" real locally. */
  approverKeyId?: string;
  approverSig?: string;
}
type Body = Omit<Approval, "sig">;

const canon = (b: Body) => JSON.stringify([b.caseId, b.intentId, b.intentHash, b.termsHash, b.amountCap, b.currency,
  b.cadence, [...b.categories].sort(), b.policyVersion, b.approver, b.expiresAt, b.nonce, b.rationale]);
const sign = (b: Body, key: string) => createHmac("sha256", key).update(canon(b)).digest("hex");

/** Fingerprint of an approver public key: stable identity shown in the console and audit trail. */
export const approverKeyId = (publicKeyPem: string) => createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 12);

export function issue(caseId: string, intent: PurchaseIntent, policyVersion: string,
  approver: string, key: string, ttlMs: number, now = new Date(), rationale = "",
  approverKey?: { privateKeyPem: string; keyId: string }): Approval {
  const body: Body = { caseId, intentId: intent.id, intentHash: hashIntent(intent), termsHash: intent.termsHash,
    amountCap: intent.amountCap, currency: intent.currency, cadence: intent.cadence, categories: [...intent.categories].sort(),
    policyVersion, approver, expiresAt: new Date(now.getTime() + ttlMs).toISOString(), nonce: randomUUID(), rationale: rationale.slice(0, 1024) };
  const sig = sign(body, key);
  if (!approverKey) return { ...body, sig };
  // The approver signs the canonical body AND the server sig: neither half alone is a valid approval.
  const approverSig = signDetached(null, Buffer.from(canon(body) + "." + sig), approverKey.privateKeyPem).toString("base64");
  return { ...body, sig, approverKeyId: approverKey.keyId, approverSig };
}

export class ApprovalVerifier {
  // nonce -> expiry (ms). Entries are pruned once the approval could no longer pass the expiry check anyway.
  private used = new Map<string, number>();
  /** When approverPublicKeyPem is set, every approval MUST carry a valid approver signature. */
  constructor(private key: string, private approverPublicKeyPem?: string) {}
  // Returns null if the approval may be executed against the LIVE intent, else the refusal reason.
  check(a: Approval, liveCaseId: string, live: PurchaseIntent, policyVersion: string, now = new Date()): string | null {
    this.prune(now);
    const { sig, ...body } = a;
    const good = Buffer.from(sign(body, this.key)); const got = Buffer.from(String(sig));
    if (good.length !== got.length || !timingSafeEqual(good, got)) return "bad signature";
    if (this.approverPublicKeyPem) {
      if (!a.approverSig || !a.approverKeyId) return "missing approver signature";
      let ok = false;
      try { ok = verifyDetached(null, Buffer.from(canon(body) + "." + a.sig), this.approverPublicKeyPem, Buffer.from(a.approverSig, "base64")); } catch { ok = false; }
      if (!ok) return "bad approver signature";
    }
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
  /** Persist/restore consumed nonces so a process restart cannot replay a used approval. */
  snapshot(): [string, number][] { return [...this.used]; }
  restore(entries: [string, number][]) { for (const [n, exp] of entries) this.used.set(n, exp); }
  get size() { return this.used.size; }
  private prune(now: Date) { for (const [n, exp] of this.used) if (exp <= now.getTime()) this.used.delete(n); }
}
