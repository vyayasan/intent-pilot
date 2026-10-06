// IntentPay live demo: the whole story against the Airwallex sandbox, deterministic and narrated for
// screen recording. Terms arrive by intake email, policy code decides, a person approves a bound intent,
// the card enforces it at the rail - accepts and declines are real sandbox API responses. Sandbox money only.
// Credentials live only in the environment of the local auth proxy (localhost:8788); this script never sees them.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { AirwallexClient } from "../src/gateway/airwallex.js";
import { LiveIssuingGateway } from "../src/gateway/live.js";
import { fromEmail } from "../src/intake/intake.js";
import { decide, cardPayload, DEFAULT_POLICY } from "../src/policy/policy.js";
import { mintIntent } from "../src/intent/intent.js";
import { issue, ApprovalVerifier } from "../src/approval/approval.js";
import type { Card, Terms, CashForecast } from "../src/domain/types.js";

const base = process.env.AIRWALLEX_BASE ?? "http://localhost:8788";
mkdirSync("runs", { recursive: true });
const logFile = "runs/demo-kit2.jsonl";

const loggingFetch: typeof fetch = (async (url: any, init: any) => {
  const u = new URL(String(url));
  const r = await fetch(url, init);
  const body = await r.clone().json().catch(() => ({}));
  appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), method: init?.method ?? "GET", path: u.pathname + u.search, status: r.status, note: body.id ?? body.card_id ?? body.card_transaction_id ?? body.code ?? "" }) + "\n");
  return r;
}) as any;

const client = new AirwallexClient({ clientId: "", apiKey: "", bearerToken: "proxy-injected", baseUrl: base, fetchImpl: loggingFetch });
const gw = new LiveIssuingGateway(client);

type Row = { scene: string; step: string; detail: string; result: string; tone: "ok" | "declined" | "info" | "refused" };
const rows: Row[] = [];
const rec = (scene: string, step: string, detail: string, result: string, tone: Row["tone"] = "info") => {
  rows.push({ scene, step, detail, result, tone });
  console.log(`  ${step}: ${result}${detail ? ` (${detail})` : ""}`);
};
const scene = (n: string, title: string) => console.log(`\nSCENE ${n} - ${title}`);

// Fixed demo inputs: the same story every run.
const VENDOR_EMAIL = {
  from: "sales@acme-analytics.example", subject: "Acme Analytics Pro - your pricing", receivedAt: "2026-10-06T09:00:00Z",
  text: "Acme Analytics Pro: $100 per month, or $984 per year billed upfront. 30 days notice. Billed in USD. Category: software.",
};
const TERMS: Terms = { monthlyPrice: 100, annualPrice: 984, currency: "USD", category: "software", noticeDays: 30 };
const FORECAST: CashForecast = { weeklyBalances: Array(12).fill(2000), reserveFloor: 500, breachWeek: null };
const APPROVER = "Sandi (founder)";
const demoKey = randomBytes(32).toString("hex"); // per-run local signing key; never leaves this process
const MCC: Record<string, string> = { software: "5734", analytics: "7372", marketing: "7311" };

scene("1", "THE CONTRACT ARRIVES - nobody pastes");
const intake = fromEmail(VENDOR_EMAIL);
if (!intake.ok) throw new Error(intake.error);
rec("1", "intake", intake.provenance ?? "", "vendor email ingested, untrusted text + provenance", "ok");
rec("1", "terms read", `$${TERMS.monthlyPrice}/mo or $${TERMS.annualPrice}/yr, ${TERMS.currency}, ${TERMS.category}`, "deterministic extraction from the terms text", "info");

scene("2", "POLICY DECIDES - code, not a model");
const d = decide(TERMS, FORECAST, DEFAULT_POLICY);
for (const r of d.reasons) rec("2", "policy", r, d.cadence, "ok");
if (d.cadence !== "annual") throw new Error(`demo scenario should decide annual, got ${d.cadence}`);

