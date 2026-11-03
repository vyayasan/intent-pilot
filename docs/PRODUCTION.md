# IntentPay production readiness

Living register for taking IntentPay from a private demo candidate to a production-ready
service. Statuses are evidence-backed: "done" means code plus a real run or tests, "partial"
means some layers exist, "open" means nothing verified yet. Nothing here changes the standing
gates: no new accounts, no paid services, no real-money activation, no publication, no real
email sends, no video and no submission without the owner's explicit approval.

## What production-ready means here

1. Only authenticated, authorized people can approve spend or operate the console.
2. State is durable and recoverable: no lost locks, nonces, approvals or audit entries after a
   crash, restart or restore.
3. Money and message side effects are exactly-once from the user's point of view, even when
   providers fail ambiguously.
4. Every security claim in this file is backed by a real run or a test, never by intention.

## Threat model

Assets, in order of value:
- **Spend authority**: approvals, intents, issued cards and their controls.
- **Approval integrity**: who approved what, bound to terms, policy version, nonce, expiry.
- **Safety state**: unresolved-authorization locks, used nonces, outbox delivery statuses.
- **Audit evidence**: the hash-chained trail.
- **Credentials**: Airwallex API keys, console session token, operator promotion token, mail
  endpoint token, approver private key.
- **Availability**: the console and its state files.

Actors: an external attacker who can reach the console port; untrusted vendor terms (prompt
injection against the model extractor); a malicious or compromised mail endpoint; an operator
making an honest mistake; replay of captured requests.

Trust boundaries and current posture:

| Boundary | Threat | Current mitigation | Gap |
| --- | --- | --- | --- |
| Browser -> console | Session theft, CSRF, XSS, rebinding | With OIDC configured: authorization-code+PKCE, server-side sessions (HttpOnly, SameSite=Lax, Secure+__Host- in production), no token in HTML; host allowlist, origin allowlist on POST, zod-validated bodies, CSP + nosniff + no-referrer headers, 256KB body cap, sanitized 500s, per-IP POST rate limit. Demo mode (no OIDC): per-run random meta-tag token, dev-only | Session store in-memory (restart logs out); rate limit is per-IP fixed-window, not per-identity; IdP outage = console login down (fail-closed by design) |
| Vendor terms -> model | Prompt injection steering extraction | Model only proposes; deterministic policy decides; human approves; terms hashed and bound | Red-team coverage exists; expand injection corpus |
| Console -> Airwallex | Ambiguous outcomes, replay | Locks on unknown outcome, reconcile-before-retry, request-id reuse - verified LOCALLY against the simulator and the crash drill; live changed-deal/decline/reapproval flow verified 3 November on 8190227; arbitrary crash/transport ambiguity remains a separate proof requirement | Crash-mid-flight recovery drill done locally (scripts/crash-drill.ts); live-provider idempotency and crash behavior remain unproven |
| Console -> mail endpoint | SSRF, credential leak, ambiguity | Endpoint is operator-configured; pre-send vs post-arrival failure split; promotion token-gated; production guard: https-only, private-literal refusal, resolution-time address validation in the connect path (DNS rebinding), redirects never followed (no body/token leak to a second origin) | HTTP endpoint contract is self-defined and locally tested only; separate Gmail transport has earlier approved real-provider proof (item 5) |
| State files | Corruption, partial write, tamper | sqlite engine: WAL + FULL sync, transactional commits, integrity_check fail-closed, single-writer lease with stale-takeover + operator breakLease (demo: atomic tmp+rename JSON); hash-chained audit; persisted approver key | Aggregate not yet normalized relationally; state backup automation is operator duty |
| Dependencies | Known CVEs, supply chain | Four runtime deps (jose, pdf-lib, zod 4.6.7, undici for the resolution-time SSRF guard), lockfile committed, npm audit clean, `verify:security` gate | Audit gate must stay in the verify loop; undici pin reviewed on upgrades |
| Process | Crash, restart | Persist on every mutation, graceful SIGINT/SIGTERM with final flush, /healthz + /readyz | Crash-mid-flight drill (item 6) |

## Gap register and plan

Status update, 3 November 2026: sandbox issuance and agentic changed-deal E2E are working (README, runtime8190227). Provider card-status reads were added and verified against existing frozen cards on96cdf63, without another purchase. These results do not close the production recovery/deployment gaps below. Older environment observations are history, not claims of a continuing sandbox outage.


