# Setup

## Safe default

Use Node.js 22.13+ and npm. `npm ci && npm start` starts the loopback console with synthetic seeded cases and a labelled simulator. No external credentials, model calls, provider payments or email sends are needed.

The app reads process environment variables, not an automatically loaded `.env` file. Keep secrets out of source, screenshots and shell history. Set them through your own secure environment manager, then start the app in the same environment.

## Real model and Airwallex sandbox

Set `ANTHROPIC_API_KEY` and your existing `AIRWALLEX_CLIENT_ID` / `AIRWALLEX_API_KEY`. The implementation defaults to `claude-sonnet-5-5`; `ANTHROPIC_MODEL` can override it. Alternatively, `EXTRACTION_BASE_URL`, `EXTRACTION_MODEL`, and optional `EXTRACTION_API_KEY` configure an OpenAI-compatible model endpoint.

Open a case, select Extract terms, inspect the proposal, approve separately, then Run agent. It reads state, issues the approved controlled card and attempts the sandbox purchase. It cannot approve itself. Without model configuration those model routes return 501; the manual simulator is not a model run.

**Sandbox actions create resources and authorizations.** Use your own sandbox account, explicit human approvals, and the applicable model budget. Verification commands in the README need none of these credentials. Do not run historical proof harnesses as routine setup.

## Salesforce

[Salesforce Contract connector](salesforce-contract-source.md) documents the fixed HTTPS org origin, OAuth execution user/API scope, explicit Contract import and source binding. Provide `SALESFORCE_INSTANCE`, `SALESFORCE_CLIENT_ID`, and `SALESFORCE_CLIENT_SECRET` securely. The connector reads a Contract; it exposes no write API.

The recorded demo Contract was Draft and held synthetic test terms. Use your own Contract ID. `Account.Name` is a display label, not seller verification. New case requires twelve synthetic weekly balances and a reserve floor. Import creates an unapproved case. Changed/unavailable source invalidates old authority; explicit refresh creates a new review.

## Notifications

Default `INTENTPAY_EMAIL_TRANSPORT=preview` stores application notification previews only. `dry-run` validates without delivery. Real Gmail requires separately approved account/recipient/content scope and the configured transport credentials. A selected transport is not permission to send.

## Runtime state

The console is loopback-only by default, checks Host/Origin and uses a per-run token. Runtime state, signing keys and audit files are gitignored. Do not commit them. A local signature proves integrity, while human identity requires the configured OIDC/role binding. See [deployment considerations](PRODUCTION.md); this repository is not a production deployment claim.

## MCP Apps

The separate [`mcp/README.md`](../mcp/README.md) describes its local official host, one read tool, dependencies and sandbox configuration. It does not expose approval, issue, pay, freeze or send-email tools. Its saved $900 scenario is not the Salesforce $480 case. Live-read tests need sandbox credentials and are not part of the credential-free root test suite.