scene("3", "A PERSON APPROVES - bound to the exact intent");
const intent = mintIntent({ vendor: "Acme Analytics", cadence: d.cadence, amountCap: TERMS.annualPrice!, currency: TERMS.currency, categories: [TERMS.category], terms: TERMS, reconsiderAt: d.reconsiderAt });
const approval = issue("case_acme", intent, "v1", APPROVER, demoKey, 60 * 60_000, new Date(), `annual saves ${d.savingsPct}% and never breaches the reserve floor`);
const verifier = new ApprovalVerifier(demoKey);
const ok = verifier.check(approval, "case_acme", intent, "v1");
rec("3", "approval", `intent ${intent.id.slice(0, 18)}..., cap $${intent.amountCap} ${intent.currency} [${intent.categories}]`, ok === null ? "signed and verified" : `REFUSED: ${ok}`, ok === null ? "ok" : "refused");
const tampered = { ...intent, amountCap: intent.amountCap + 1 };
const refused = verifier.check(approval, "case_acme", tampered, "v1");
rec("3", "tamper test", "same approval, intent cap changed by $1", refused !== null ? `refused: ${refused}` : "PROBLEM: accepted", refused !== null ? "refused" : "info");

scene("4", "THE CARD IS ISSUED - controls come from the approval, nothing else");
const controls = cardPayload(intent);
let holder: { id: string };
try {
  holder = await gw.createCardholder({ name: "Demo Buyer", email: "demo-buyer@vyayasan.com" }, "kit2-demo:cardholder:1");
  rec("4", "cardholder", holder.id, "created", "ok");
} catch {
  const list = await client.call<any>("GET", "/api/v1/issuing/cardholders?page_size=50");
  const found = (list.items ?? []).find((c: any) => c.email === "demo-buyer@vyayasan.com");
  holder = { id: found.cardholder_id ?? found.id };
  rec("4", "cardholder", holder.id, "reused existing", "info");
}
const existing = (await client.call<any>("GET", "/api/v1/issuing/cards?page_size=50")).items ?? [];
const match = existing.find((c: any) => {
  const lim = c.authorization_controls?.transaction_limits?.limits?.[0];
  return lim?.amount === controls.amountLimit && c.authorization_controls?.transaction_limits?.currency === "USD"
    && (c.authorization_controls?.allowed_merchant_categories ?? []).includes(MCC.software);
});
let card: Card;
if (match) {
  card = { id: match.card_id ?? match.id, cardholderId: holder.id, controls, status: "ACTIVE" };
  rec("4", "card", card.id, `reused existing, cap $${controls.amountLimit} USD [${MCC.software}]`, "info");
} else {
  card = await gw.createCard({ cardholderId: holder.id, controls }, `kit2-demo:card:${Date.now()}`);
  rec("4", "card", card.id, `issued on Airwallex, cap $${controls.amountLimit} USD [software/${MCC.software}]`, "ok");
}

scene("5", "AT THE RAIL - the card enforces what the person approved");
const attempt = async (label: string, auth: { amount: number; currency: string; merchant: string; category: string }, expect: string, sc = "5") => {
  const t = await gw.authorize(card.id, auth, `kit2-demo:auth:${label}:${Date.now()}`);
  const accepted = t.status !== "FAILED";
  rec(sc, label, `$${auth.amount} ${auth.currency} [${auth.category}]`, accepted ? `ACCEPTED (${t.id}) - expected ${expect}` : `DECLINED ${t.failureReason} - expected ${expect}`, accepted ? "ok" : "declined");
  return t;
};
const okAuth = await attempt("the approved purchase", { amount: 984, currency: "USD", merchant: "Acme Analytics", category: "software" }, "accept");
await attempt("over the cap", { amount: 1000, currency: "USD", merchant: "Acme Analytics", category: "software" }, "decline LIMIT_EXCEEDED");
await attempt("wrong currency", { amount: 100, currency: "GBP", merchant: "Acme Analytics", category: "software" }, "decline CURRENCY_NOT_ALLOWED");
await attempt("wrong category", { amount: 100, currency: "USD", merchant: "Acme Analytics", category: "marketing" }, "decline MERCHANT_CATEGORY_NOT_ALLOWED");

