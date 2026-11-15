# Evidence notes

## What the video shows

`docs/demo/intentpay-demo-v6.mp4` is the unchanged 4:30 recording of the core Salesforce → IntentPay → Airwallex sandbox workflow, the separate read-only MCP prototype and the no-purchase case. See `demo-map.md` and `cases.md` for the full mapping and limitations.

## What changed after the recording

The submission source adds a read-only decision-to-control evidence inspector, case-scoped JSON export and the judge quickstart. These are not shown in v6. The supplement images in `docs/images/evidence-inspector-*` show the new UI in the local simulator, not a fresh provider or Salesforce run. The core approval/control workflow remains the recorded design.

The inspector keeps the previous approved terms/intent hashes visible after invalidation. Compare the `terms_changed` event's `oldHash` and `newHash` to understand why old authority cannot cover the changed deal. Hashes identify application records, not the truth of the contract or supplier identity.

JSON exports preserve ordered selected-case event detail with credential-shaped fields and approval nonces redacted. A redacted case subset cannot independently verify the full audit hash chain. Exports are unsigned local snapshots, not provider attestations or settlement receipts. Missing audit entries can reflect access restrictions. Failed refreshes are marked stale in the UI and export.

## Fresh checks on 15 November 2026

The source passed automated tests, typecheck, deterministic evals, simulated smoke, crash recovery and clean-source checks. A browser walkthrough checked monthly policy → human approval → simulated card/authorization → deal change → approval invalidation → verified simulated freeze, plus JSON scoping, stale refresh and mobile layout. Read-only export does not approve, issue, pay, freeze, email or share data.

Live Claude Sonnet 5.5 extraction was checked with synthetic cases: annual, cash-floor monthly, missing price, contradictory price, adversarial vendor instructions, annual-only, monthly-only and no-purchase. A valid monthly-only case initially failed closed when the model cited a correct cumulative cash balance. A narrow arithmetic guard fix was tested and the live monthly-only retest passed. No-purchase cases stayed blocked; the conservative rationale guard can still refuse a model explanation even when its financial conclusion is safe. This is a small targeted verification set, not a statistical model benchmark or a claim of zero defects.

No new Airwallex or Salesforce run was performed for these post-recording checks. Sandbox authorizations are not settlement. Seller binding, bank-fed forecasts, atomic Salesforce locks and production checkout remain outside the demonstrated scope.
