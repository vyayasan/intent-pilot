// Live Airwallex sandbox run for Kit 2: real cardholder, real virtual cards with controls,
// simulated authorizations that pass and fail, freeze/unfreeze, capture, idempotency probe.
// Credentials live only in the environment of the local auth proxy (localhost:8788);
// this script never sees them. Sandbox money only. Every HTTP call is logged to runs/live-calls.jsonl.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { AirwallexClient } from "../src/gateway/airwallex.js";
import { LiveIssuingGateway } from "../src/gateway/live.js";
import type { Card, CardTransaction } from "../src/domain/types.js";

const base = process.env.AIRWALLEX_BASE ?? "http://localhost:8788";
mkdirSync("runs", { recursive: true });
const logFile = "runs/live-calls.jsonl";

const loggingFetch: typeof fetch = (async (url: any, init: any) => {
  const u = new URL(String(url));
  const r = await fetch(url, init);
  const body = await r.clone().json().catch(() => ({}));
  const note = body.id ?? body.card_id ?? body.card_transaction_id ?? body.code ?? "";
  const extra = body.status ?? body.failure_reason ?? body.message ?? "";
  appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), method: init?.method ?? "GET", path: u.pathname + u.search, status: r.status, note, extra }) + "\n");
  return r;
}) as any;

const client = new AirwallexClient({ clientId: "", apiKey: "", bearerToken: "proxy-injected", baseUrl: base, fetchImpl: loggingFetch });
const gw = new LiveIssuingGateway(client);

type Row = { step: string; detail: string; result: string };
const rows: Row[] = [];
const rec = (step: string, detail: string, result: string) => { rows.push({ step, detail, result }); console.log(`${step}: ${result} (${detail})`); };

// Balance check (informational; the wallet was already funded in an earlier run)
const balances = await client.call<any>("GET", "/api/v1/balances/current") as any[];
const usd = balances.find((b) => b.currency === "USD")?.total_amount;
const gbp = balances.find((b) => b.currency === "GBP")?.total_amount;
rec("wallet", `USD ${usd}, GBP ${gbp}`, usd > 0 && gbp > 0 ? "funded" : "needs funding");

// One cardholder, three cards with controls mirroring three approved intents
let holder: { id: string; name: string; email: string };
try {
  holder = await gw.createCardholder({ name: "Demo Buyer", email: "demo-buyer@vyayasan.com" }, "kit2-live:cardholder:1");
  rec("cardholder", holder.id, "created");
} catch (e: any) {
  // The sandbox rejects a second cardholder with the same email (400, not a dedup): reuse the existing one.
  rec("cardholder create", "demo-buyer@vyayasan.com", `rejected duplicate (${e.message}); reusing existing`);
  const list = await client.call<any>("GET", "/api/v1/issuing/cardholders?page_size=50");
  const found = (list.items ?? []).find((c: any) => c.email === "demo-buyer@vyayasan.com");
  if (!found) throw e;
  holder = { id: found.cardholder_id ?? found.id, name: "Demo Buyer", email: "demo-buyer@vyayasan.com" };
  rec("cardholder", holder.id, `reused (status ${found.status})`);
}

const intents: { name: string; cap: number; cur: string; cat: string }[] = [
  { name: "Acme Analytics (monthly)", cap: 100, cur: "USD", cat: "software" },
  { name: "Flowdesk (annual)", cap: 400, cur: "USD", cat: "software" },
  { name: "Northwind CRM (annual, GBP)", cap: 768, cur: "GBP", cat: "analytics" },
];
const MCC: Record<string, string> = { software: "5734", analytics: "7372", marketing: "7311" };
const cards: Record<string, Card> = {};
// Reuse-before-create: the sandbox rejects a reused request id carrying a different payload, so
// reruns look up an existing card with matching controls instead of blindly recreating.
const existing = (await client.call<any>("GET", "/api/v1/issuing/cards?page_size=50")).items ?? [];
for (const i of intents) {
  const match = existing.find((c: any) => {
    const lim = c.authorization_controls?.transaction_limits?.limits?.[0];
    return lim?.amount === i.cap && c.authorization_controls?.transaction_limits?.currency === i.cur
      && (c.authorization_controls?.allowed_merchant_categories ?? []).includes(MCC[i.cat]);
  });
  if (match) {
    cards[i.name] = { id: match.card_id ?? match.id, cardholderId: holder.id, controls: { amountLimit: i.cap, currencyAllowlist: [i.cur], merchantCategories: [i.cat] }, status: "ACTIVE" };
    rec(`card ${i.name}`, `${cards[i.name].id} cap ${i.cap} ${i.cur} [${i.cat}]`, "reused existing");
    continue;
  }
  const card = await gw.createCard({ cardholderId: holder.id, controls: { amountLimit: i.cap, currencyAllowlist: [i.cur], merchantCategories: [i.cat] } }, `kit2-live:card:${i.name}:${Date.now()}`);
  cards[i.name] = card;
  rec(`card ${i.name}`, `${card.id} cap ${i.cap} ${i.cur} [${i.cat}]`, "created");
}

const attempt = async (label: string, card: Card, auth: { amount: number; currency: string; merchant: string; category: string }, expect: string) => {
  try {
    const t: CardTransaction = await gw.authorize(card.id, auth, `kit2-live:auth:${label}`);
    const verdict = t.status === "FAILED" ? `declined ${t.failureReason}` : `accepted ${t.status} (${t.id})`;
    rec(label, `${auth.amount} ${auth.currency} ${auth.category}`, `${verdict} - expected ${expect}`);
    return t;
  } catch (e: any) {
    rec(label, `${auth.amount} ${auth.currency} ${auth.category}`, `API error ${e.message} - expected ${expect}`);
    return undefined;
  }
};

