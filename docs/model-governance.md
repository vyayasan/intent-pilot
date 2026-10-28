# Model governance

The model reads untrusted vendor terms and proposes an extraction and a cadence. It cannot approve, issue or charge anything: its only tools are `read_terms` and `propose_terms`. Policy code computes the decision from the extracted terms, and a person approves the intent.

## The pipeline
1. **Schema.** The proposal must parse: cadence, confidence, a rationale, extracted terms, cited facts and rubric scores. Anything else is an error, not a degraded accept.
2. **Guardrails** (`src/agent/guardrails.ts`). Rejections: a number in the extraction or rationale that appears neither in the terms text nor in the policy context (`no_new_facts`); a cited fact that is not a real phrase from the text; promised outcomes like "risk-free" (`bounded_language`); links (`no_links`). Warnings, not rejections: instruction-like wording inside the terms ("approve the annual plan now") - the text is data, and the warning lands in the audit log.
3. **Rubric** (`src/agent/rubric.ts`). The model scores four criteria 0-5 with citations; code computes the weighted total and band (cash fit 0.4, terms clarity 0.25, vendor signals 0.2, policy fit 0.15). The model never does the arithmetic. A weak band sends the case to a person even when the proposal agrees with policy.
4. **Reasoning checks** (`src/agent/reasoning-checks.ts`). Scores must not contradict the structured facts (high cash fit plus an annual proposal while annual breaches the floor), high scores need citations, and high confidence needs a strong band. These can only reject.
5. **Policy comparison.** Accepted when the proposed cadence agrees with the policy decision computed from the extracted terms, or when the proposal asks for a person. Anything else is rejected and the policy decision stands; no terms are stored.
6. **Optional critic.** A second model call that can only veto. An error is a veto: the layer fails closed.

## What the audit log records
Every proposal lands in the hash-chained audit log with the gate verdict, the rubric total and band, the guardrail and reasoning checks that fired, warnings, and the critic's veto when one ran.

## Current limits
Tested with a mock model and scripted proposals (35 deterministic eval scenarios plus unit tests). Not yet run against the live model - that needs a key, and the console answers 501 without one.
