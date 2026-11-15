# Judge quickstart: decision, authority, controls

## Start without credentials

From the extracted application directory, use Node.js 22.13+:

```bash
npm ci
npm start
```

Open the loopback URL printed by the server. No API keys are required. This mode makes no model calls, provider payments or email sends. It is a local simulator, not fresh evidence of a live Airwallex integration.

## A three-minute local walkthrough

1. Choose **Acme Analytics**. Read the monthly/annual comparison and reserve-floor reason. The policy proposes monthly even though annual has a lower total price. These are seeded, synthetic terms and forecasts, not observed business finances.
2. Click **Approve intent**, then **Create card**. Manual simulator buttons are not an autonomous model run. Inspect the exact approved cap, currency and categories.
3. Click **Simulate: in policy**, then **Simulate: over cap**. Read the authorization outcomes. Simulated success is not provider settlement.
4. Click **Demo fixture: cheaper deal arrives**. This operator-triggered fixture changes the terms. The previous approval is invalidated and the old card is frozen in the simulator. It does not discover a new vendor offer automatically.
5. Compare the old approved hash to the `terms_changed` event: `oldHash` identifies the approved structured terms, while `newHash` identifies the replacement structured terms. Their difference explains why the previous approval no longer covers the new deal. The inspector deliberately keeps the **approved** hash visible after invalidation; it does not relabel it as current approval. Hashes show consistent application references, not source truth or merchant identity.
6. Scroll to **Inspect the decision-to-control chain**. Check the invalidation warning, full approved terms/intent hashes and exact-case event count. Expand the full snapshot to read timestamps, control values and ordered event detail without the recent-activity truncation.
7. Download the case JSON if useful. It is an unsigned local application snapshot, not a bank receipt or independent attestation. It contains only the selected case's visible events, not other-case/global audit events. It can contain business/operator details, so keep it private unless sharing is approved.
8. Select **Flowdesk** to see the contrasting annual decision. It starts unapproved; approving Acme does not approve Flowdesk. Reset demo clears the local walkthrough state only in simulator mode.

## What to inspect in the source

- `src/policy/`: deterministic cadence and cash-floor decision.
- `src/approval/`: exact-intent binding, signature/expiry and replay checks.
- `src/console/api.ts`: source guards, rejection, invalidation, freeze and uncertain-outcome locks.
- `src/intake/salesforce.ts`: explicit Contract reads/version evidence, not a watcher or atomic remote lock.
- `src/console/page.ts`: read-only evidence inspector and case-scoped snapshot export. It exports no approval envelope or console session token.
- `test/evidence-inspector.test.ts`: scoping, full-detail retention, hostile-text escaping, missing/stale evidence and no-approval handling.

## Evidence that needs a configured service

The v7 video combines labelled recorded Salesforce/Claude/Airwallex sandbox footage from the earlier accepted demo with a newly recorded walkthrough of this build's local simulator, including the read-only evidence inspector. The recorded sections do not prove a fresh provider run of this candidate, and the inspector section shows the simulator only. See `cases.md` for the recorded $400-to-$480 case and its limits, and `demo-map.md` for the exact recording-to-source map.

The separate read-only MCP prototype uses a different earlier $900 case in a local official example host. It is not a native Claude-host demonstration and cannot approve or pay.

## Verify the candidate

```bash
npm test
npm run typecheck
npm run evals
npm run smoke
npm run drill:crash
npm run check:clean
```

Tests and evals use deterministic/simulated evidence, not new provider or model results. Unknown outcomes remain unknown; a failed ledger read is not an empty ledger, an unverified freeze is not a stopped card, and a hash-linked local audit is not independent proof of contract truth, seller identity or settlement.
