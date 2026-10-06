import { z } from "zod";
import { issue, ApprovalVerifier, type Approval } from "../approval/approval.js";
import { hashIntent, mintIntent } from "../intent/intent.js";
import { cardPayload, decide, DEFAULT_POLICY, type CadenceDecision } from "../policy/policy.js";
import type { Card, CardTransaction, PurchaseCase, PurchaseIntent, Terms } from "../domain/types.js";
import { AuditLog } from "../audit/audit.js";
import { makeSim, type IssuingGateway } from "../sim/simGateway.js";

// The console's case state: the purchase case plus where it is in the flow.
export interface CaseState {
  kase: PurchaseCase;
  forecast: { weeklyBalances: number[]; reserveFloor: number };
  intent?: PurchaseIntent;
  card?: Card;
  transactionIds: string[];
  rejected?: string;
  log: string[];
}

const ApproveBody = z.object({ caseId: z.string() });
const CreateCardBody = z.object({ approval: z.object({
  caseId: z.string(), intentId: z.string(), intentHash: z.string(), termsHash: z.string(),
  amountCap: z.number(), currency: z.string(), cadence: z.string(), categories: z.array(z.string()),
  policyVersion: z.string(), approver: z.string(), expiresAt: z.string(), nonce: z.string(),
  rationale: z.string().max(1024), sig: z.string(),
}) });
const SimulateBody = z.object({ caseId: z.string(), kind: z.enum(["in-policy", "over-cap", "wrong-currency", "wrong-category"]) });
const RejectBody = z.object({ caseId: z.string(), reason: z.string().trim().min(1).max(1024) }); // a rejection must say why
const FreezeBody = z.object({ caseId: z.string() });

export interface CaseView {
  kase: PurchaseCase;
  forecast: { weeklyBalances: number[]; reserveFloor: number };
  decision: CadenceDecision;
  intent?: PurchaseIntent;
  intentHash?: string;
  card?: Card;
  transactions: CardTransaction[];
  rejected?: string;
  log: string[];
}

export interface ConsoleApiOptions {
  gateway?: IssuingGateway;
  key?: string;
  approver?: string;
  now?: () => Date;
  audit?: AuditLog;
  sessionToken?: string;
  allowedOrigins?: string[];
  seedCases?: CaseState[];
}

/** Demo cases mirroring the Builder Guide scenario: annual saves 18% but breaches the floor in week 7. */
export function demoCases(): CaseState[] {
  const terms: Terms = { monthlyPrice: 100, annualPrice: 984, currency: "USD", category: "software", noticeDays: 30 };
  return [{
    kase: {
      id: "case_acme", vendor: "Acme Analytics",
      rawTerms: "Acme Analytics Pro: $100 per month, or $984 per year billed upfront (save 18%). 30 days notice on monthly plans. Billed in USD.",
      terms,
    },
    forecast: {
      weeklyBalances: [1500, 1500, 1500, 1500, 1500, 1500, 1500, 1400, 1400, 1400, 1400, 1400],
      reserveFloor: 500,
    },
    transactionIds: [],
    log: [],
  }];
}

