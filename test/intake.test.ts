import { describe, it, expect } from "vitest";
import { fromUpload, fromPdf, fromEmail, fromEsignWebhook } from "../src/intake/intake.js";

const terms = "Acme Analytics Pro: $100 per month, or $984 per year billed upfront. 30 days notice. USD.";

describe("contract intake", () => {
  it("ingests an in-app upload with provenance", () => {
    const r = fromUpload("acme-order-form.txt", terms, new Date("2026-10-06T12:00:00Z"));
    expect(r.ok).toBe(true);
    expect(r.rawTerms).toBe(terms);
    expect(r.provenance).toContain("acme-order-form.txt");
  });
  it("ingests a vendor email with sender provenance", () => {
    const r = fromEmail({ from: "sales@acme.example", subject: "Your order form", text: terms, receivedAt: "2026-10-06T11:00:00Z" });
    expect(r.ok).toBe(true);
    expect(r.provenance).toContain("sales@acme.example");
  });
  it("PDF path fails closed without an extractor, extracts with one", async () => {
    expect((await fromPdf("contract.pdf", new Uint8Array([1, 2]))).ok).toBe(false);
    const r = await fromPdf("contract.pdf", new Uint8Array([1, 2]), async () => terms);
    expect(r.ok).toBe(true);
    expect(r.provenance).toContain("contract.pdf");
  });
  it("e-sign webhook: only a completed envelope proceeds, and the document fetch is explicit", () => {
    expect(fromEsignWebhook({ event: "envelope-completed", data: { envelopeId: "env-1", status: "completed" } }).error).toContain("fetch the signed document");
    expect(fromEsignWebhook({ event: "envelope-sent", data: { envelopeId: "env-1", status: "sent" } }).ok).toBe(false);
    expect(fromEsignWebhook({ event: "envelope-completed", data: undefined }).ok).toBe(false);
  });
  it("rejects empty and oversized text", () => {
    expect(fromUpload("x.txt", "   ").ok).toBe(false);
    expect(fromUpload("x.txt", "a".repeat(21_000)).ok).toBe(false);
  });
});
