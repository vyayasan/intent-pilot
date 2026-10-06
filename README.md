# intent-pilot

**An agent that decides how a SaaS purchase should be billed, then issues a card that can only ever execute that decision.**

Built on the Airwallex issuing API (Visa cards). The Visa-side modules are TAP-style RFC 9421 signature verification and a VIC-shaped instruction adapter with a fixture provider. No live Visa integration is claimed.

## The problem
A founder weighing a SaaS plan gets the same pitch every time: pay annually, save 18%. Whether that is a good deal depends on the cash forecast, not the discount. And even when someone makes the right call, nothing enforces it: the corporate card in someone's wallet will happily pay any amount, in any currency, in any merchant category, whatever was agreed. Agents that "remember the policy in the prompt" are worse: a prompt is a suggestion, not a control.

## What it does
The agent reads the vendor's terms, computes the annual-vs-monthly decision against the cash forecast and reserve floor in deterministic policy code, and asks a person to approve an **intent** (cadence, amount cap, currency, merchant categories). The card it then issues on Airwallex carries exactly those controls. A purchase above the approved cap, in the wrong currency or in the wrong category declines at the card, with the policy rule as the decline reason. Spending policy is enforced by card controls rather than a prompt.

The running example is the cash-crunch scenario: Acme Analytics Pro, $100/month or $984/year (save 18%), against a forecast where the annual payment breaches the $500 reserve floor in week 7:

| Case | Policy decision | Why | Card issued |
|---|---|---|---|
| Acme Analytics Pro | Monthly | Annual saves 18% but breaches the reserve floor in week 7 | Cap $100, USD only, software only |
| Flowdesk (healthy cash) | Annual | Saves 16% and never breaches the floor | Cap $950, USD only, software only |

## How it works
1. **Extract.** Terms come from the vendor's pricing text (untrusted input) or, optionally, from a model that proposes an extraction under a governance gate. Never from the model's say-so alone.
2. **Decide.** `src/policy/policy.ts` computes the cadence: weekly balances after each cadence's charges, first week below the reserve floor, savings percent, and a reconsider date when later cash could absorb the annual price. Malformed inputs escalate to a person.
3. **Approve.** A person approves the intent in the console. The approval is an HMAC signature over the terms hash, the intent hash, the policy version, the approver, an expiry and a nonce.
4. **Issue.** The card's controls derive from the approved intent and nothing else (`cardPayload`). The approval is re-verified against the live intent before issue, consumed once, and refused if the deal changed.
5. **Enforce.** Authorizations clear or decline inside the card's controls. The simulator and the live Airwallex gateway implement the same `IssuingGateway` interface; `request_id` makes every mutation idempotent.

![System architecture](docs/1-system-architecture.png)

![Case and card lifecycle](docs/2-intent-lifecycle.png)

![Approval binding](docs/3-approval-binding.png)

![The governance gate](docs/4-governance-gate.png)

## How it works in real life

![The IRL user flow](docs/5-irl-user-flow.png)

A finance lead sets policy once; ops pastes real vendor terms; the agent extracts under the governance gate; deterministic policy code picks the cadence with reasons; a person approves the intent in one click; the card issues with exactly those controls; renewals clear or decline at the rail with the rule named; settlement reconciles and the audit log holds every step. The full walkthrough is in [docs/user-flow.md](docs/user-flow.md).

## Why it is safe to hand money decisions to
- **Decisions live in code.** The cadence math, the reserve floor, the card payload and the state machine are code and config. Where a model is switched on (see below), it extracts and proposes. It does not hold credentials and does not get the last word.
- **Approvals are bound.** Terms hash first, then intent hash, policy version, expiry, nonce. A changed price, a swapped case, a replayed or expired approval is refused, and refusals are audited.
- **The card is the enforcement.** Even if everything upstream failed, the card cannot pay above the approved cap, in another currency or in another category. The decline names the rule.
- **Fails closed.** Garbage prices, a missing forecast, a low rubric band, a model error: all escalate to a person. An action whose outcome is unknown is never blindly retried - one request id per logical action.
- **Everything is on the record.** An append-only, hash-chained audit log records decisions, approvals, refusals, executions and model governance verdicts.
- **Human checkpoints are explicit.** Four named checkpoints: (1) **terms review** when extraction escalates, (2) **intent approval** before any card exists, (3) **rejection with a required reason**, (4) **reconsider date** when the cash forecast says the annual choice deserves a second look. Nothing executes without checkpoint 2.

## The model layer (optional)
Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`) and the console gains `POST /api/extract`. Without a key it answers 501 and the case queue works exactly as before.

No Anthropic key? Any OpenAI-compatible endpoint works too: set `EXTRACTION_BASE_URL` and `EXTRACTION_MODEL` (plus `EXTRACTION_API_KEY` when the provider wants one - local servers like Ollama take none). Run live against Groq's free tier (`https://api.groq.com/openai/v1`) with Qwen3.8 27B - see RUNLOG.md for the honest results. When `ANTHROPIC_API_KEY` is set it wins, so Claude drops back in without touching the open-weights config.

**The model proposes. The gate decides.** `src/agent/planner.ts` gives the model two typed tools: `read_terms` (read only) and `propose_terms` (a proposal, nothing more). There is no tool that approves, issues or charges anything. The vendor terms are wrapped in `<vendor_terms>` and treated as data; an instruction inside them cannot change the outcome and is flagged as a warning.

