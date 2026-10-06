# Live sandbox run log

Kit 2 live pass against the Airwallex sandbox, 2026-10-06. Credentials were held only in the environment of a local proxy process and are never written here or logged. Sandbox money only.

| Step | Detail | Result |
|---|---|---|
| wallet | USD 9999580, GBP 9998600 | funded |
| cardholder create | demo-buyer@vyayasan.com | rejected duplicate (400 bad_request: The given email or mobile number is already associated with a cardholder.); reusing existing |
| cardholder | 1edd6a88-74fa-4027-bca2-65cb5aab704f | reused (status READY) |
| card Acme Analytics (monthly) | cada9226-faf5-479b-a35d-40da744ee7fd cap 100 USD [software] | created |
| card Flowdesk (annual) | 147f47fd-5ca7-4ad1-bcbe-51443457cc4b cap 400 USD [software] | created |
| card Northwind CRM (annual, GBP) | 1a754494-d934-4d27-b196-ea18e427ab0f cap 768 GBP [analytics] | created |
| acme in-policy | 90 USD software | accepted PENDING (01a11086-ff76-7000-9087-d1c17d22906e) - expected accept |
| acme over-cap | 150 USD software | declined LIMIT_EXCEEDED - expected decline above cap |
| acme wrong currency | 50 GBP software | declined CURRENCY_NOT_ALLOWED - expected decline currency |
| acme wrong category | 50 USD marketing | declined MERCHANT_CATEGORY_NOT_ALLOWED - expected decline category |
| idempotency probe | first 01a11087-37c2-7000-8213-e699f998bed5 second 01a11087-4157-7000-bdb1-48ca150d7056 | documented finding: the simulator authorization endpoint does not dedup request ids |
| freeze verification | 147f47fd-5ca7-4ad1-bcbe-51443457cc4b | card_status INACTIVE |
| flowdesk while frozen | 120 USD software | declined CARD_INACTIVE - expected decline frozen |
| unfreeze verification | 147f47fd-5ca7-4ad1-bcbe-51443457cc4b | card_status ACTIVE |
| flowdesk after unfreeze | 120 USD software | accepted PENDING (01a11087-6351-7000-ae7a-c1ac9c8ab075) - expected accept |
| northwind in-policy | 700 GBP analytics | accepted PENDING (01a11087-6cfe-7000-b1aa-94bed949dc8c) - expected accept |
| northwind over-cap | 800 GBP analytics | declined LIMIT_EXCEEDED - expected decline above cap |
| northwind wrong category | 100 GBP software | declined MERCHANT_CATEGORY_NOT_ALLOWED - expected decline category |
| capture acme | 01a11086-ff76-7000-9087-d1c17d22906e | CLEARING |
| capture flowdesk | 01a11087-6351-7000-ae7a-c1ac9c8ab075 | CLEARING |
| capture northwind | 01a11087-6cfe-7000-b1aa-94bed949dc8c | CLEARING |
| list transactions | 54 on account | visible |

## API behaviour worth knowing

- Cardholder create: email is top-level; the individual block requires date_of_birth, express_consent_obtained and address.country. A second cardholder with the same email is rejected (400), not deduplicated by request id.
- Card create: on this account program takes purpose (COMMERCIAL) only; created_by and is_personalized are mandatory; categories are ISO merchant category codes (software 5734, analytics 7372, marketing 7311). Response id field is card_id.
- Card update: the status field is card_status with values INACTIVE/ACTIVE/CLOSED. An unknown field (status) returns 200 and is silently ignored - our first freeze was a silent no-op until the field name was fixed.
- Simulator authorizations: transaction_amount / transaction_currency / merchant_category_code / merchant_info. The simulator create endpoint does NOT deduplicate request_id: two calls with the same id produced two transactions. Control-plane endpoints do protect: a reused request id with a different payload is rejected ("already associated with a previous request").
- Capture and reverse address the card_transaction_lifecycles path with the lifecycle id from the authorization response, not the transaction id.
- Declines arrive as process_result DECLINED with named reasons seen live: LIMIT_EXCEEDED, CURRENCY_NOT_ALLOWED, MERCHANT_CATEGORY_NOT_ALLOWED, CARD_INACTIVE.

Full machine-readable log: `runs/live-calls.jsonl`.