/** A fetch-compatible API handler. In production this handler belongs on the server. */
export function createConsoleApi(options: ConsoleApiOptions = {}) {
  const key = options.key ?? "local-demo-signing-key-change-before-deploy-32";
  const approver = options.approver ?? "demo-reviewer";
  const now = options.now ?? (() => new Date());
  let gateway = options.gateway ?? makeSim();
  let holderId: string | undefined;
  // One verifier for the life of the process: a demo reset must not revive an already used approval.
  const verifier = new ApprovalVerifier(key);
  const audit = options.audit ?? new AuditLog();
  let cases = options.seedCases ?? demoCases();
  const find = (id: string) => cases.find((c) => c.kase.id === id);

  const view = (c: CaseState): CaseView => ({
    kase: c.kase,
    forecast: c.forecast,
    decision: c.kase.terms
      ? decide(c.kase.terms, { weeklyBalances: c.forecast.weeklyBalances, reserveFloor: c.forecast.reserveFloor, breachWeek: null }, DEFAULT_POLICY, now())
      : { cadence: "ESCALATE", reasons: ["terms not extracted yet"], savingsPct: null, annualBreachWeek: null, monthlyBreachWeek: null, reconsiderAt: null },
    intent: c.intent,
    intentHash: c.intent ? hashIntent(c.intent) : undefined,
    card: c.card,
    transactions: c.transactionIds.map((id) => (gateway as any).getTransaction?.(id)).filter(Boolean) as CardTransaction[],
    rejected: c.rejected,
    log: c.log,
  });
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const bad = (message: string, status: number) => json({ error: message }, status);

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST") {
      const origin = request.headers.get("origin");
      if (options.allowedOrigins && origin && !options.allowedOrigins.includes(origin)) { audit.append("refused", { reason: "origin not allowed", origin }); return bad("origin not allowed", 403); }
      if (options.sessionToken && request.headers.get("x-console-token") !== options.sessionToken) { audit.append("refused", { reason: "missing or wrong console token", path: url.pathname }); return bad("missing or wrong console token", 403); }
    }
    if (url.pathname === "/api/cases" && request.method === "GET") return json({ cases: cases.map(view), audit: audit.list() });
    if (url.pathname === "/api/reset-demo" && request.method === "POST") {
      gateway = makeSim(); holderId = undefined; cases = demoCases(); audit.append("reset", {});
      return json({ cases: cases.map(view) });
    }
    if (url.pathname === "/api/approve" && request.method === "POST") {
      const parsed = ApproveBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid approval request", 400);
      const c = find(parsed.data.caseId);
      if (!c || !c.kase.terms) return bad("case not found", 404);
      const d = decide(c.kase.terms, { weeklyBalances: c.forecast.weeklyBalances, reserveFloor: c.forecast.reserveFloor, breachWeek: null }, DEFAULT_POLICY, now());
      if (d.cadence === "ESCALATE") { audit.append("refused", { reason: "policy escalated; a person must resolve before approval" }, c.kase.id); return bad("policy escalated this case; approve is not available", 409); }
      const cap = d.cadence === "annual" ? c.kase.terms.annualPrice! : c.kase.terms.monthlyPrice!;
      c.intent = mintIntent({ vendor: c.kase.vendor, cadence: d.cadence, amountCap: cap, currency: c.kase.terms.currency, categories: [c.kase.terms.category], terms: c.kase.terms, reconsiderAt: d.reconsiderAt });
      const approval = issue(c.kase.id, c.intent, DEFAULT_POLICY.version, approver, key, 60_000, now(), `Policy recommends ${d.cadence}: ${d.reasons.join("; ")}`);
      c.log.push(`Intent approved by ${approver}: ${c.intent.cadence}, cap ${c.intent.amountCap} ${c.intent.currency}.`);
      audit.append("approval_issued", { cadence: c.intent.cadence, amountCap: c.intent.amountCap, currency: c.intent.currency, termsHash: c.intent.termsHash, nonce: approval.nonce }, c.kase.id);
      return json({ approval, case: view(c) });
    }
    if (url.pathname === "/api/create-card" && request.method === "POST") {
      const parsed = CreateCardBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid create-card request", 400);
      const approval = parsed.data.approval as Approval;
      const c = find(approval.caseId);
      if (!c || !c.intent) return bad("case not found", 404);
      const refusal = verifier.check(approval, c.kase.id, c.intent, DEFAULT_POLICY.version, now());
      if (refusal) { audit.append("refused", { reason: refusal, nonce: approval.nonce }, c.kase.id); return bad(refusal, 409); }
      // Consume BEFORE the gateway call: if the call errors after an ambiguous remote commit, a blind retry must not double-create.
      verifier.consume(approval);
      try {
        // One request id per logical action: the nonce alone would alias cardholder and card creation to the same idempotent slot.
        if (!holderId) holderId = (await gateway.createCardholder({ name: "Sandi Samantaray", email: "sandi@vyayasan.com" }, `${approval.nonce}:cardholder`)).id;
        const controls = cardPayload(c.intent);
        c.card = await gateway.createCard({ cardholderId: holderId, controls }, `${approval.nonce}:card`);
        c.log.push(`Card ${c.card.id} created: limit ${controls.amountLimit} ${c.intent.currency} per transaction, currencies ${controls.currencyAllowlist.join("/")}, categories ${controls.merchantCategories.join("/")}.`);
        audit.append("card_created", { cardId: c.card.id, controls, nonce: approval.nonce }, c.kase.id);
        return json({ card: c.card, case: view(c) });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "card creation failed";
        audit.append("outcome_unknown", { error: msg, nonce: approval.nonce }, c.kase.id);
        return bad(`outcome unknown, reconcile before retrying: ${msg}`, 409);
      }
    }
    if (url.pathname === "/api/simulate" && request.method === "POST") {
      const parsed = SimulateBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid simulate request", 400);
      const c = find(parsed.data.caseId);
      if (!c?.card || !c.intent) return bad("create the card first", 409);
      const base = { merchant: c.kase.vendor, category: c.intent.categories[0], currency: c.intent.currency };
      const auth = parsed.data.kind === "in-policy" ? { ...base, amount: c.intent.amountCap }
        : parsed.data.kind === "over-cap" ? { ...base, amount: c.intent.amountCap + 1 }
        : parsed.data.kind === "wrong-currency" ? { ...base, amount: c.intent.amountCap, currency: "EUR" }
        : { ...base, amount: c.intent.amountCap, category: "travel" };
      const t = await gateway.authorize(c.card.id, auth, `${c.kase.id}:${parsed.data.kind}:${c.transactionIds.length}`);
      c.transactionIds.push(t.id);
      if (t.status === "PENDING") {
        await gateway.capture(t.id, `${t.id}:capture`);
        c.log.push(`Authorization ${t.id} cleared: ${t.amount} ${t.currency} at ${t.merchant}.`);
        audit.append("authorization_cleared", { transactionId: t.id, amount: t.amount, currency: t.currency }, c.kase.id);
      } else {
        c.log.push(`Authorization declined (${t.failureReason}): the card enforced the approved intent.`);
        audit.append("authorization_declined", { transactionId: t.id, reason: t.failureReason, amount: t.amount }, c.kase.id);
      }
      return json({ transaction: (gateway as any).getTransaction?.(t.id) ?? t, case: view(c) });
    }
    if (url.pathname === "/api/freeze" && request.method === "POST") {
      const parsed = FreezeBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid freeze request", 400);
      const c = find(parsed.data.caseId);
      if (!c?.card) return bad("create the card first", 409);
      // Freezing only ever tightens, so a person may do it without a bound approval.
      c.card = await gateway.freezeCard(c.card.id, `${c.kase.id}:freeze`);
      c.log.push("Card frozen by a person. New authorizations decline as card_frozen.");
      audit.append("card_frozen", { cardId: c.card.id }, c.kase.id);
      return json({ card: c.card, case: view(c) });
    }
    if (url.pathname === "/api/reject" && request.method === "POST") {
      const parsed = RejectBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid reject request", 400);
      const c = find(parsed.data.caseId);
      if (!c) return bad("case not found", 404);
      c.rejected = parsed.data.reason;
      c.log.push(`Reviewer rejected the case: ${parsed.data.reason}. No card was created.`);
      audit.append("recommendation_rejected", { reason: parsed.data.reason }, c.kase.id);
      return json({ case: view(c) });
    }
    return bad("not found", 404);
  };
}
