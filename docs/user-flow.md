# IntentPay user flow: implemented demo and intended deployment

## Working sandbox flow

1. An operator pastes vendor pricing text and a labelled test forecast into the console. Vendor text is untrusted data, not instructions. Forecast balances are supplied scenario inputs, not a bank-derived forecast.
2. A model proposes structured terms. Schema, citation, no-new-facts and policy checks accept or refuse the proposal. Ambiguous terms escalate rather than silently becoming an approval.
3. Deterministic policy compares monthly and annual options against the reserve floor and explains its choice. A reconsider date is a decision field, not evidence that a scheduler will act on it.
4. A reviewer approves the exact intent. The approval binds the terms, intent, policy version, expiry and single-use nonce, with a local approver signature. Today's localhost demo used a demo reviewer. That is not production identity proof.
5. After approval, the execution agent can issue the constrained card and execute one purchase through typed, audited tools. It cannot approve itself, choose a different amount or weaken controls.
6. Airwallex sandbox authorizations clear or decline under the card's controls. The 3 November run demonstrated a $200 purchase, terms changing to $220, old-card freeze and CARD_INACTIVE decline, stale-approval refusal, fresh approval and a $220 replacement purchase.
7. The console reads transaction history and current provider card status. Status reads include timestamps; failed or unknown status reads say UNKNOWN. Refresh provider reads takes a new snapshot without initiating a purchase. The displayed controls describe the approved issuance controls, not a fresh read of every provider control.
8. Notifications are preview-only by default. Gmail is an implemented transport with earlier approved self-addressed proof, not permission to send new messages.

## Important boundaries

- The run used synthetic vendor terms and cash forecasts, a real model, and real sandbox API calls. No production money or real merchant acceptance was proven.
- The sandbox capture/ledger reports AIRPRO_TX_GENERATOR / MCC7531 rather than the requested vendor/MCC5734. This artifact is preserved, not rewritten as a merchant charge.
- Console intake is a working paste-text flow. PDF, email and e-sign adapters have code and tests; do not describe them as deployed automatic document ingestion without a connected-source proof.
- Webhook verification and Visa-shaped adapters have fixture tests. They are not proof of production clearing-event delivery, settlement, or a live Visa integration.
- A reconsider date does not schedule autonomous renewal or forecast refresh. Those deployment workflows remain unproven.
- Google OIDC, roles and fail-closed checks are implemented. Google sign-in was verified on 3 November using an approved temporary Cloud Shell callback, then the callback was removed. It is not a permanent remote sign-in endpoint; localhost demo-token purchase evidence is separate.
- Production hosting, access, external security review, operational backups and live recovery need separate setup and verification. See PRODUCTION.md and RECOVERY.md.
