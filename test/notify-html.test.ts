import { describe, expect, it } from "vitest";
import { Outbox, NOTIFICATION_KINDS, type NotificationInput } from "../src/notify/outbox.js";
import { renderNotificationHtml } from "../src/notify/html.js";
import { renderMime } from "../src/notify/gmailTransport.js";

const input = (detail: NotificationInput["detail"]): NotificationInput => ({
  caseId: "case_x", vendor: "Acme Analytics", recipient: "sandi@vyayasan.com", detail,
});
const FULL: NotificationInput["detail"] = {
  approver: "sandi@vyayasan.com", cadence: "monthly", cap: 100, currency: "USD",
  categories: "5734", termsHash: "abc123", limit: "100 USD", currencies: "USD",
  freezeState: "verified", newTerms: "new deal", amount: "42.00", reason: "over cap", error: "timeout",
};

describe("notification HTML rendering", () => {
  it("renders every kind non-empty with the vendor, escaped", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const html = renderNotificationHtml(kind, input(FULL));
      expect(html.length).toBeGreaterThan(500);
      expect(html).toContain("Acme Analytics");
      expect(html).toContain("IntentPay");
    }
  });
  it("escapes all interpolated values (no markup injection)", () => {
    const evil = input({ ...FULL, cadence: 'monthly<script>alert(1)</script>" onload="' });
    const html = renderNotificationHtml("approval_issued", { ...evil, vendor: '<b>evil</b>' });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
  });
  it("mirrors the plain-text facts (cap, currency, terms hash) for approval_issued", () => {
    const html = renderNotificationHtml("approval_issued", input(FULL));
    expect(html).toContain("100 USD per transaction");
    expect(html).toContain("abc123");
    expect(html).toContain("authenticated approver session sandi@vyayasan.com");
  });
  it("carries no Airwallex branding in the sender identity, only factual footer attribution", () => {
    const html = renderNotificationHtml("card_created", input(FULL));
    expect(html).toContain("Airwallex sandbox"); // factual attribution line
    expect(html).not.toMatch(/from\s+airwallex|airwallex\s+support|sent by airwallex/i);
  });
  it("outbox records carry html alongside canonical plain text; MIME renders multipart/alternative", () => {
    const r = new Outbox().emit("card_created", input(FULL));
    expect(r.html).toBeTruthy();
    const mime = renderMime(r);
    expect(mime).toContain("multipart/alternative");
    const parts = mime.split(/Content-Transfer-Encoding: base64\r?\n\r?\n/).slice(1);
    const decoded = parts.map((p) => Buffer.from(p.split(/\r?\n/)[0], "base64").toString("utf8"));
    expect(decoded[0]).toBe(r.body); // plain part unchanged
    expect(decoded[1]).toBe(r.html);
  });
  it("records without html keep the single-part text/plain render", () => {
    const r = { ...new Outbox().emit("card_created", input(FULL)) };
    delete r.html;
    const mime = renderMime(r);
    expect(mime).not.toContain("multipart/alternative");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
  });
});
