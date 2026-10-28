import { createHash, randomBytes } from "node:crypto";
import type { DeliveryReceipt } from "./transport.js";

/**
 * Notification outbox: the exact emails IntentPay WOULD send at each workflow
 * step, rendered deterministically and stored for review.
 *
 * NOTHING IS SENT. There is no transport here and no live email integration.
 * A real send path (user-approved provider, approved recipients and wording)
 * would consume these records; until then they are previews only.
 */

export type NotificationKind =
  | "approval_issued"
  | "card_created"
  | "deal_changed_frozen"
  | "reapproval_required"
  | "purchase_cleared"
  | "purchase_declined"
  | "gateway_outage"
  | "recommendation_rejected";

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  caseId: string;
  to: string;
  subject: string;
  body: string;
  sha256: string;
  createdAt: string;
  /** "preview" while no transport is selected (nothing is sent). A transport moves a record to
   *  sent / dry-run / failed; failed stays failed for operator review - never a blind resend.
   *  A dry-run record is never auto-sent after a mode switch; only explicit operator promotion
   *  (NotificationDispatcher.promote) bridges it to a real send, with audit + receipt stamp. */
  status: "preview" | "sent" | "failed" | "dry-run";
  receipt?: DeliveryReceipt;
}

export interface NotificationInput {
  caseId: string;
  vendor: string;
  recipient: string;
  detail: Record<string, string | number>;
}

const SUBJECTS: Record<NotificationKind, (i: NotificationInput) => string> = {
  approval_issued: (i) => `Intent approved: ${i.vendor} (${i.detail.cadence}, cap ${i.detail.cap} ${i.detail.currency})`,
  card_created: (i) => `Card issued inside approved intent: ${i.vendor}`,
  deal_changed_frozen: (i) => `Deal changed: ${i.vendor} card frozen, approval invalidated`,
  reapproval_required: (i) => `Re-approval needed: ${i.vendor} terms changed`,
  purchase_cleared: (i) => `Purchase cleared inside intent: ${i.detail.amount} ${i.detail.currency} at ${i.vendor}`,
  purchase_declined: (i) => `Purchase declined by intent controls: ${i.detail.amount} ${i.detail.currency} at ${i.vendor}`,
  gateway_outage: (i) => `Action needed: payment gateway outcome unknown for ${i.vendor}`,
  recommendation_rejected: (i) => `Case rejected: ${i.vendor} - no card was created`
};

const BODIES: Record<NotificationKind, (i: NotificationInput) => string> = {
  approval_issued: (i) =>
    `The ${i.vendor} purchase intent was approved by ${i.detail.approver}.\n` +
    `Cadence: ${i.detail.cadence}. Cap: ${i.detail.cap} ${i.detail.currency} per transaction. Categories: ${i.detail.categories}.\n` +
    `Terms hash: ${i.detail.termsHash}. Cards can only be created inside this exact approval.`,
  card_created: (i) =>
    `A card was issued for ${i.vendor} inside the approved intent.\n` +
    `Controls mirror the approval: limit ${i.detail.limit} per transaction, currencies ${i.detail.currencies}, categories ${i.detail.categories}.`,
  deal_changed_frozen: (i) =>
    `The ${i.vendor} terms changed. The old approval no longer matches the deal, so the card was frozen and the approval invalidated.\n` +
    `Freeze read-back: ${i.detail.freezeState}. No new card can be created until a person approves the new deal.`,
  reapproval_required: (i) =>
    `The ${i.vendor} deal changed and needs a human re-approval before any new spend.\n` +
    `New terms: ${i.detail.newTerms}. The old card stays frozen meanwhile.`,
  purchase_cleared: (i) =>
    `${i.detail.amount} ${i.detail.currency} at ${i.vendor} cleared inside the approved intent (cap ${i.detail.cap} ${i.detail.currency}).`,
  purchase_declined: (i) =>
    `${i.detail.amount} ${i.detail.currency} at ${i.vendor} was declined by the card's intent controls (${i.detail.reason}).`,
  gateway_outage: (i) =>
    `An authorization for ${i.vendor} could not be confirmed (${i.detail.error}).\n` +
    `The outcome is unknown. Reconcile the card's transactions before retrying to avoid a duplicate.`,
  recommendation_rejected: (i) =>
    `The ${i.vendor} purchase intent was rejected by ${i.detail.approver}.\n` +
    `Reason: ${i.detail.reason}.\n` +
    `No card was created and no spend can happen on this case.`
};

export class Outbox {
  private static seq = 0;
  private readonly records: NotificationRecord[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  emit(kind: NotificationKind, input: NotificationInput): NotificationRecord {
    const subject = SUBJECTS[kind](input);
    const body = BODIES[kind](input);
    const sha256 = createHash("sha256").update(JSON.stringify({ kind, subject, body, caseId: input.caseId })).digest("hex");
    const record: NotificationRecord = {
      // Content hash + unique suffix: two identical REAL events must NOT collapse onto one id
      // (review: notification identity collision). sha256 stays the content-integrity field.
      id: `ntf_${sha256.slice(0, 12)}_${(Outbox.seq++).toString(36)}_${randomBytes(3).toString("hex")}`,
      kind, caseId: input.caseId, to: input.recipient, subject, body, sha256,
      createdAt: this.now().toISOString(), status: "preview"
    };
    this.records.push(record);
    return { ...record };
  }

  /** Restore persisted records after a restart. Delivery statuses survive, so a notification that
   *  was sent (or dry-run delivered, or failed) is never re-sent blindly after a reboot. */
  restore(records: unknown) {
    if (!Array.isArray(records)) return;
    for (const r of records as NotificationRecord[]) {
      if (r && typeof r.id === "string" && typeof r.subject === "string") {
        const status = r.status === "sent" || r.status === "failed" || r.status === "dry-run" ? r.status : "preview";
        this.records.push({ ...r, status, receipt: r.receipt && typeof r.receipt === "object" ? { ...r.receipt } : undefined });
      }
    }
  }

  get(id: string): NotificationRecord | undefined {
    const r = this.records.find((x) => x.id === id);
    return r ? { ...r } : undefined;
  }

  /** Record a delivery outcome. Returns false when the record is unknown. */
  mark(id: string, status: NotificationRecord["status"], receipt: DeliveryReceipt): boolean {
    const r = this.records.find((x) => x.id === id);
    if (!r) return false;
    r.status = status;
    r.receipt = { ...receipt };
    return true;
  }

  list(caseId?: string): NotificationRecord[] {
    return this.records.filter((r) => !caseId || r.caseId === caseId).map((r) => ({ ...r }));
  }
}
