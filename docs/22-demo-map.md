# IntentPay demo and source map

## Current walkthrough: v7

The current walkthrough is `docs/demo/intentpay-demo-v7.mp4`, prepared 15 November 2026. It is 4:20.668, 1920x1080, H.264/AAC. The original accepted 4:30 v6 is retained unchanged as historical material, not overwritten.

V7 combines full-screen frames selected from the earlier recorded Salesforce/IntentPay/Airwallex sandbox demonstration with a newly recorded walkthrough of the final application's local simulator. It has a newly generated, consistent narration throughout. The historical sections use saved actual run views, including labelled renders of recorded final states; they do not depict a newly executed provider transaction or reconstruct unrecorded clicks.

| Approximate time | What is shown | Evidence scope |
| --- | --- | --- |
| 0:00-0:43 | Founder/title, buyer problem, Starter Kit 02 stack and approval flow | Product explanation; exact model is shown on the stack slide |
| 0:43-1:32 | Salesforce synthetic Contract and stale-approval refusal | Historical provider/source evidence; $50/$400 original terms and $60/$480 changed terms are different versions |
| 1:32-2:14 | Fresh $480 approval, controls, authorizations, declines, old-card freeze, native Airwallex view | Historical Airwallex issuing-sandbox evidence; CLEARING is not settlement; sandbox merchant is not the supplier |
| 2:14-2:35 | Read-only MCP Apps prototype and missing-price refusal | Separate earlier $900 case in the official local example host; no action tools; historical no-card refusal |
| 2:35-3:23 | Current app: approve seeded terms, issue simulated card, trigger changed-deal fixture, inspect hashes/events, export JSON | Newly recorded local simulator, no model calls or provider actions; fixture is operator-triggered, not automatic offer discovery |
| 3:23-3:59 | Final-source validation summary | 566 automated tests, 58 deterministic evals, type/smoke/crash/clean checks; 20 synthetic live-model calls, not payment tests |
| 3:59-4:21 | Authority boundary, final repository and local setup | `https://github.com/vyayasan/intent-pilot`; use the reviewed source snapshot and setup instructions |

Times are rounded; chapter boundaries may vary by a fraction of a second after encoding.

## What changed from v6

- The current read-only inspector is shown in an actual final-source simulator recording. Approved hashes remain labelled approved after invalidation. Ordered events are scoped to one case, and credential-shaped fields and approval nonces are redacted.
- The JSON download is an unsigned local application snapshot. It is not independent provider attestation, a settlement receipt or a complete hash-chain proof. Missing/stale evidence and uncertain outcomes must not be treated as empty or successful state.
- The validation summary includes the newly fixed monthly-only false-refusal regression and notes the remaining conservative no-purchase refusal. Extraction is not claimed perfect.
- The closing slide points to the user-selected `intent-pilot` repository. No final portal submission is implied.

## Source reading

- `src/policy/`: deterministic monthly/annual and supplied cash-floor decision.
- `src/approval/` and `src/intent/`: exact-intent binding, signatures, expiry and replay checks.
- `src/console/api.ts`: source guards, refusal, invalidation, freeze and uncertain-outcome locks.
- `src/intake/salesforce.ts`: explicit Contract reads/version evidence, not an inbox watcher or atomic source lock.
- `src/console/page.ts`: read-only inspector and case-scoped snapshot export.
- `test/evidence-inspector.test.ts`: scoping, full-detail retention, hostile-text escaping, redaction and stale/missing evidence.
- `docs/judge-quickstart.md`: credential-free local walkthrough.
- `docs/cases.md` and `docs/evidence-notes.md`: recorded case boundaries and current-source evidence.

Cash forecasts and Salesforce Contract data are synthetic/supplied. Source freshness checks are non-atomic and can race a later change. Seller identity is not bound to the actual sandbox merchant. No production checkout, real merchant settlement, native Claude-host compatibility, live Visa/AP2 integration or new Airwallex run is claimed.

## Media integrity

V7 SHA-256: `b412699b5d7f6c74686bf2e8cee083f18f6986aac07842ecc9fd85154a222354`.

Original v6 SHA-256: `bc630606548e44972e1bae935ad1bd8c522c310ed266f56099d3e506e3cf3a0f`.

