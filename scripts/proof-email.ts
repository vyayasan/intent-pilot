/**
 * Real-email proof: sends ONE IntentPay approval email through the Gmail API transport and
 * verifies a documented positive-acceptance receipt (Message id). Runs ONLY with an explicit
 * self-recipient flag; never sends to a third party. Part of the sandbox-demo acceptance run:
 * arrival is verified separately via the owner's connected inbox (not this script).
 *
 * Required env: INTENTPAY_GMAIL_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN (owner-approved
 * Google OAuth client, gmail.send scope ONLY - see docs/gmail-transport-setup.md) AND
 * INTENTPAY_OWNER_EMAIL (the approved self recipient). The --to-self argument must EQUAL that
 * configured owner address exactly; any other address - valid or not - is refused. Note the
 * honesty boundary: "self" means the operator-configured owner address; the send itself stays
 * gated on the owner's explicit scoped approval, this script does not create it.
 * Usage: INTENTPAY_OWNER_EMAIL=owner@example.com npx tsx scripts/proof-email.ts --to-self owner@example.com
 */
import { createHash } from "node:crypto";
import { GmailApiTransport } from "../src/notify/gmailTransport.js";
import { AmbiguousMailFailure, DefiniteMailFailure } from "../src/notify/transport.js";
import type { NotificationRecord } from "../src/notify/outbox.js";

const to = process.argv.find((a, i) => process.argv[i - 1] === "--to-self");
const owner = process.env.INTENTPAY_OWNER_EMAIL;
if (!owner) { console.error("refusing: INTENTPAY_OWNER_EMAIL is not set - the approved self recipient must be configured explicitly"); process.exit(2); }
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error("refusing: pass exactly one recipient via --to-self, and it must equal INTENTPAY_OWNER_EMAIL");
  process.exit(2);
}
if (to.toLowerCase() !== owner.toLowerCase()) {
  console.error(`refusing: --to-self (${to}) is not the configured owner address - third-party recipients are never sent from this proof`);
  process.exit(2);
}
for (const v of ["INTENTPAY_GMAIL_CLIENT_ID", "INTENTPAY_GMAIL_CLIENT_SECRET", "INTENTPAY_GMAIL_REFRESH_TOKEN"])
  if (!process.env[v]) { console.error(`refusing: ${v} is not set (owner-approved Google client - see docs/gmail-transport-setup.md)`); process.exit(2); }

const record = {
  id: `proof-${Date.now()}`,
  createdAt: new Date().toISOString(),
  status: "pending",
  kind: "approval_requested",
  caseId: `email-proof-${new Date().toISOString().slice(0, 10)}`,
  to: to!,
  subject: "IntentPay approval request [SANDBOX DEMO]",
  body: [
    "IntentPay (Airwallex Agentic Banking Hackathon, sandbox demo) is requesting approval.",
    "",
    "This email was generated and sent by the IntentPay notification pipeline through the",
    "documented Gmail API (users.messages.send) with a send-only OAuth scope. It is a",
    "transport proof only - no purchase, card or money movement is attached to it.",
  ].join("\n"),
  sha256: "",
} as unknown as NotificationRecord;
record.sha256 = createHash("sha256").update(JSON.stringify({ kind: record.kind, subject: record.subject, body: record.body, caseId: record.caseId })).digest("hex");

const transport = new GmailApiTransport({
  clientId: process.env.INTENTPAY_GMAIL_CLIENT_ID!,
  clientSecret: process.env.INTENTPAY_GMAIL_CLIENT_SECRET!,
  refreshToken: process.env.INTENTPAY_GMAIL_REFRESH_TOKEN!,
});
try {
  const receipt = await transport.send(record);
  console.log(`SENT - documented positive-acceptance receipt, Gmail Message id: ${receipt.providerId}`);
  console.log(`case: ${record.caseId} | to: ${to} | verify arrival in the recipient inbox to complete the loop`);
} catch (e) {
  if (e instanceof DefiniteMailFailure) { console.error(`DEFINITE not-sent: ${e.message}`); process.exit(1); }
  if (e instanceof AmbiguousMailFailure) { console.error(`AMBIGUOUS - outcome unknown, do NOT resend blindly: ${e.message}`); process.exit(3); }
  throw e;
}
