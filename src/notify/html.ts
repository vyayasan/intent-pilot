import type { NotificationInput, NotificationKind } from "./outbox.js";

/**
 * HTML rendering for notification emails. The plain-text subject/body in outbox.ts stay the
 * canonical wording and fallback; this adds a designed HTML alternative (multipart/alternative)
 * so the emails read as a finished product surface instead of raw log lines.
 *
 * Design language matches the IntentPay console (same palette, same voice): dark ink header,
 * status chip, fact panel, provenance footer. It is deliberately NOT an Airwallex-branded
 * template: the footer attributes card issuing/controls to the Airwallex sandbox factually,
 * without implying Airwallex sent or endorsed the email.
 *
 * Everything interpolated is HTML-escaped. No external assets, no tracking pixels, no scripts:
 * inline styles only, so the render is deterministic and reviewable offline.
 */

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const FONT = "Inter,'Segoe UI',Arial,sans-serif";
const INK = "#101828";
const MUTED = "#667085";
const FAINT = "#98a2b3";
const BORDER = "#e4e7ea";
const PANEL = "#f9fafb";

interface Chip { label: string; fg: string; bg: string; }
const CHIPS: Record<string, Chip> = {
  good: { label: "", fg: "#067647", bg: "#ecfdf3" },
  warn: { label: "", fg: "#b54708", bg: "#fffaeb" },
  bad: { label: "", fg: "#b42318", bg: "#fef3f2" },
  neutral: { label: "", fg: "#344054", bg: "#f2f4f7" },
};

type Row = [string, string];

interface KindView {
  chip: Chip;
  title: string;
  intro: string;
  rows: Row[];
  note?: string;
}

const view = (kind: NotificationKind, i: NotificationInput): KindView => {
  const d = i.detail;
  switch (kind) {
    case "approval_issued":
      return {
        chip: { ...CHIPS.good, label: "APPROVED" },
        title: `Intent approved: ${esc(i.vendor)}`,
        intro: `The ${esc(i.vendor)} purchase intent was approved through the authenticated approver session ${esc(d.approver)}. Cards can only be created inside this exact approval.`,
        rows: [
          ["Vendor", esc(i.vendor)],
          ["Cadence", esc(d.cadence)],
          ["Spending cap", `${esc(d.cap)} ${esc(d.currency)} per transaction`],
          ["Allowed categories", esc(d.categories)],
          ["Terms hash", esc(d.termsHash)],
        ],
        note:
          d.cardState === "closed"
            ? "The old card is permanently closed - it can never transact again. A replacement card can only be created inside this exact approval."
            : d.cardState === "frozen"
              ? "The old card stays frozen and cannot transact. A new card can only be created inside this exact approval."
              : "If this approval was not expected, reject the case in the console; no card exists yet.",
      };
    case "card_created":
      return {
        chip: { ...CHIPS.good, label: "CARD ISSUED" },
        title: `Card issued inside approved intent`,
        intro: `A card was issued for ${esc(i.vendor)} inside the approved intent. Its controls mirror the approval exactly - the card cannot spend outside it.`,
        rows: [
          ["Vendor", esc(i.vendor)],
          ["Per-transaction limit", esc(d.limit)],
          ["Currencies", esc(d.currencies)],
          ["Allowed categories", esc(d.categories)],
        ],
        note: "Freeze the card at any time from the console; a freeze is verified by provider read-back before it is relied on.",
      };
    case "deal_changed_frozen":
      if (d.cardState === "closed")
        return {
          chip: { ...CHIPS.neutral, label: "CARD CLOSED" },
          title: `Deal changed: approval invalidated`,
          intro: `The ${esc(i.vendor)} terms changed. The old approval no longer matches the deal and is invalidated. The old card is permanently closed - it can never transact again.`,
          rows: [
            ["Vendor", esc(i.vendor)],
            ["Old card", "Permanently closed"],
            ["New terms", esc(d.newTerms)],
          ],
          note: "No new card can be created until a person approves the new deal.",
        };
      return {
        chip: { ...CHIPS.warn, label: "CARD FROZEN" },
        title: `Deal changed: card frozen, approval invalidated`,
        intro: `The ${esc(i.vendor)} terms changed. The old approval no longer matches the deal, so the card was frozen and the approval invalidated. No new card can be created until a person approves the new deal.`,
        rows: [
          ["Vendor", esc(i.vendor)],
          ["Freeze read-back", esc(d.freezeState)],
          ["New terms", esc(d.newTerms)],
        ],
      };
    case "reapproval_required":
      return {
        chip: { ...CHIPS.warn, label: "ACTION NEEDED" },
        title: `Re-approval needed: terms changed`,
        intro: `The ${esc(i.vendor)} deal changed and needs a human re-approval before any new spend.`,
        rows: [
          ["Vendor", esc(i.vendor)],
          ["New terms", esc(d.newTerms)],
        ],
        note: "No card exists on this case; no card can be created until a person approves the new deal.",
      };
    case "purchase_cleared":
      return {
        chip: { ...CHIPS.good, label: "CLEARED" },
        title: `Purchase cleared inside intent`,
        intro: `The purchase cleared inside the approved intent and within its cap.`,
        rows: [
          ["Vendor", esc(i.vendor)],
          ["Amount", `${esc(d.amount)} ${esc(d.currency)}`],
          ["Approved cap", `${esc(d.cap)} ${esc(d.currency)} per transaction`],
        ],
      };
    case "purchase_declined":
      return {
        chip: { ...CHIPS.bad, label: "DECLINED" },
        title: `Purchase declined`,
        intro: `The issuing gateway declined this purchase attempt (reason below).`,
        rows: [
          ["Vendor", esc(i.vendor)],
          ["Attempted amount", `${esc(d.amount)} ${esc(d.currency)}`],
          ["Decline reason", esc(d.reason)],
        ],
      };
    case "gateway_outage":
      return {
        chip: { ...CHIPS.bad, label: "ACTION NEEDED" },
        title: `Payment outcome unknown`,
        intro: `An authorization for ${esc(i.vendor)} could not be confirmed. The outcome is unknown: reconcile the card's transactions before retrying to avoid a duplicate. Nothing is retried automatically.`,
        rows: [
          ["Vendor", esc(i.vendor)],
          ["Provider error", esc(d.error)],
        ],
      };
    case "recommendation_rejected":
      if (d.cardState === "closed")
        return {
          chip: { ...CHIPS.neutral, label: "REJECTED" },
          title: `Case rejected`,
          intro: `The ${esc(i.vendor)} purchase intent was rejected through the authenticated approver session ${esc(d.approver)}. The card that was created on this case is permanently closed - it can never transact again. Any new spend would need a fresh approval.`,
          rows: [
            ["Vendor", esc(i.vendor)],
            ["Reason", esc(d.reason)],
            ["Old card", "Permanently closed"],
          ],
        };
      return {
        chip: { ...CHIPS.neutral, label: "REJECTED" },
        title: `Case rejected - no card was created`,
        intro: `The ${esc(i.vendor)} purchase intent was rejected through the authenticated approver session ${esc(d.approver)}. No card was created and no spend can happen on this case.`,
        rows: [
          ["Vendor", esc(i.vendor)],
          ["Reason", esc(d.reason)],
        ],
      };
  }
};

