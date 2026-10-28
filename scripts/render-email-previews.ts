// Renders every notification kind to standalone HTML files for design review.
// PREVIEW ONLY - nothing is sent; this writes local files under runs/email-previews/.
// Facts from the 27 Oct sandbox run (Todoist, annual, 60 USD cap, MCC 5734, terms hash prefix)
// are real; transaction amounts and changed-deal terms are illustrative stand-ins for layout.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderNotificationHtml } from "../src/notify/html.js";
import { NOTIFICATION_KINDS, type NotificationInput } from "../src/notify/outbox.js";

const base = { caseId: "case_todoist_7dd38f", vendor: "Todoist", recipient: "sandi@vyayasan.com" };
const DETAILS: Record<string, NotificationInput["detail"]> = {
  approval_issued: { approver: "sandi@vyayasan.com", cadence: "annual", cap: 60, currency: "USD", categories: "5734 - Computer software stores", termsHash: "376fd477a12a39a8...", cardState: "none" },
  card_created: { limit: "60 USD", currencies: "USD", categories: "5734 - Computer software stores" },
  deal_changed_frozen: { freezeState: "verified - provider read-back INACTIVE", newTerms: "Todoist Business, annual, 3 seats, auto-renew", cardState: "frozen" },
  reapproval_required: { newTerms: "Todoist Business, annual, 3 seats, auto-renew", cardState: "none" },
  purchase_cleared: { amount: "48.00", currency: "USD", cap: 60 },
  purchase_declined: { amount: "125.00", currency: "USD", reason: "exceeds the approved per-transaction limit of 60 USD" },
  gateway_outage: { error: "400 bad_request: failed to process transaction" },
  recommendation_rejected: { approver: "sandi@vyayasan.com", reason: "Vendor is not on the approved software list", cardState: "none" },
};

const dir = resolve("runs/email-previews");
mkdirSync(dir, { recursive: true });
// EVERY preview is labeled as what it is: a design preview, never a sent email. Kinds whose
// preview values are illustrative stand-ins (not from a real run) say so additionally, so a
// screenshot can never read as a real notification merely because the vendor/hash are real.
const SAMPLED = new Set(["purchase_cleared", "purchase_declined", "deal_changed_frozen", "reapproval_required", "recommendation_rejected"]);
const banner = (sampled: boolean) =>
  `<div style="max-width:560px;margin:0 auto 10px;padding:6px 10px;border:1px dashed #b54708;border-radius:8px;font:600 11px/1.4 ui-monospace,Menlo,monospace;color:#b54708;background:#fffaeb;">DESIGN PREVIEW - not a sent email.` +
  (sampled ? ` Highlighted amounts, deal terms or reasons are sample values, not from a real run.` : ``) + `</div>`;
const render = (name: string, kind: (typeof NOTIFICATION_KINDS)[number], detail: NotificationInput["detail"]) => {
  const html = renderNotificationHtml(kind, { ...base, detail }).replace(
    '<div style="background:#f0f2f3;padding:28px 12px;">',
    '<div style="background:#f0f2f3;padding:28px 12px;">' + banner(SAMPLED.has(name.split("__")[0])));
  writeFileSync(resolve(dir, `${name}.html`), html);
  console.log("rendered", name);
};
for (const kind of NOTIFICATION_KINDS) render(kind, kind, DETAILS[kind]);
// Conditional-branch variants that need their own visual check.
render("deal_changed_frozen__closed", "deal_changed_frozen", { ...DETAILS.deal_changed_frozen, cardState: "closed" });
render("recommendation_rejected__closed", "recommendation_rejected", { ...DETAILS.recommendation_rejected, cardState: "closed" });
render("approval_issued__closed", "approval_issued", { ...DETAILS.approval_issued, cardState: "closed" });
render("approval_issued__frozen", "approval_issued", { ...DETAILS.approval_issued, cardState: "frozen" });