| # | Area | Status | Next verified step |
| --- | --- | --- | --- |
| 1 | Authentication (who is the user) | seam implemented + hardened after adversarial review (chunk 2 + fix): OidcProvider (authorization-code+PKCE, ID-token verification via jose - RS256 only, iss/aud/exp/nbf with 60s tolerance - plus azp on multi-aud, nonce echo, email_verified required for email-based membership). Discovery/JWKS/token fetches pinned to the issuer origin, redirects never followed (client_secret cannot leak off-origin). Sessions: opaque server-side ids, HttpOnly/SameSite=Lax (Secure+__Host- in production), fresh id at callback (no fixation), server-side logout. Local test-IdP coverage includes hostile paths; earlier Google approver run is recorded in README. Current Cloud Shell preview Google sign-in is NOT verified: redirect_uri_mismatch remains. No production deployment identity proof or external audit is claimed | Use a stable owner-approved callback/deployment or the owner's machine. OAuth redirect changes need owner approval; no workaround that disables authentication in production. Session store is in-memory (restart = re-login) |
| 2 | Authorization (roles: viewer/operator/approver) | DENY-BY-DEFAULT: unlisted authenticated users get no role and are refused everything (even reads); /api/whoami alone stays reachable so the page can say 'not enrolled'. Roles: approver (approve/reject/promote-email) > operator (mutations) > viewer (reads), membership via INTENTPAY_OIDC_APPROVERS / INTENTPAY_OIDC_VIEWERS - sub entries always match, email entries match only a verified email claim. Approver of record binds to the authenticated identity, never a client string. CSRF: cookie-auth mutations require an allowed Origin header (SameSite=Lax + JSON content-type as additional barriers) | Role review against D1's user list once the owner names them |
| 3 | Server hardening | done (chunk 1, HTTP-level tests in test/console-server.test.ts + config tests in test/console-config.test.ts): 256KB body cap, sanitized 500s, CSP/nosniff/no-referrer headers, /healthz + /readyz, graceful shutdown with final state flush, production config validation, mail-endpoint SSRF guard (https-only + private-literal + resolution-time validation + no redirects), per-IP POST rate limit, production boot fail-closed pending item 1 | Authn (item 1) then replaces the demo-token model |
| 4 | Durable state | StateStore seam + SqliteStore implemented (test/console-state.test.ts): WAL + synchronous=FULL, one transaction per aggregate commit, integrity_check fail-closed on open, concurrent-writer locking, legacy JSON auto-migration (renamed .migrated, never deleted). Production defaults to sqlite (console-state.db), demo stays json. node:sqlite is EXPERIMENTAL in this runtime - pinned and tested here, flagged for the deployment target. Aggregate is still one JSON document per entity kind - full relational normalization deferred | Crash-mid-flight drill (G6) + restore runbook; re-verify node:sqlite stability on the deployment Node version |
| 5 | Email delivery | VERIFIED REAL 27 Oct: Gmail API transport (users.messages.send, documented receipt contract) sent the owner-approved proof from/to sandi@vyayasan.com - positive-acceptance Message id plus independent inbox-arrival readback via the owner's connected Gmail (exactly one message, INBOX+SENT labels). OAuth: dedicated Internal client, gmail.send scope only, secrets vault-only. A real-run bug was found and fixed (undici 7 lookup all-flag contract in the SSRF dispatcher, f1d79d6) - the synthetic harness never exercised the real connector path | Recipients/wording approval required per send class; refresh-token revocation invalidates the credential (re-consent runbook in docs/gmail-transport-setup.md) |
| 6 | Failure recovery | drilled (npm run drill:crash, scripts/crash-drill.ts): SIGKILL after provider-committed-but-unpersisted at BOTH dangerous points - restart recovers honest state (no phantom card, unreconciled lock survives, blind retries refused 409). Runbook docs/RECOVERY.md covers lease takeover, corruption, consumed-nonce and unresolved-lock recovery. Single-writer lease added to SqliteStore (fresh foreign lease refuses boot, stale takeover after 30 min, breakLease operator path) | Known gap: no console-side case-reset for live mode after a consumed-nonce crash (operator freezes at provider + fresh approval cycle); state backups are operator duty |
| 7 | Supply chain | zod upgraded 3 -> 4.6.7 (high-severity memory-exhaustion CVE fixed), npm audit clean, `npm run verify:security` gate added | Pin review + audit gate stay part of the verify loop |
| 8 | Deployment | open. Submission bar (HackerEarth rules pulled 5 Oct) is working demo + <5-min video + repo - no live URL required, so hosting stays parked unless the owner wants a live product. Environment constraint verified 27 Oct: the cloud browser has NO inbound route to the agent sandbox (egress-IP connection refused at the edge; sandbox has only a link-local address), so browser-driven flows against a sandbox-hosted console (the real-IdP sign-in callback, any localhost capture) cannot run from this environment - they need the owner's machine or an approved deployment | Hosting target, domain and TLS termination are owner decisions (D2/D6) |

