# Salesforce Contract intake (live-tested sandbox proof)

This connector reads one Salesforce Contract by its record ID. Salesforce is real; the current Draft Contract and cash forecast are explicitly synthetic. Quotes are not enabled in the test org. Account.Name supplies the display label, which can be a buyer account and is not verified seller identity. SpecialTerms supplies the untrusted terms text. It is not a signed-document verification system.

## Configure and run

Node22+; `npm ci`; securely supply `SALESFORCE_INSTANCE`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` and the existing model/Airwallex sandbox configuration from README. Never put credentials in source or URL parameters. Instance is a fixed HTTPS Salesforce org origin. The proof uses APIv65.0 and an External Client App with client_credentials, API scope and a configured execution user. Credentials are held in the owner's vault, not this archive. The product exposes no Salesforce write tool.

Run `npm start`. Choose New case; enter a Contract ID in the Salesforce field plus12test weekly balances and a reserve floor. Pasted vendor/terms are ignored for this import. Create case explicitly reads the Contract, stores a version fingerprint and creates an unapproved case. Extract terms, review, then approve separately. This is human-authorized import, not background ingestion or autonomous seller negotiation.

Version binding includes record ID, SystemModstamp, status, account label and exact SpecialTerms. Approval, card issuance, agent launch and direct purchase each re-read the source. A change or unavailable read blocks spending409 and invalidates the prior case. If a card exists, the app attempts freeze and verifies its state. Unknown freeze stays locked. No fresh terms are silently adopted.

Use Read current contract into new review to explicitly import the latest version. It invalidates the previous case, freezes any card and creates a distinct unapproved review with no inherited approval. Extraction and approval are fresh. Bound cases cannot bypass this through manual terms edits or uploaded notices. A recovered source does not revive an invalidated case.

This is a check-before-action guard, not a distributed atomic lock on Salesforce and Airwallex. A remote change after the final source read can race payment. There is no background event watcher and no contractual cancellation guarantee. An already pending authorization must be reconciled; never blind-retry. Real merchant checkout, settlement, unattended renewal grants and live Visa/AP2 are not implemented.

## Verified combined run

Initial50monthly/400annual Draft source -> model extraction -> explicit approval -> external update60monthly/480annual -> old approval issuance refused409 -> explicit fresh review -> model extraction/approval -> uninterrupted agent issue/purchase480USD CLEARING. Replay refused409. Provider declines481USD,480EUR and excluded category. Source changed again -> direct purchase refused409, card freeze verified, adopted terms unchanged. Source original SpecialTerms restored/read back. Card independentlyINACTIVE; controls independently480USD per transaction,USDallowlist,MCC5734. No new Gmail sends.

The test terms and forecast are not commercial or financial advice. CLEARING is Airwallex sandbox evidence, not settlement. Source changes were made by the test operator through Salesforce, not by a seller agent.
