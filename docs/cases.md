# Cases and evidence

## Evidence levels

**Recorded real-provider evidence** uses synthetic offer/forecast inputs with actual model calls or actual sandbox services. **Automated** means local deterministic tests/evals, including fake provider responses. **Simulator** means the labelled local gateway. These are not interchangeable.

No new model calls, provider authorizations or emails are required by the root verification commands. This repository contains product code, selected product visuals and a concise record of results, not private credentials or runtime logs.

## 1. Salesforce changed deal: $400 → $480

The test operator wrote synthetic $50/month or $400/year terms to a real Draft Contract. Explicit import produced an unapproved review. Claude extracted the terms; deterministic policy proposed annual; a person approved. The operator changed the source to $60/month or $480/year before issuance. The old approval was refused with HTTP 409 and no card was issued.

Explicit refresh created a new review. Fresh extraction and approval preceded an uninterrupted model issue/purchase sequence, $480 USD, reported `CLEARING`. Separate $481, EUR and excluded-category attempts were declined. A further source change blocked purchase and verified freeze. The test source was restored and all test cards were inactive or closed at closeout.

**Boundaries:** Draft synthetic terms, not a signed commercial contract. `Account.Name` is a display label. Provider merchant is the sandbox generator, not the supplier. Source checks are non-atomic; `CLEARING` is not settlement. Salesforce notifications were previews, not sent emails.

**Reproduce safely:** follow [setup](setup.md) and [connector](salesforce-contract-source.md) using your own sandbox and test Contract. Every spend step needs separate human approval. Do not reuse old approval envelopes.

**Local regressions:** `npx vitest run test/salesforce*.test.ts` and the source-guard tests in `test/`. Run the complete `npm test` suite for all source checks, including same-price changes, outage, uncertain freeze and persistence.

## 2. Cash policy: monthly, annual or no purchase

- Annual fits and saves money: propose annual.
- Annual breaks the reserve floor but monthly fits: propose monthly and a reconsideration point.
- Neither option fits: refuse purchase.
- Monthly-only / annual-only offer: evaluate the stated option, without inventing the missing alternative.
- Missing price, currency or unsupported terms: request information instead of inventing authority.

Real-model sandbox sessions covered these decisions. The recorded Salesforce case uses annual; the recorded no-purchase clip is a separate missing-price case. The cash-floor and missing-price decisions also have local deterministic/regression coverage.

Run `npm run evals` for 58 deterministic policy/governance scenarios. They are not live-model evals.

## 3. Issuer controls

Recorded Airwallex sandbox results include in-policy authorization, over-cap, wrong-currency, excluded-category and inactive-card declines with named provider reasons. Card issuance controls come from the approved intent.

A provider-reported transaction is not proof of merchant checkout or seller identity. The generator can report a different merchant and category from the supplied scenario. The app retains that result rather than rewriting it.

Run `npm run smoke` for a credential-free simulated end-to-end flow. This is not a new provider verification.

## 4. Uploaded notice: changed terms

A simple `.txt` or `.eml` upload is untrusted data. Extraction cites evidence, analysis stages a proposal, and a person explicitly applies it. Apply invalidates approval and verifies freeze. A fresh approval is needed for replacement spending. The parser does not claim support for arbitrary HTML/multipart/base64 mail.

The earlier $900 replacement case required reconciliation after the agent was interrupted following issuance. Purchase completion was explicit after empty-ledger checks. It is recovered execution, not an uninterrupted agent run, and is distinct from the uninterrupted Salesforce $480 story.

## 5. Read-only MCP Apps

The final demo shows the official local example host calling `show_review`. The supplied case is the separate earlier $900 test scenario. Terms, forecast and prior result are saved; card status and ledger were read from the live sandbox at capture time. There are no approve/issue/pay/freeze/email tools. Native Claude-host compatibility is not established.

The adapter and host are in [`mcp/`](../mcp/). Root tests do not call this live-read endpoint. Its configured live test is an operator-only check, not a setup requirement.

## 6. Safety and recovery

The local test suite covers stale/replayed approvals, malicious term instructions, cash-floor boundaries, invalid states, wrong controls, dropped/unknown responses, rejected-case locking, web-origin protections and state recovery. `npm run drill:crash` checks local process-kill recovery without financial effects.

Unknown authorization, freeze or delivery outcomes must be reconciled. They are never treated as proof of failure and blindly retried.
