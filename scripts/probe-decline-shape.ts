// Probe the DECLINED authorization shape on an already-frozen demo card. Sandbox only.
import {readFileSync, writeFileSync} from "node:fs";
import {AirwallexClient} from "../src/gateway/airwallex.js";
const CARD = "cd65b864-f2a0-4e9c-af3c-4b461e5b681f";
const clientId = readFileSync(process.env.ABH_CLIENT_ID_FILE!, "utf8").trim();
const apiKey = readFileSync(process.env.ABH_API_KEY_FILE!, "utf8").trim();
const client = new AirwallexClient({clientId, apiKey, baseUrl: "https://api.sandbox.airwallex.com", maxRps: 2});
try {
  const j = await client.simCreateAuthorization({
    card_id: CARD, transaction_amount: 1, transaction_currency: "USD",
    merchant_category_code: "5734", merchant_info: "PROBE DECLINE CHECK",
  });
  writeFileSync("runs/probe-20261021/decline-shape.json", JSON.stringify(j, null, 2));
  console.log("decline raw:", JSON.stringify({type: j.type, process_result: j.process_result, status: j.status, failure_reason: j.failure_reason, decline_reason: j.decline_reason, card_transaction_id: j.card_transaction_id}));
} catch (e) {
  console.log("authorize threw:", e instanceof Error ? e.message : e);
}