const rowHtml = ([label, value]: Row, last: boolean): string =>
  `<tr><td style="padding:9px 14px;${last ? "" : `border-bottom:1px solid ${BORDER};`}vertical-align:top;">` +
  `<div style="font:600 10px/1.2 ${FONT};letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">${label}</div>` +
  `<div style="font:400 13px/1.45 ${FONT};color:${INK};margin-top:2px;word-break:break-word;">${value}</div></td></tr>`;

export function renderNotificationHtml(kind: NotificationKind, i: NotificationInput): string {
  const v = view(kind, i);
  const rows = v.rows.map((r, idx) => rowHtml(r, idx === v.rows.length - 1)).join("");
  return [
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(v.title)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f0f2f3;">`,
    `<div style="background:#f0f2f3;padding:28px 12px;">`,
    `<div role="article" aria-label="IntentPay notification" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;font-family:${FONT};">`,
    // Header
    `<div style="padding:18px 20px;border-bottom:1px solid ${BORDER};">`,
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr>`,
    `<td style="width:30px;height:30px;background:${INK};border-radius:8px;text-align:center;vertical-align:middle;font:700 12px/30px ${FONT};color:#ffffff;">IP</td>`,
    `<td style="padding-left:10px;"><div style="font:600 15px/1.2 ${FONT};color:${INK};">IntentPay</div>`,
    `<div style="font:400 11px/1.3 ${FONT};color:${MUTED};">Intent-bound purchase agent</div></td>`,
    `</tr></table></div>`,
    // Body
    `<div style="padding:20px;">`,
    `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font:600 11px/1.4 ${FONT};letter-spacing:0.04em;color:${v.chip.fg};background:${v.chip.bg};">${v.chip.label}</span>`,
    `<h1 style="margin:10px 0 6px;font:600 17px/1.35 ${FONT};color:${INK};">${v.title}</h1>`,
    `<p style="margin:0 0 16px;font:400 13px/1.55 ${FONT};color:#475467;">${v.intro}</p>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:${PANEL};border:1px solid ${BORDER};border-radius:8px;border-collapse:separate;">${rows}</table>`,
    v.note ? `<p style="margin:14px 0 0;font:400 12px/1.5 ${FONT};color:${MUTED};">${v.note}</p>` : "",
    `</div>`,
    // Footer
    `<div style="padding:14px 20px;border-top:1px solid ${BORDER};font:400 11px/1.5 ${FONT};color:${FAINT};">`,
    `IntentPay &middot; intent-bound purchase agent<br>`,
    `Sandbox demonstration: card issuing and controls run on the Airwallex sandbox. No production money or live card network is involved.<br>`,
    `Reference ${esc(i.caseId)}`,
    `</div>`,
    `</div></div></body></html>`,
  ].join("");
}