const acme = cards[intents[0].name], flowdesk = cards[intents[1].name], north = cards[intents[2].name];

// Acme: pass and fail paths
const okAcme = await attempt("acme in-policy", acme, { amount: 90, currency: "USD", merchant: "Acme Analytics", category: "software" }, "accept");
await attempt("acme over-cap", acme, { amount: 150, currency: "USD", merchant: "Acme Analytics", category: "software" }, "decline above cap");
await attempt("acme wrong currency", acme, { amount: 50, currency: "GBP", merchant: "Acme Analytics", category: "software" }, "decline currency");
await attempt("acme wrong category", acme, { amount: 50, currency: "USD", merchant: "Acme Analytics", category: "marketing" }, "decline category");

// Idempotency probe: the same logical authorization retried with the same request id
const p1 = await gw.authorize(flowdesk.id, { amount: 120, currency: "USD", merchant: "Flowdesk", category: "software" }, "kit2-live:auth:idem");
const p2 = await gw.authorize(flowdesk.id, { amount: 120, currency: "USD", merchant: "Flowdesk", category: "software" }, "kit2-live:auth:idem");
rec("idempotency probe", `first ${p1.id} second ${p2.id}`, p1.id === p2.id ? "deduplicated" : "documented finding: the simulator authorization endpoint does not dedup request ids");

// Freeze / unfreeze on Flowdesk
await gw.freezeCard(flowdesk.id, `kit2-live:freeze:${Date.now()}`);
const frozenState = await client.call<any>("GET", `/api/v1/issuing/cards/${flowdesk.id}`);
rec("freeze verification", flowdesk.id, `card_status ${frozenState.card_status}`);
await attempt("flowdesk while frozen", flowdesk, { amount: 120, currency: "USD", merchant: "Flowdesk", category: "software" }, "decline frozen");
await gw.unfreezeCard(flowdesk.id, `kit2-live:unfreeze:${Date.now()}`);
const activeState = await client.call<any>("GET", `/api/v1/issuing/cards/${flowdesk.id}`);
rec("unfreeze verification", flowdesk.id, `card_status ${activeState.card_status}`);
const okFlow = await attempt("flowdesk after unfreeze", flowdesk, { amount: 120, currency: "USD", merchant: "Flowdesk", category: "software" }, "accept");

// Northwind in GBP with a different category
const okNorth = await attempt("northwind in-policy", north, { amount: 700, currency: "GBP", merchant: "Northwind CRM", category: "analytics" }, "accept");
await attempt("northwind over-cap", north, { amount: 800, currency: "GBP", merchant: "Northwind CRM", category: "analytics" }, "decline above cap");
await attempt("northwind wrong category", north, { amount: 100, currency: "GBP", merchant: "Northwind CRM", category: "software" }, "decline category");

// Capture the accepted authorizations
for (const [label, t] of [["acme", okAcme], ["flowdesk", okFlow], ["northwind", okNorth]] as const) {
  if (!t || t.status === "FAILED") continue;
  try {
    const c = await gw.capture(t.id, `kit2-live:capture:${label}`);
    rec(`capture ${label}`, t.id, c.status);
  } catch (e: any) { rec(`capture ${label}`, t.id, `API error ${e.message}`); }
}

// Verify through the transaction list
const txns = await gw.listTransactions();
rec("list transactions", `${txns.length} on account`, txns.length > 0 ? "visible" : "none visible");

const behaviour = [
  "",
  "## API behaviour worth knowing",
  "",
  "- Cardholder create: email is top-level; the individual block requires date_of_birth, express_consent_obtained and address.country. A second cardholder with the same email is rejected (400), not deduplicated by request id.",
  "- Card create: on this account program takes purpose (COMMERCIAL) only; created_by and is_personalized are mandatory; categories are ISO merchant category codes (software 5734, analytics 7372, marketing 7311). Response id field is card_id.",
  "- Card update: the status field is card_status with values INACTIVE/ACTIVE/CLOSED. An unknown field (status) returns 200 and is silently ignored - our first freeze was a silent no-op until the field name was fixed.",
  "- Simulator authorizations: transaction_amount / transaction_currency / merchant_category_code / merchant_info. The simulator create endpoint does NOT deduplicate request_id: two calls with the same id produced two transactions. Control-plane endpoints do protect: a reused request id with a different payload is rejected (\"already associated with a previous request\").",
  "- Capture and reverse address the card_transaction_lifecycles path with the lifecycle id from the authorization response, not the transaction id.",
  "- Declines arrive as process_result DECLINED with named reasons seen live: LIMIT_EXCEEDED, CURRENCY_NOT_ALLOWED, MERCHANT_CATEGORY_NOT_ALLOWED, CARD_INACTIVE.",
  "",
];
const md = ["# Live sandbox run log", "", `Kit 2 live pass against the Airwallex sandbox, ${new Date().toISOString().slice(0, 10)}. Credentials were held only in the environment of a local proxy process and are never written here or logged. Sandbox money only.`, "", "| Step | Detail | Result |", "|---|---|---|", ...rows.map((r) => `| ${r.step} | ${r.detail} | ${r.result} |`), ...behaviour, "Full machine-readable log: `runs/live-calls.jsonl`.", ""].join("\n");
writeFileSync("RUNLOG.md", md);
console.log("RUNLOG.md written");