## Owner decision register (carried, not assumed)

- **D1 - Purpose and users**: who runs this in production (owner alone, a finance team, a
  pilot customer)? Drives auth model and scale assumptions.
- **D2 - Hosting**: where it runs (owner's machine, a cloud account - new-account gate applies).
- **D3 - Identity provider**: owner picks. Before ANY option is priced as 'new account',
  verify what already exists in the owner's authorised resources (Google Cloud projects, IdP
  tenants, org SSO). Note: the console's own OAuth client + consent-screen configuration is an
  account/config change - owner approval required even inside an existing Google account.
- **D4 - Email provider for real sends**: owner picks. Candidates must be verified against
  existing authorised resources first - the owner's connected Gmail integration available to the
  agent does NOT prove the product has Gmail OAuth credentials of its own; those are separate
  credentials with their own consent and approval gates. Recipients/wording approval required
  for any first real send regardless of provider.
- **D5 - Real-money activation**: unchanged - owner approval, plus Airwallex production
  onboarding status is unverified.
- **D6 - Domain and TLS termination**: follows D2.

## Independent adversarial review (27 Oct, snapshots b12e7ea + 2b070d6)

External reviewer reproduced 7 defects; all fixed with regression probes (their tests imported
into test/review* + test/review-regressions.test.ts, adapted only where the intended behavior
changed): F1 post-arrival garbage/truncated/dropped replies misclassified "definitely not sent"
-> ambiguous; F2 bare 2xx with unreadable receipt misclassified "sent" -> ambiguous; F3
IPv4-mapped/compatible IPv6 SSRF bypass (::ffff:127.0.0.1, ::ffff:a9fe:a9fe) -> refused;
F4 corrupt legacy JSON migrated into a clean sqlite boot (locks lost) -> fails closed as
corrupt; F5 stale-aggregate lost update across two writers -> single-writer lease (second
opener refused; merge by design NOT offered); F6 global audit trail exposed to viewers at the
API -> viewers get no audit; F7 unescaped card-control render sinks -> escaped (source probe
guards the sinks). Misc fixed: notification id collision (identical real events), state/audit
files 0600, unbounded pending-auth map, GET logout CSRF (POST-only + Origin), case-insensitive
sub matching. Documented limits (not defects, reviewer-concurred): audit tail truncation
invisible to verifyChain; CSP script-src 'unsafe-inline' remains while the page is
self-contained (externalization tracked); approval key regenerates if state is lost -
outstanding approvals then fail closed (RECOVERY.md); create-card second-card risk after an
ambiguous outcome requires the RECOVERY.md provider check (no console-side case-reset on live).


## Round-2 re-verification follow-ups (27 Oct, commits 71c5ca3 + this one)

The reviewer confirmed F1-F7 fixed on cb948ec with residuals, which this round addresses:

- **Structural: pending-card-creation lock (mandatory).** An ambiguous create-card/create-cardholder
  failure persists `createCardUnresolved` (nonce + cardholder id) and the console REFUSES both
  /api/approve and /api/create-card while it stands - a fresh approval carries a fresh nonce and
  hence a fresh provider idempotency slot, which is exactly how a duplicate card happens. The lock
  clears only through POST /api/reconcile-card, which reads the provider card listing
  (docs-verified: GET /api/v1/issuing/cards?cardholder_id=...). "none-created" requires an empty
  listing; "adopt" requires the card in this cardholder's listing; a gateway without a listing
  route gets 501 and live issuance stays disabled for that case. Enforcement in code, no runbook-only safety.
- **R1 lease race.** Acquire now runs under BEGIN IMMEDIATE with PRAGMA busy_timeout set before
  journal_mode; the reviewer's race probe re-run against the real class (8 synced process pairs):
  0 both-acquired, every pair exactly one acquirer.