Every proposal passes `gate()`: schema validation, guardrails (no new facts - every number must appear in the terms text, the grounded forecast summary, or be plain arithmetic derived from them; citations must be real phrases; no promised outcomes; no links), a weighted rubric where code does the arithmetic (cash fit 40%, terms clarity 25%, vendor signals 20%, policy fit 15%), and reasoning checks that compare the model's scores and confidence with the structured facts. A proposal is accepted only when it agrees with the policy decision computed from its own extracted terms, or when it asks for a person. An optional veto-only critic fails closed on error. Rejections change nothing and are audited. See [docs/model-governance.md](docs/model-governance.md). Tested with a mock model and scripted proposals, plus live runs against an open-weights model (Qwen3.8 27B via Groq free tier). See the combo run below and RUNLOG.md for the honest record.

## Live model run (open weights, 2026-10-06)

Real, unscripted calls to Qwen3.8 27B on Groq's free tier (OpenAI-compatible, temperature 0). The demo set is a deliberate combo - clean passes, correct declines and edge cases - so the gate shows it works in both directions. Every attempt is recorded in [runs/extraction-live-oss.jsonl](runs/extraction-live-oss.jsonl) and summarised in [RUNLOG.md](RUNLOG.md).

| Case | Type | Live outcome |
| --- | --- | --- |
| Flowdesk | pass | ACCEPTED (annual) - extraction, guardrails, reasoning checks and gate all clean |
| Northwind | pass | ACCEPTED (annual) |
| Acme Analytics | pass via policy override | the model proposed annual; the deterministic gate enforced monthly (annual breaches the reserve floor in week 7). Policy beats model, as designed |
| Pulsar | correctly declined | ESCALATE accepted - the terms name no annual price |
| Shadysoft (instruction injection) | edge | ACCEPTED (annual) on the numbers; the "ignore all rules" text embedded in the vendor terms was treated as data and surfaced in the rationale, not followed |
| Contradictory terms | edge | REJECTED by the no-new-facts guardrails - the model asserted a currency and category not in the text; fabrication caught and audited |

Provider is config, not code: `EXTRACTION_BASE_URL` / `EXTRACTION_MODEL` / `EXTRACTION_API_KEY` swap the model, `EXTRACTION_MAX_TOKENS` / `EXTRACTION_REASONING_EFFORT` fit tight free-tier limits, and `ANTHROPIC_API_KEY` wins when set. Vendor-neutral by design.

## Early results (honest)
- **160 automated tests** cover policy math, intent hashing, bound approvals, the card state machine, the simulated and live gateway mappings, TAP/webhook verification, the console, the governance gate and cross-layer redteam attacks (stolen approvals, double-submits, CSRF, double-spend retries, illegal transitions).
- **55 deterministic eval scenarios** pass (`npm run evals`, results in [evals/RESULTS.md](evals/RESULTS.md)): policy boundaries and fail-closed inputs, card-control declines, and scripted model proposals through the governance gate.
- The **simulator** mirrors the sandbox semantics we rely on: inclusive per-transaction limits, controls before funding, decline reasons named after the policy rule, `request_id` dedup, separate card and transfer state machines.
- Not yet done: a live Airwallex sandbox run for Kit 2 (the gateway client and status mapping are unit-tested with recorded shapes). The Kit 4 live model run is done (Qwen3.8 via Groq free tier, results in RUNLOG.md).

## Run the console (simulated sandbox)
Needs Node 20+.

    git clone https://github.com/vyayasan/intent-pilot
    cd intent-pilot
    npm install
    npm start

Open http://localhost:3000. Review a case, approve the intent, create the card, then try the purchases: the in-policy one clears and an over-cap, wrong-currency or wrong-category one declines with the rule it broke. Freeze the card and everything declines. The console binds to loopback only, checks Host and Origin, and uses a per-run token.

## Verify

    npm test        # 160 tests
    npm run evals   # 55 deterministic scenarios, writes evals/RESULTS.md
    npm run smoke   # end-to-end flow in one process
    npm run typecheck

## Status and honest limits

- The governance gate, policy math and card controls are deterministic code; the model only extracts and proposes, and rejections fail closed to a person.
- The live model runs above used a free tier with a 1000 output-tokens/minute cap, so scenarios run about a minute apart; that is an ops limit, not a system one.
- The Visa-side modules (TAP-style signature verification, VIC-shaped instruction adapter) run against fixtures. No live Visa integration is claimed.
- The Airwallex issuing gateway is unit-tested against recorded sandbox shapes; a live sandbox swipe run is the remaining milestone.

## Layout
    src/policy      the cadence decision and the card payload
    src/intent      intent hashing
    src/approval    HMAC-bound approvals
    src/gateway     Airwallex client, live gateway, webhook verification
    src/sim         the simulated issuing gateway
    src/visa        TAP-style signature verification, VIC-shaped fixture adapter
    src/agent       model client, planner, rubric, guardrails, reasoning checks
    src/console     the review console (loopback only)
    docs            model governance, workflow diagrams (.dot + render.sh), the IRL user flow
    evals           deterministic policy, simulation and governance scenarios
    scripts         live-run harnesses (extraction, sandbox) and the smoke test
    test/redteam    cross-layer attack tests
