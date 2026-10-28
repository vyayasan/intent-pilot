// One-off sandbox shape probe (private, not part of the proof harness). Reads credentials from
// operator-injected files, dumps RAW response JSON for authorize/capture/list/freeze on an
// already-orphaned demo card, then freezes that card. Sandbox only.
import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {resolve} from "node:path";
import {AirwallexClient} from "../src/gateway/airwallex.js";

const CARD = "cd65b864-f2a0-4e9c-af3c-4b461e5b681f";
const outDir = resolve("runs/probe-20261021"); mkdirSync(outDir, {recursive: true});
const clientId = readFileSync(process.env.ABH_CLIENT_ID_FILE!, "utf8").trim();
const apiKey = readFileSync(process.env.ABH_API_KEY_FILE!, "utf8").trim();
const client = new AirwallexClient({clientId, apiKey, baseUrl: "https://api.sandbox.airwallex.com", maxRps: 2});
const shapes: Record<string, unknown> = {};
const keys = (j: any) => (j && typeof j === "object" ? Object.keys(j).sort() : j);

const card0 = await client.call<any>("GET", `/api/v1/issuing/cards/${CARD}`);
shapes.card_before = card0;
console.log("card before:", card0.card_status);

const list0 = await client.listTransactions({cardId: CARD});
shapes.list_before = list0;
console.log("list items before:", (list0.items ?? []).length, "item0 keys:", keys(list0.items?.[0]));

const auth = await client.simCreateAuthorization({
  card_id: CARD, transaction_amount: 1, transaction_currency: "USD",
  merchant_category_code: "5734", merchant_info: "PROBE SHAPE CHECK",
});
shapes.authorize_raw = auth;
console.log("authorize keys:", keys(auth));
console.log("authorize id fields:", {id: auth.id, card_transaction_id: auth.card_transaction_id, transaction_id: auth.transaction_id, lifecycle: auth.card_transaction_lifecycle_id});
console.log("authorize type/status:", {transaction_type: auth.transaction_type, type: auth.type, status: auth.status, process_result: auth.process_result, failure_reason: auth.failure_reason});

const lc = auth.card_transaction_lifecycle_id ?? auth.id;
const cap = await client.simCapture(lc);
shapes.capture_raw = cap;
console.log("capture keys:", keys(cap));
console.log("capture type/status:", {transaction_type: cap.transaction_type, type: cap.type, status: cap.status, id: cap.id, card_transaction_id: cap.card_transaction_id});

const list1 = await client.listTransactions({cardId: CARD});
shapes.list_after = list1;
console.log("list items after:", (list1.items ?? []).length);
for (const it of (list1.items ?? [])) console.log("  item:", {id: it.id, transaction_type: it.transaction_type, status: it.status, amount: it.amount ?? it.transaction_amount});

const frz = await client.updateCard(CARD, {card_status: "INACTIVE"});
shapes.freeze_raw = frz;
const card1 = await client.call<any>("GET", `/api/v1/issuing/cards/${CARD}`);
shapes.card_after = card1;
console.log("card after freeze:", card1.card_status);

writeFileSync(resolve(outDir, "shapes.json"), JSON.stringify(shapes, null, 2));
console.log("shapes saved to", resolve(outDir, "shapes.json"));
