# IntentPay — Intent-Bound Purchase Agent

**Corporate cards that can only spend what a person approved.**

The agent reads vendor terms, a person approves the intent, and the card enforces it at the rail — wrong amount, currency or category declines with a named reason. Built on the Airwallex issuing API (Visa cards). Proven live on the Airwallex issuing sandbox.

The Visa-side modules are TAP-style RFC 9421 signature verification and a VIC-shaped instruction adapter with a fixture provider. No live Visa integration is claimed.

## The problem

A founder weighing a SaaS plan gets the same pitch every time: pay annually, save 18%. Whether that is a good deal depends on the cash forecast, not the discount. And even when someone makes the right call, nothing enforces it: the corporate card in someone's wallet will happily pay any amount, in any currency, in any merchant category. Agents that "remember the policy in the prompt" are worse — a prompt is a suggestion, not a control.

## What it does

The agent reads the vendor's terms, computes the annual-vs-monthly decision against the cash forecast and reserve floor in deterministic policy code, and asks a person to approve an **intent** (cadence, amount cap, currency, merchant categories). The card it then issues on Airwallex carries exactly those controls. Anything outside them declines at the card, with the policy rule as the decline reason.

| Case | Policy decision | Why | Card issued |
|---|---|---|---|
| Acme Analytics Pro | Monthly | Annual saves 18% but breaches the $500 reserve floor in week 7 | Cap $100, USD only, software only |
| Flowdesk | Annual | Saves 16% and never breaches the floor | Cap $950, USD only, software only |

## How it works

1. **Extract.** Terms come from the vendor's pricing text (untrusted input) or from a model proposing an extraction under a governance gate.
2. **Decide.** `src/policy/policy.ts` computes the cadence: weekly balances, first week below the reserve floor, savings percent, reconsider date. Malformed inputs escalate to a person.
3. **Approve.** A person approves the intent in the console — an HMAC signature over the terms hash, intent hash, policy version, approver, expiry and nonce.
4. **Issue.** Card controls derive from the approved intent and nothing else. The approval is re-verified before issue, consumed once, and refused if the deal changed.
5. **Enforce.** Authorizations clear or decline inside the card's controls. The simulator and the live Airwallex gateway implement the same `IssuingGateway` interface; `request_id` makes every mutation idempotent.

<p align="center"><img src="docs/1-system-architecture.png" alt="System architecture" width="900"/></p>

More diagrams — intent lifecycle, approval binding, the governance gate, the IRL user flow — in [docs/](docs/user-flow.md).

## The model layer (optional)

**The model proposes. The gate decides.** The model gets two typed tools: `read_terms` (read only) and `propose_terms` (a proposal, nothing more). There is no tool that approves, issues or charges anything. Vendor terms are wrapped in `<vendor_terms>` and treated as data — an instruction inside them cannot change the outcome.

Every proposal passes `gate()`: schema validation, no-new-facts guardrails, a weighted rubric where code does the arithmetic, and reasoning checks. A proposal is accepted only when it agrees with the deterministic policy decision, or when it asks for a person. Rejections change nothing and are audited. Details: [docs/model-governance.md](docs/model-governance.md).

Provider is config, not code:

- `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_MODEL`) — wins when set
- `EXTRACTION_BASE_URL` / `EXTRACTION_MODEL` / `EXTRACTION_API_KEY` — any OpenAI-compatible endpoint (local servers like Ollama take no key)
- Without any key, `POST /api/extract` answers 501 and the queue works as before

## Quickstart

```bash
git clone https://github.com/vyayasan/intent-pilot
cd intent-pilot
npm install
npm start
```

Open http://localhost:3000. Review a case, approve the intent, create the card, then try the purchases: the in-policy one clears; over-cap, wrong-currency and wrong-category ones decline with the rule they broke. Freeze the card and everything declines. The console binds to loopback only, checks Host and Origin, and uses a per-run token. With `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` set it runs live against the Airwallex sandbox instead of the simulator.

`npm run demo` runs the whole story against the sandbox, deterministic and narrated for screen recording. Sandbox money only.

## Verify

```bash
npm test        # 165 tests
npm run evals   # 55 deterministic scenarios, writes evals/RESULTS.md
npm run smoke   # end-to-end flow in one process
npm run typecheck
```

- **165 automated tests** — policy math, intent hashing, bound approvals, the card state machine, simulated and live gateway mappings, TAP/webhook verification, the console, the governance gate, and cross-layer redteam attacks (stolen approvals, double-submits, CSRF, double-spend retries, illegal transitions).
- **55 deterministic eval scenarios** — policy boundaries, fail-closed inputs, card-control declines, scripted model proposals through the governance gate ([evals/RESULTS.md](evals/RESULTS.md)).

## Proven live

- **Airwallex issuing sandbox (2026-10-06):** real cardholder, virtual cards issued with controls mirroring approved intents, authorizations passing and failing with the sandbox's own decline reasons (`LIMIT_EXCEEDED`, `CURRENCY_NOT_ALLOWED`, `MERCHANT_CATEGORY_NOT_ALLOWED`, `CARD_INACTIVE`), freeze/unfreeze, captures CLEARING.
- **Live open-weights model (2026-10-06):** unscripted extraction runs through the governance gate — clean passes accepted, a policy override enforced (model proposed annual, the gate enforced monthly on the reserve floor), an injection attempt treated as data and surfaced, fabricated facts rejected.

## Honest limits

- Decisions live in deterministic code; the model only extracts and proposes, and rejections fail closed to a person.
- The human approval in the demo is a click in a local console, not an authenticated session.
- The simulator mirrors the sandbox semantics relied on here; one documented difference: the sandbox simulator authorization endpoint does not deduplicate request ids, the control plane does.
- The Visa-side modules (TAP-style signature verification, VIC-shaped instruction adapter) run against fixtures. No live Visa integration is claimed.

## Layout

    src/policy      the cadence decision and the card payload
    src/intent      intent hashing
    src/approval    HMAC-bound approvals
    src/gateway     Airwallex client, live gateway, webhook verification
    src/sim         the simulated issuing gateway
    src/visa        TAP-style signature verification, VIC-shaped fixture adapter
    src/agent       model client, planner, rubric, guardrails, reasoning checks
    src/console     the review console (loopback only)
    docs            architecture and governance diagrams (.dot + render.sh), user flow
    evals           deterministic policy, simulation and governance scenarios
    scripts         live-run harnesses and the smoke test
    test            unit, gateway and cross-layer redteam suites

Built fast with AI pair-programming and reviewed by hand. MIT licensed. Copyright (c) 2026 Sandi Samantaray.