- **R2 mail acceptance schema.** A 2xx proves delivery only with a strict {"accepted": true,
  "id"?} receipt; readable-but-arbitrary JSON is ambiguous, never "sent".
- **R3 NAT64/6to4.** isPrivateIp unpacks 64:ff9b::/96 and 2002::/16 embedded IPv4 before the
  private-range check; embedded private (10.x, 127.x, 192.168.x) refused, embedded public (8.8.8.8) allowed.
- **R4 sqlite hygiene.** WAL/SHM chmod 0600 (they can hold approver-key pages); idle lease owners
  heartbeat at TTL/3 so a live idle console can no longer be broken by a second opener.
- **HMAC restart key.** Production loads/creates a 0600 persisted key file (or INTENTPAY_HMAC_KEY)
  instead of a per-boot random key that silently invalidated outstanding approvals on restart.
- **CSP.** Console JS/CSS externalized to same-origin /console.js + /console.css; script-src is
  now 'self' only - no inline script executes at all. (style-src keeps 'unsafe-inline' for style
  ATTRIBUTES, which cannot execute script; noted as a deliberate, lower-risk remainder.)
- **Tenant boundary (explicit decision, unsettled).** Operators and approvers see the global audit
  trail; viewers see none. That is acceptable ONLY under an explicit single-tenant deployment
  boundary: one organization per console deployment. The user's broad-audience direction makes
  multi-tenant isolation a likely future requirement - it is NOT built and NOT claimed. Any
  multi-tenant hosting decision is an owner decision (D-register), not an implementation default.

## Verification standards (unchanged)

No mocks as proof: a claim needs a real run of the real component (a local real server beats a
stub; a stubbed claim is labelled synthetic). Fresh-clone verification before any ready claim.
Pixel inspection for UI claims. Forced failures carry in-frame labels.


## Round-3 independent review (N1-N4) — closed

Independent adversarial review of the round-2 snapshot found four more issues; all closed in this commit, with the reviewer's reproduction file imported into `test/review-round3.review.test.ts` (two spots adapted with in-file comments where the intended behavior changed).

- **N1 — adopt now verifies and corrects provider-side controls.** Adopting a stray provider card previously trusted our intent overlay while the provider card kept its own (possibly wide-open) authorization controls. Adopt now reads the provider card's controls, requires an exact match with the approved intent payload, and otherwise corrects them via the provider's controls update and re-verifies the read-back before adopting. If controls cannot be brought in line, adopt refuses (409) and the operator path is freeze-stray.
- **N2 — cardholder id is durable.** The provider cardholder id is persisted in the state store (both SQLite and JSON file stores) immediately after creation and restored on restart, so a restart can no longer strand a case in cardholder-ambiguous state. When the id is missing (e.g. commit-then-crash), it is recovered by provider-verified email lookup instead of dead-ending every reconcile decision with 409.
- **N3 — "none-created" requires attestation plus a double-checked empty listing.** An operator can no longer unlock a case by asserting no card exists on the strength of a single page-1 listing. The decision now requires a typed attestation (min 8 chars) and two consecutive empty provider listings; any change between reads refuses. Card listing is fully paginated with a fail-closed page bound.
- **N4 — IPv6 SSRF parsing replaced with a real parser.** The regex tower was replaced with a structured IPv6 parser (8 groups, `::` compression, trailing dotted-quad). Classification covers loopback, link-local, ULA, v4-mapped, v4-compatible, NAT64 (compressed and expanded) and 6to4; unparseable v6-shaped input fails closed.

New operator decision: **freeze-stray** — freezes a stray provider card and requires the re-listing to show it non-ACTIVE before clearing the lock; no card is adopted.

## Round-4 independent review (N5 + N3 residual) — closed

- **N5 (HIGH) — provider errors are not absence.** Cardholder lookup is now tri-state everywhere
  (`found` / `absent` / `unknown`): the live gateway no longer swallows list errors into an empty
  result, a throwing gateway in the reconcile path maps to `unknown` (lock stands, 409), and
  `createCardholder` refuses to create when the pre-create lookup failed — the duplicate-cardholder
  hole on transient provider errors is closed. Only a successful empty listing counts as absence.
