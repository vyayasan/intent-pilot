# IntentPay read-only MCP Apps live-sandbox prototype

Real current Airwallex sandbox card/ledger reads. Saved synthetic offer text and cash forecast. Only `show_review` is exposed, scoped to the single test case. No approve, issue, authorize, freeze or email tools.

## Run locally

Node 22+, `npm ci`, then `npm run build`. Supply your existing sandbox `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` securely in the process environment; neither is included. `npm start` runs the loopback MCP server on38101 and the adapted official example host on38180, with isolated sandbox on38181. No public deployment or Claude connection is configured. `npm test` additionally needs Chrome and verifies live provider reads and local host rendering.

The supplied snapshot identifies the frozen900USD replacement test card in the original sandbox account. Another account needs its own snapshot: set `INTENTPAY_MCP_SNAPSHOT` to a compatible read-only display snapshot. No credentials, approval envelopes or signing keys belong in a snapshot. Optional `INTENTPAY_MCP_OUTPUT_DIR` writes the latest result for local inspection. Missing credentials fail closed.

Verified: only read tool exposed, unscoped cases and action tools refused, current frozen status/900USD CLEARING, host refresh,390px layout, no browser external requests, snapshot bytes unchanged. This is an official local example host test, not proof of compatibility inside Claude. CLEARING is provider sandbox authorization evidence, not merchant settlement.

The example host derives from MCP Apps SDKv2.0.4, commit7af9a75da720b8a81be0f9aff47b25f75e9530ad. Existing upstream license/notices are retained.