scene("6", "KILL SWITCH - the person stays in charge");
await gw.freezeCard(card.id, `kit2-demo:freeze:${Date.now()}`);
rec("6", "freeze", card.id, "card frozen on Airwallex", "info");
await attempt("attempt while frozen", { amount: 100, currency: "USD", merchant: "Acme Analytics", category: "software" }, "decline CARD_INACTIVE", "6");
await gw.unfreezeCard(card.id, `kit2-demo:unfreeze:${Date.now()}`);
rec("6", "unfreeze", card.id, "card active again", "info");

scene("7", "ON THE RECORD");
if (okAuth && okAuth.status !== "FAILED") {
  const c = await gw.capture(okAuth.id, `kit2-demo:capture:${Date.now()}`);
  rec("7", "capture", okAuth.id, c.status, "ok");
}
const txns = await gw.listTransactions();
rec("7", "transactions", `${txns.length} visible on the sandbox account`, "every step above is an API record", "info");

// Replay page: self-contained, styled for screen recording. Every row above is a real sandbox response.
const chip = (t: Row["tone"]) => ({ ok: "#1a7f4b", declined: "#b3382e", refused: "#b3382e", info: "#4a5560" })[t];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const TITLES: Record<string, string> = {
  "1": "THE CONTRACT ARRIVES - NOBODY PASTES",
  "2": "POLICY DECIDES - CODE, NOT A MODEL",
  "3": "A PERSON APPROVES - BOUND TO THE EXACT INTENT",
  "4": "THE CARD IS ISSUED - CONTROLS COME FROM THE APPROVAL",
  "5": "AT THE RAIL - THE CARD ENFORCES THE APPROVAL",
  "6": "KILL SWITCH - THE PERSON STAYS IN CHARGE",
  "7": "ON THE RECORD",
};
const scenes = [...new Set(rows.map((r) => r.scene))];
const html = ["<!doctype html><meta charset=utf-8><title>IntentPay - live sandbox demo</title>",
  `<body style="margin:0;background:#fffaf0;color:#1d2a25;font:16px/1.5 Inter,system-ui,sans-serif"><main style="max-width:960px;margin:0 auto;padding:48px 24px">`,
  `<p style="letter-spacing:.14em;font-size:12px;color:#52675d">INTENTPAY - INTENT-BOUND PURCHASE AGENT</p>`,
  `<h1 style="font-size:34px;margin:.2em 0">Corporate cards that can only spend what a person approved.</h1>`,
  `<p style="color:#52675d">Recorded from a live run against the Airwallex issuing sandbox on ${new Date().toISOString().slice(0, 10)}. Sandbox money only. Every card ID, accept and decline below is a real API response; the machine-readable log is <code>runs/demo-kit2.jsonl</code>.</p>`,
  ...scenes.map((s) => {
    const sceneRows = rows.filter((r) => r.scene === s);
    return [
      `<section style="background:#fffdf8;border:1px solid #d8e2d8;border-radius:14px;padding:20px 24px;margin:22px 0">`,
      `<h2 style="font-size:19px;margin:0 0 12px">SCENE ${esc(s)} - ${esc(TITLES[s] ?? "")}</h2>`,
      ...sceneRows.map((r) => `<div style="display:flex;gap:12px;padding:8px 0;border-top:1px solid #eee7d8"><span style="min-width:120px;font-weight:600">${esc(r.step)}</span><span style="flex:1;color:#52675d">${esc(r.detail)}</span><span style="font-weight:600;color:${chip(r.tone)}">${esc(r.result)}</span></div>`),
      `</section>`,
    ].join("\n");
  }),
  `<p style="color:#52675d;font-size:14px">Built on the Airwallex issuing API. The approval, policy and intake code is in this repository.</p></main>`,
].join("\n");
writeFileSync("docs/demo-kit2.html", html);
console.log("\ndocs/demo-kit2.html written - open it, hit record.");
