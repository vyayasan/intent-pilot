// Contract intake: how vendor terms reach the agent in production. Nobody copy-pastes in the real flow - the
// contract arrives from wherever it was signed: an in-app upload, a PDF, a vendor email, or an e-sign webhook.
// Every path produces the same thing: untrusted text plus a provenance string for the audit log. The extraction
// and governance layers downstream do not care which path the text took.

export type IntakeSource = "upload" | "pdf" | "email" | "esign-webhook";
export interface IntakeResult { ok: boolean; rawTerms?: string; provenance?: string; error?: string }

const MAX_TERMS_CHARS = 20_000;
const clean = (text: string): string | undefined => {
  const t = text.replace(/[\x00-\x1f]+/g, " ").trim();
  return t.length > 0 && t.length <= MAX_TERMS_CHARS ? t : undefined;
};
const fail = (error: string): IntakeResult => ({ ok: false, error });

/** In-app upload: the signed contract file (or its text) dropped into the console by someone in ops. */
export function fromUpload(filename: string, text: string, at: Date = new Date()): IntakeResult {
  const rawTerms = clean(text);
  return rawTerms ? { ok: true, rawTerms, provenance: `uploaded file ${filename} at ${at.toISOString()}` } : fail("upload had no usable text");
}

/** A PDF contract. Text extraction is pluggable: hosts bring their own extractor (OCR for scans, a text-layer
 * reader for digital PDFs). Without one the path fails closed and says so - a silent empty extraction is worse. */
export type PdfExtractor = (bytes: Uint8Array, filename: string) => Promise<string>;
export async function fromPdf(filename: string, bytes: Uint8Array, extractor?: PdfExtractor, at: Date = new Date()): Promise<IntakeResult> {
  if (!extractor) return fail("no PDF extractor configured: bring an OCR or text-layer reader for this path");
  const rawTerms = clean(await extractor(bytes, filename));
  return rawTerms ? { ok: true, rawTerms, provenance: `PDF ${filename} at ${at.toISOString()}` } : fail("PDF produced no usable text");
}

/** A vendor email carrying the terms (pricing page quote, order form, renewal notice). */
export function fromEmail(mail: { from: string; subject: string; text: string; receivedAt?: string }): IntakeResult {
  const rawTerms = clean(mail.text);
  return rawTerms
    ? { ok: true, rawTerms, provenance: `email from ${mail.from} ("${mail.subject.slice(0, 80)}") at ${mail.receivedAt ?? new Date().toISOString()}` }
    : fail("email had no usable text");
}

/** An e-sign webhook (DocuSign-shaped): envelope.completed means the contract is signed; the document itself is
 * then fetched from the e-sign API. The webhook proves signing happened; it is not the terms text. */
export interface EsignEnvelope { envelopeId: string; status: string; subject?: string }
export function fromEsignWebhook(payload: { event: string; data?: EsignEnvelope }): IntakeResult {
  const env = payload.data;
  if (!env?.envelopeId) return fail("webhook carried no envelope");
  if (payload.event !== "envelope-completed" || env.status !== "completed")
    return fail(`envelope ${env.envelopeId} is ${env.status ?? "unknown"}, not completed`);
  return { ok: false, error: `envelope ${env.envelopeId} completed: fetch the signed document from the e-sign API, then ingest it as PDF` };
}
