/**
 * Live non-simulator proof of the Airwallex sandbox surface IntentPay actually uses.
 * Runs the app's own gateway code (AirwallexClient + LiveIssuingGateway) against
 * https://api.sandbox.airwallex.com with vault-held sandbox credentials.
 *
 * Covers: auth + balances, cardholder lookup, card readback, cards list, controls
 * read/write/readback with restore, freeze/unfreeze lifecycle with restore, and the
 * transactions readback. The simulator family (authorize/capture/reverse/refund) is
 * probed once as the labelled boundary (vendor outage since 01:08 GMT 27 Oct) and any
 * unexpected success is reversed and reported.
 *
 * Safety: every write is restored to its pre-run state and the restore is verified by
 * an independent read-back; a final state check runs in `finally`. No new cards or
 * cardholders are created. Sandbox only - no real money moves.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { AirwallexClient } from "../src/gateway/airwallex.js";
import { LiveIssuingGateway } from "../src/gateway/live.js";

const CARD_ID = "8691d2c8-05ea-4b35-9ff2-147e24044528";
const CARDHOLDER_EMAIL = "demo-buyer@vyayasan.com";
const RUN = `live-proof-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const clientId = readFileSync("/home/sandbox/.vault/airwallex-sandbox-api-admin-key-client-id-api-key-35d423/username", "utf8").trim();
const apiKey = readFileSync("/home/sandbox/.vault/airwallex-sandbox-api-admin-key-client-id-api-key-35d423/password", "utf8").trim();
const client = new AirwallexClient({ clientId, apiKey, baseUrl: "https://api.sandbox.airwallex.com", maxRps: 2 });
const gw = new LiveIssuingGateway(client);

// Sandbox payloads can carry masked PANs; keep the record last4-only regardless.
const redact = (s: string) => s.replace(/\b(\d{4})\d{8,11}(\d{4})\b/g, "$1********$2");
const record: any[] = [];
let originalControls: { amountLimit: number; currencyAllowlist: string[]; merchantCategories: string[] } | undefined;
let stateDirty = false;

async function step(id: string, label: string, fn: () => Promise<any>) {
  const started = new Date().toISOString();
  const t0 = Date.now();
  try {
    const out = await fn();
    record.push({ id, label, outcome: "ok", started, ms: Date.now() - t0, response: JSON.parse(redact(JSON.stringify(out ?? null))) });
    console.log(`OK   ${id} ${label} (${Date.now() - t0}ms)`);
    return out;
  } catch (e: any) {
    record.push({ id, label, outcome: "error", started, ms: Date.now() - t0, error: redact(String(e?.message ?? e)) });
    console.log(`ERR  ${id} ${label}: ${e?.message ?? e}`);
    return undefined;
  }
}

async function main() {
  console.log(`run ${RUN}  card ${CARD_ID}  (Airwallex sandbox, non-simulator surface)`);

  await step("1-balances", "account balances readback (GET /api/v1/balances/current)", () =>
    client.call<any>("GET", "/api/v1/balances/current"));

  const holder = await step("2-cardholder", "cardholder lookup by email (app gateway findCardholderByEmail)", async () => {
    const r = await gw.findCardholderByEmail(CARDHOLDER_EMAIL);
    if (r.state !== "found") throw new Error(`lookup state ${r.state}`);
    return r;
  });

  const card = await step("3-card", "card details readback (GET /api/v1/issuing/cards/{id})", () =>
    client.getCard(CARD_ID));
  const cardholderId = card?.cardholder_id ?? holder?.cardholder?.id;

  if (cardholderId) {
    await step("4-cards-list", "cards list for cardholder (GET /api/v1/issuing/cards?cardholder_id=...)", async () => {
      const cards = await gw.listCards(cardholderId);
      return { count: cards.length, containsProofCard: cards.some((c: any) => c.id === CARD_ID), ids: cards.map((c: any) => c.id) };
    });
  }

  const controls = await step("5-controls-read", "card controls readback (app gateway readCardControls)", async () => {
    const c = await gw.readCardControls(CARD_ID);
    if (!c) throw new Error("no authorization_controls on card");
    return c;
  });
  originalControls = controls;

  if (controls) {
    const sentinel = { ...controls, amountLimit: controls.amountLimit + 1 };
    await step("6-controls-write", `controls write sentinel limit ${sentinel.amountLimit} then verify (setCardControls + independent read)`, async () => {
      stateDirty = true;
      await gw.setCardControls(CARD_ID, sentinel);
      const back = await gw.readCardControls(CARD_ID);
      if (back?.amountLimit !== sentinel.amountLimit) throw new Error(`sentinel readback mismatch: ${back?.amountLimit}`);
      return { wrote: sentinel, readBack: back };
    });
    await step("7-controls-restore", `controls restored to ${controls.amountLimit} then verified`, async () => {
      await gw.setCardControls(CARD_ID, controls);
      const back = await gw.readCardControls(CARD_ID);
      stateDirty = false;
      if (JSON.stringify(back) !== JSON.stringify(controls)) throw new Error(`restore mismatch: ${JSON.stringify(back)}`);
      return { restored: back };
    });
  } else {
    record.push({ id: "6-controls-write", outcome: "skipped", reason: "no existing controls to sentinel safely" });
  }

  await step("8-freeze", "freeze card (update card_status INACTIVE) + verified readback", async () => {
    stateDirty = true;
    const frozen = await gw.freezeCard(CARD_ID, `${RUN}-freeze`);
    const j = await client.getCard(CARD_ID);
    if (j.card_status !== "INACTIVE") throw new Error(`independent readback says ${j.card_status}`);
    return { gateway: frozen, independentStatus: j.card_status };
  });
  await step("9-unfreeze", "unfreeze card (card_status ACTIVE) + verified readback", async () => {
    const active = await gw.unfreezeCard(CARD_ID, `${RUN}-unfreeze`);
    const j = await client.getCard(CARD_ID);
    stateDirty = false;
    if (j.card_status !== "ACTIVE") throw new Error(`independent readback says ${j.card_status}`);
    return { gateway: active, independentStatus: j.card_status };
  });

  const txBefore = await step("10-transactions", "transactions readback for card (GET /api/v1/issuing/transactions)", async () => {
    const txs = await gw.listTransactions(CARD_ID);
    return { count: txs.length, latest: txs.slice(0, 5) };
  });

  await step("11-sim-boundary", "BOUNDARY: simulator probe (POST /api/v1/simulation/issuing/create) - outage check", async () => {
    try {
      const auth = await client.simCreateAuthorization(
        { card_id: CARD_ID, transaction_amount: 1, transaction_currency: "GBP", merchant_category_code: "5411", merchant_info: "IntentPay boundary probe" },
        `${RUN}-boundary`);
      // Outage is over: a REAL sandbox authorization now exists. Reverse it to leave no dangling state.
      const lc = (auth as any).card_transaction_lifecycle_id ?? (auth as any).id;
      const rev = await client.simReverse(lc, `${RUN}-boundary-reverse`);
      const txs = await gw.listTransactions(CARD_ID);
      return { SIMULATOR_RECOVERED: true, authorization: auth, reversed: rev, txCountBefore: txBefore?.count, txCountAfter: txs.length };
    } catch (e: any) {
      const txs = await gw.listTransactions(CARD_ID);
      if (txBefore && txs.length !== txBefore.count) throw new Error(`sim failed BUT transaction count changed ${txBefore.count} -> ${txs.length}`);
      return { simulatorStillDown: true, error: String(e?.message ?? e), txCountUnchanged: txBefore ? txs.length === txBefore.count : "unknown" };
    }
  });

  console.log(`done ${RUN}`);
}

main().finally(async () => {
  // Final independent state verification - the card must end ACTIVE with its pre-run controls.
  try {
    const j = await client.getCard(CARD_ID);
    const back = await gw.readCardControls(CARD_ID);
    const controlsOk = !originalControls || JSON.stringify(back) === JSON.stringify(originalControls);
    const ok = j.card_status === "ACTIVE" && controlsOk && !stateDirty;
    record.push({ id: "final-state", outcome: ok ? "verified-clean" : "NOT-CLEAN", cardStatus: j.card_status, controlsMatchOriginal: controlsOk, stateDirty });
    console.log(ok ? "FINAL STATE VERIFIED CLEAN (card ACTIVE, controls as found)" : `!!! FINAL STATE NOT CLEAN: status=${j.card_status} controlsOk=${controlsOk} dirty=${stateDirty}`);
  } catch (e: any) {
    record.push({ id: "final-state", outcome: "verification-error", error: String(e?.message ?? e) });
    console.log(`!!! FINAL STATE VERIFICATION ERROR: ${e?.message ?? e}`);
  }
  writeFileSync("/tmp/airwallex-live-proof.json", JSON.stringify({ run: RUN, card: CARD_ID, steps: record }, null, 2));
  console.log("record /tmp/airwallex-live-proof.json");
});