- **N3 residual — none-created needs authoritative absence.** Two immediate empty reads establish
  no consistency window, so the unlock is now gated on a gateway capability
  (`supportsAuthoritativeAbsence`). The simulator (strongly consistent) keeps the
  attestation + double-empty-read flow; the live Airwallex gateway sets it false because no
  read-after-write consistency guarantee is documented on cards/list or cardholders/list (docs
  checked 2026-10-27) — none-created refuses with a pointer to adopt / freeze-stray.
- **N4 follow-up — public embedded forms.** The reviewer's adversarial set caught a parse bug:
  a dotted-quad tail after a compression marker (`64:ff9b::8.8.8.8`) was mis-split and failed
  closed. Fixed; NAT64/6to4 classify the EMBEDDED IPv4, so public embeddings stay public and
  private/link-local embeddings stay blocked. Round-4 file imported verbatim as
  `test/review-round4.review.test.ts`.

## Round-5 independent review — closed (flake named and fixed, repo hygiene)

The reviewer's re-verification of the round-4 snapshot confirmed all code findings closed and left
two actionable items, both closed here; their 11 round-5 tests are imported verbatim as
`test/review-round5.review.test.ts`.

- **Cold-start flake NAMED and fixed.** One fresh-extract suite run had shown 1 failed / 332
  passed without the test name captured. Reproduced under repetition and captured:
  `test/round2-hardening.test.ts > two synced openers never both acquire` failing with a
  store-corrupt classification. Root cause: two processes opening a fresh SQLite file at the same
  time make the setup PRAGMAs throw SQLITE_BUSY/SQLITE_LOCKED despite `busy_timeout`; the open
  path then called `close()` on an unopened handle, whose "The database is not open" error masked
  the busy error, and the catch-all classified the store as corrupt. The store failed closed, so
  safety held — but a transient busy is not corruption. The constructor now retries transient
  busy/locked opens with bounded synchronous backoff (8 attempts), classifies only non-busy
  failures as corrupt, and exposes the corrupt reason for post-mortem logging. The race probe now
  prints that reason, so any recurrence is self-describing. Verified: 10 consecutive clean runs of
  the race suite plus repeated full suites (previously ~1 failure per full-suite run).
- **Repository hygiene.** 112 tracked empty epoch-millisecond SQLite files (swept in by a broad
  `git add -A` during round-2 verification runs) are untracked and deleted; `.gitignore` now covers
  DB/WAL/SHM/HMAC/state/key artifact patterns; `npm run check:clean` fails the build if source
  artifacts or secret-shaped strings are tracked. (The generator was initially recorded as
  unidentified; round-6 identified it - see below.)

Also in this round: an opt-in Gmail API notification transport (`src/notify/gmailTransport.ts`,
`test/notify-gmail.test.ts`). Documented-contract discipline: 2xx with a Message id is SENT; a
Google JSON error body is DEFINITELY not sent; unparseable responses and timeouts are AMBIGUOUS
(never auto-resent); a token-refresh failure is definite for that email because the send was never
attempted. Resolution-time SSRF checks pin delivery to gmail.googleapis.com and
oauth2.googleapis.com. The transport is inert unless the operator explicitly selects it via
environment; preview/dry-run remains the default.

## Round-6 independent review (N6-N7) - closed

- **N6 (MED) - Gmail 5xx is never "definitely not sent".** A parseable Google error body on a
  5xx was classified as a definite rejection, but a commit-then-500 is exactly the ambiguous
  shape the mail discipline exists for: the send may have happened server-side. Only a
  documented 4xx Google error body is definite (request validated and refused before any
  message was created); every 5xx, parseable or not, is AMBIGUOUS and never auto-resent.
- **N7 (LOW) - the epoch-file generator was the R1 race probe itself.** Under `tsx --eval`,
  `process.argv` is `[node, arg1, arg2]`; the probe read `argv[2]`/`argv[3]`, so the store path
  became the start-barrier epoch value (creating a stray epoch-named SQLite file in the working
  directory on every round) and the start barrier was `undefined` (unsynchronized children).
  Corrected to `argv[1]`/`argv[2]`; the probe now uses the intended temp-dir path and a real
  synchronized start, creates zero stray files, and still refuses exactly one opener per round
  (8/8 rounds). The reviewer's independently synchronized probe (16/16 exactly one) confirms
  the busy-retry semantics against genuine contention. Round-6 file imported verbatim as
  `test/review-round6.review.test.ts` (13 tests).
