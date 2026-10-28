import type { NotificationRecord, Outbox } from "./outbox.js";
import { AmbiguousMailFailure, type EmailTransport, type DeliveryReceipt } from "./transport.js";

type AuditHook = (event: string, detail: Record<string, unknown>, caseId?: string) => void;

/**
 * Delivers outbox records through the selected transport. Money-safe philosophy applied to mail:
 * a record that reached "sent"/"dry-run" is NEVER sent again by deliver() (even after a restart,
 * because the status is persisted), and a failed delivery stays failed for operator review.
 *
 * Mode changes do not bridge themselves: a dry-run receipt is not a delivery, and a record that
 * is dry-run when the operator later selects a real transport is NOT sent automatically - that
 * would be a blind first send. The only bridge is promote(): explicit, operator-approved,
 * recorded in the audit log, and stamped on the receipt.
 */
export class NotificationDispatcher {
  /** outbox is a getter because a simulator demo reset replaces the outbox instance. */
  constructor(
    private getOutbox: () => Outbox,
    private transport: EmailTransport | null,
    private now: () => Date = () => new Date(),
    private onAudit?: AuditHook
  ) {}

  /** The transport when it can really send (not preview, not dry-run). */
  get realTransport(): EmailTransport | null {
    return this.transport && this.transport.name !== "dry-run" ? this.transport : null;
  }

  /** Best-effort: delivery outcomes are recorded on the record; the workflow never throws on mail. */
  async deliver(record: NotificationRecord): Promise<void> {
    if (!this.transport) return; // preview default: nothing is sent
    const outbox = this.getOutbox();
    const current = outbox.get(record.id);
    if (!current) return;
    if (current.status === "sent") return; // delivered once, never again
    if (current.status === "failed") return; // operator reviews before any resend
    // A dry-run is NOT a delivery. It must neither masquerade as sent nor silently suppress the
    // first real send after a mode switch - so deliver() never touches it again in any mode.
    if (current.status === "dry-run") return;
    await this.attempt(current);
  }

  private async attempt(current: NotificationRecord, promoted?: DeliveryReceipt["promoted"]) {
    const outbox = this.getOutbox();
    const base = { transport: this.transport!.name, at: this.now().toISOString() };
    try {
      const r = await this.transport!.send(current);
      const status = this.transport!.name === "dry-run" ? "dry-run" : "sent";
      outbox.mark(current.id, status, { ...base, status, providerId: r.providerId, ambiguous: false, ...(promoted ? { promoted } : {}) } as DeliveryReceipt);
    } catch (e) {
      const ambiguous = e instanceof AmbiguousMailFailure;
      outbox.mark(current.id, "failed", { ...base, status: "failed", error: (e as Error).message.slice(0, 300), ambiguous } as DeliveryReceipt);
    }
    return outbox.get(current.id);
  }

  /**
   * Explicit, operator-approved promotion of a dry-run record to a real send. The caller gates
   * this on an operator credential; the promotion is written to the audit log and stamped on the
   * receipt so the record shows it was a human decision, not a mode side-effect.
   */
  async promote(id: string, opts: { operator: string }) {
    const transport = this.realTransport;
    if (!transport) throw new Error("promotion needs a real email transport selected (current mode cannot send)");
    const outbox = this.getOutbox();
    const current = outbox.get(id);
    if (!current) throw new Error("notification not found");
    if (current.status !== "dry-run") throw new Error(`only a dry-run record can be promoted (current: ${current.status})`);
    const at = this.now().toISOString();
    this.onAudit?.("email_promoted", { notificationId: id, operator: opts.operator, from: "dry-run", transport: transport.name }, current.caseId);
    return this.attempt(current, { from: "dry-run", at, operator: opts.operator });
  }
}
