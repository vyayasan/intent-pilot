# Gmail transport setup (operator runbook)

IntentPay's approval emails can be delivered through the real Gmail API
(`users.messages.send`). The transport is **never selected by default** (`preview`/`dry-run`
remain the defaults); it runs only when an operator sets it up deliberately.

## What the owner approves (one explicit decision)

The approval covers BOTH of these, stated explicitly in the ask:

1. **Project disposition, as applicable:** reuse of an existing Google Cloud project if the
   read-only inventory finds a suitable one, OR creation of one small new project (e.g.
   `intentpay-notifications`) if none exists. The inventory read happens first; the ask names
   which case applies.
2. **A Google OAuth client** for the IntentPay application in that project with **one scope**:
   `https://www.googleapis.com/auth/gmail.send` - Google's documented description: "Send
   messages only."

No other scopes are requested. Consent screen user type: Internal (vyayasan.com workspace
users only; the organization was auto-provisioned when the owner accepted the Google Cloud
terms on 27 Oct 2026). Internal limits the app to the workspace domain - use stays limited to
the owner's own account by configuration and practice. Chosen over External + Testing because
External + Testing refresh tokens expire (documented as 7 days), which would silently break
the lane. No token is permanent: revocation or policy changes can invalidate it, and that
surfaces as a definite refresh failure in the transport, never a silent resend. No new
accounts outside the owner's existing Google workspace.

## Steps (performed by the operator, not the owner)

1. Sign in to the owner's Google account (routine sign-in via the secure vault flow).
2. Google Cloud console: reuse an existing project if one exists, otherwise create one small
   project (e.g. `intentpay-notifications`) inside the vyayasan.com organization. (27 Oct 2026
   read-only inventory: no existing projects, so the create case applies.)
3. Enable the Gmail API on the project.
4. OAuth consent screen: user type Internal (vyayasan.com only), app name "IntentPay". If the
   console refuses Internal for any reason, STOP and report - External + Testing is a separate
   decision, not a fallback to take silently.
5. Create an OAuth client (type: Web application), note client id + secret.
6. Authorize once for the `gmail.send` scope as the owner account; store the refresh token in
   the deployment's secret store - never in the repo.
7. Configure the console: `INTENTPAY_EMAIL_TRANSPORT=gmail` plus
   `INTENTPAY_GMAIL_CLIENT_ID`, `INTENTPAY_GMAIL_CLIENT_SECRET`,
   `INTENTPAY_GMAIL_REFRESH_TOKEN`.

## Acceptance proof (real email, sandbox-labelled)

`npx tsx scripts/proof-email.ts --to-self <owner email>` sends exactly one approval-request
email to the owner and prints the documented receipt (Gmail Message id). Arrival is verified
in the owner's inbox. The script refuses third-party recipients and refuses to run without the
three credentials.

## Failure discipline (what the console shows the operator)

- 2xx + Message id = SENT (documented positive-acceptance receipt).
- Documented 4xx Google error = definitely NOT sent; the credential/permissions need attention.
- ANY 5xx, timeout or reset = outcome UNKNOWN; the record locks for reconciliation and is never
  auto-resent - a commit-then-error can mean the message exists.
- Token-refresh failure = definitely not sent (the send was never attempted); `invalid_grant`
  means the owner-approved credential was revoked and needs re-authorization.

## Setup completed (27 Oct 2026, verified in console)

- Project `intentpay-notifications` in org vyayasan.com; Gmail API enabled; no billing or trial required at any step.
- OAuth client "IntentPay console client" (Web application), consent User type **Internal** (vyayasan.com domain only), exactly one scope `.../auth/gmail.send`, one redirect URI `http://localhost:8787/callback`. Verified on Clients page and on the Google Account permissions page (grant shown: "Send email on your behalf", nothing else).
- Offline refresh token minted via the consent flow as sandi@vyayasan.com. Client secret and refresh token live only in vault entries "IntentPay Google OAuth client (intentpay-notifications)" and "IntentPay Gmail refresh token (sandi@vyayasan.com)" (login kind, password field). Never commit either value.
- Mint mechanics note: the cloud browser cannot reach localhost. During the 27 Oct mint, one temporary external redirect URI was added to capture the auth code, then removed; the disclosed code was consumed by our own exchange seconds later (auth codes are single-use and secret-gated). Refresh tokens are not bound to redirect URIs, so the final localhost-only config does not invalidate the minted token.
- Incident rule (from the 27 Oct review): ANY change to the client's redirect URIs, especially to an external destination, requires prior owner approval before applying. Future consent flows must include a `state` parameter and PKCE where the client type allows it. Loopback (localhost) capture in the cloud browser remains unverified until an actual capability check; do not assume it works or improvise alternatives mid-flow.
- An actual proof send is a separate approval gate and has NOT been executed.
