import type {ContractSource,ContractSnapshot} from "../intake/salesforce.js";
import { parseNotice, makeNoticeProposal, digest, type NoticeProposal } from "../intake/notice.js";
import { ROLE_RANK, type AuthProvider, type Identity, type Role } from "./auth.js";
import { openStateStore, type StateStore } from "./state.js";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { issue, approverKeyId, ApprovalVerifier, type Approval } from "../approval/approval.js";
import { hashIntent, hashTerms, mintIntent } from "../intent/intent.js";
import { cardPayload, decide, DEFAULT_POLICY, type CadenceDecision } from "../policy/policy.js";
import type { CardControls } from "../domain/types.js";
import type { Card, CardTransaction, PurchaseCase, PurchaseIntent, Terms } from "../domain/types.js";
import { AuditLog } from "../audit/audit.js";
import { makeSim, type IssuingGateway } from "../sim/simGateway.js";
import { ExtractedTermsSchema } from "../agent/planner.js";
import { Outbox } from "../notify/outbox.js";
import { NotificationDispatcher } from "../notify/dispatcher.js";
import type { EmailTransport } from "../notify/transport.js";
import type { PlanResult } from "../agent/planner.js";
import { runAgent, type AgentRunResult } from "../agent/executor.js";
import type { ModelClient } from "../agent/model.js";

// An authorization whose outcome the gateway never confirmed. While one is unresolved the card
// is locked against purchase retries (a blind retry could duplicate a purchase); /api/reconcile
// reads the gateway ledger and either adopts the transaction it finds or clears the retry, which
// reuses the SAME request id so the provider's idempotency deduplicates a retry of an attempt
// that did in fact commit.
export interface PendingAuthorization {
  requestId: string;
  kind: string;
  cardId: string;
  amount: number;
  currency: string;
  merchant: string;
  startedAt: string;
  /** Known once authorize returned - a capture failure leaves the authorization itself certain. */
  transactionId?: string;
  lastError?: string;
  /** Set only by an operator's manual attestation (reconcile manualConfirm) - a local operator
   *  action, never proof of provider finality. A no-match ledger read alone does NOT unlock:
   *  this endpoint has no documented idempotency guarantee, and ledger visibility can lag. */
  reconciledAt?: string;
  manualConfirm?: string;
  /** A probable (heuristic) ledger match awaiting operator review. Does NOT unlock spending and
   *  is never treated as definitive: only an exact id match or a reviewed manual resolution clears it. */
  probableMatch?: { transactionId: string; status: string; basis: string; foundAt: string };
}

// The console's case state: the purchase case plus where it is in the flow.
export interface CaseState {
  contractSource?: ContractSnapshot;
  sourceInvalidated?: boolean;
  noticeProposal?: NoticeProposal;
  kase: PurchaseCase;
  forecast: { weeklyBalances: number[]; reserveFloor: number };
  /** Where the forecast scenario came from. Always a labelled test input, never observed finances. */
  forecastSource?: string;
  intent?: PurchaseIntent;
  card?: Card;
  transactionIds: string[];
  freezeState?: "pending" | "verified" | "unknown";
  requiresReapproval?: boolean;
  rejected?: string;
  pendingAuthorization?: PendingAuthorization;
  /** Set when create-card/create-cardholder failed with an unknown outcome: the provider may hold
   *  a card (or cardholder) we cannot see. While set, approve AND create-card are refused - a fresh
   *  approval carries a fresh nonce, hence a fresh provider idempotency slot, hence a possible
   *  duplicate card. Cleared only by POST /api/reconcile-card against a provider card listing. */
  createCardUnresolved?: { nonce: string; at: string; error: string; cardholderId?: string };
  /** Last successfully fetched ledger view per transaction id - preserved so a provider
   *  outage degrades to visibly-stale evidence instead of a silently empty list. */
  lastTransactions?: Record<string, { txn: CardTransaction; fetchedAt: string }>;
  log: string[];
}

const ApproveBody = z.object({ caseId: z.string() });
const AgentRunBody = z.object({ caseId: z.string(), approval: z.object({
  caseId: z.string(), intentId: z.string(), intentHash: z.string(), termsHash: z.string(),
}).passthrough(),
  // Scenario harness (operator-set at run launch): presents a violating charge to the agent's
  // own typed execute_purchase. Never model-visible; absence = the normal in-policy purchase.
  scenario: z.enum(["in-policy", "over-cap", "wrong-currency", "wrong-category"]).optional() });
const CreateCardBody = z.object({ approval: z.object({
  caseId: z.string(), intentId: z.string(), intentHash: z.string(), termsHash: z.string(),
  amountCap: z.number(), currency: z.string(), cadence: z.string(), categories: z.array(z.string()),
  policyVersion: z.string(), approver: z.string(), expiresAt: z.string(), nonce: z.string(),
  rationale: z.string().max(1024), sig: z.string(),
  approverKeyId: z.string().optional(), approverSig: z.string().optional(),
}) });
const ReconcileCardBody = z.object({ caseId: z.string(), decision: z.enum(["check", "adopt", "none-created", "freeze-stray"]), cardId: z.string().optional(), attestation: z.string().optional() });
const SimulateBody = z.object({ caseId: z.string(), kind: z.enum(["in-policy", "over-cap", "wrong-currency", "wrong-category"]) });
const RejectBody = z.object({ caseId: z.string(), reason: z.string().trim().min(1).max(1024) }); // a rejection must say why
const FreezeBody = z.object({ caseId: z.string() });
const CloseCardBody = z.object({ caseId: z.string() });
const ReconcileBody = z.object({ caseId: z.string(), manualConfirm: z.string().trim().min(8).max(500).optional() });
const ChangeTermsBody = z.object({ caseId: z.string(), terms: ExtractedTermsSchema, rawTerms: z.string().trim().min(1).max(8000) });
const NoticeBody = z.object({ caseId: z.string(), filename: z.string().min(1).max(160), content: z.string().min(1).max(8000) });
const NoticeApplyBody = z.object({ caseId: z.string(), proposalId: z.string(), confirm: z.literal(true) });
const noticeVersion = (c: CaseState) => digest(JSON.stringify({ terms: c.kase.terms, rawTerms: c.kase.rawTerms, intent: c.intent, card: c.card, forecast: c.forecast, reapproval: c.requiresReapproval, freeze: c.freezeState, pending: c.pendingAuthorization, unresolved: c.createCardUnresolved }));
const ExtractBody = z.object({ caseId: z.string() });
// Real case intake: the acceptance flow starts from actual vendor text, never seeded demo data.
// weeklyBalances/reserveFloor are TEST SCENARIO INPUTS (labelled in the UI and case log), never
// observed finances; sourceNote/forecastSource record provenance.
// rawTerms is stored as inert text - it is never fetched, resolved, or dereferenced.
const IntakeBody = z.object({
  vendor: z.string().trim().min(1).max(120),
  rawTerms: z.string().trim().min(1).max(8000),
  weeklyBalances: z.array(z.number().finite().nonnegative()).length(12),
  reserveFloor: z.number().finite().nonnegative(),
  sourceNote: z.string().trim().min(1).max(200),
  forecastSource: z.string().trim().min(1).max(200).optional(),
});
const PromoteBody = z.object({ id: z.string(), operatorToken: z.string() });
// Resolving a restored orphan/conflict is an operator attestation (round-8 A), NOT verified
// provider evidence and never cryptographic resolution: the person inspected the provider and
// takes responsibility, the 8-char minimum is a shape check only, and the operator token gates
// WHO may resolve, not WHAT is true. Like reconcile's manualConfirm, finality comes only from
// the provider.
const ResolveRestoredBody = z.object({
  caseId: z.string(),
  requestId: z.string(),
  resolution: z.enum(["no_matching_transaction", "transaction_recorded", "duplicate_confirmed_frozen"]),
  evidence: z.string().trim().min(8).max(1024),
  operatorToken: z.string(),
});

export interface CaseView {
  contractSource?: ContractSnapshot;
  sourceInvalidated?: boolean;
  noticeProposal?: NoticeProposal;
  kase: PurchaseCase;
  forecast: { weeklyBalances: number[]; reserveFloor: number };
  termsSource: string | null;
  forecastSource: string | null;
  decision: CadenceDecision;
  intent?: PurchaseIntent;
  intentHash?: string;
  card?: Card;
  cardStatusRead?: { state: "ok" | "unknown"; checkedAt: string; error?: string };
  transactions: CardTransaction[];
  /** Ledger read health: degraded = showing last-known entries; unavailable = no last-known either. */
  ledger: { state: "ok" | "degraded" | "unavailable"; lastKnownAt?: string; error?: string };
  /** Which email transport is selected: "preview" means nothing is sent, ever. */
  emailMode?: string;
  /** Fingerprint of the local demo approver key that signs approvals. */
  approverKeyId?: string;
  freezeState?: "pending" | "verified" | "unknown";
  requiresReapproval?: boolean;
  rejected?: string;
  pendingAuthorization?: PendingAuthorization;
  createCardUnresolved?: { nonce: string; at: string; error: string; cardholderId?: string };
  log: string[];
}

export interface ConsoleApiOptions {
  contractSource?: ContractSource;
  gateway?: IssuingGateway;
  /** Factory used on demo reset so a live console stays live; defaults to the simulator. */
  makeGateway?: () => IssuingGateway;
  /** Optional model-backed extractor. It proposes terms; governance gates them; a person still approves the intent. */
  /** Where case state (including unresolved authorization locks) is persisted across restarts. */
  stateFile?: string;
  /** Optional path to a preserved unresolved-authorization export; restored at boot, never auto-reconciled. */
  unresolvedRestoreFile?: string;
  /** Storage engine for stateFile: "json" (demo default, atomic tmp+rename) or "sqlite"
   *  (WAL, transactional commits - production default via server.ts). Ignored when store is given. */
  stateEngine?: "json" | "sqlite";
  /** Injected store (tests). Overrides stateFile/stateEngine. */
  store?: StateStore;
  /** DRILL-ONLY fault injection: SIGKILL the process at a named point. Forbidden in production
   *  (config validation errors); used by scripts/crash-drill.ts to prove recovery honestly. */
  drillCrashAt?: string;
  /** Who the email previews are addressed to. Previews only - no email is ever sent. */
  notificationRecipient?: string;
  /** Email transport. Null/absent = preview only, nothing is sent. A real provider, real
   *  recipients and real wording are a separate owner-approved decision, never a default. */
  emailTransport?: EmailTransport | null;
  /** Token an operator must present to promote a dry-run email record to a real send.
   *  Unset = promotion unavailable; promotion is never implicit in a mode switch. */
  operatorToken?: string;
  /** True when backed by the live sandbox: demo reset is then refused, so it can never clear
   *  live unresolved locks, consumed nonces or the live evidence trail as a "recovery" shortcut. */
  live?: boolean;
  planner?: (kase: PurchaseCase, forecast: { weeklyBalances: number[]; reserveFloor: number }) => Promise<PlanResult>;
  /** Live model for the post-approval execution agent (/api/agent-run). Absent: the route answers 501
      and card issuance stays a human button - the agent is never faked by a script. */
  executorModel?: ModelClient;
  key?: string;
  approver?: string;
  now?: () => Date;
  audit?: AuditLog;
  sessionToken?: string;
  /** Real authentication (OIDC). When present it replaces the demo session-token check entirely:
   *  every API call - reads included - requires an authenticated identity, and role checks apply. */
  auth?: AuthProvider;
  allowedOrigins?: string[] | (() => string[]);
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
      weeklyBalances: [1500, 1500, 1500, 1500, 1500, 1500, 1400, 1400, 1400, 1400, 1400, 1400],
      reserveFloor: 500,
    },
    transactionIds: [],
    log: [],
  }, {
    kase: {
      id: "case_flowdesk", vendor: "Flowdesk",
      rawTerms: "Flowdesk Team plan. Monthly billing: 40 USD per month. Annual billing: 400 USD per year, paid in advance. Cancel monthly plans with 14 days notice. Category: software.",
      terms: { monthlyPrice: 40, annualPrice: 400, currency: "USD", category: "software", noticeDays: 14 },
    },
    forecast: {
      weeklyBalances: [3000, 3050, 3100, 3150, 3200, 3250, 3300, 3350, 3400, 3450, 3500, 3550],
      reserveFloor: 500,
    },
    transactionIds: [],
    log: [],
  }, {
    kase: {
      id: "case_northwind", vendor: "Northwind CRM",
      rawTerms: "Northwind CRM Business: 80 GBP per month, or 768 GBP per year billed upfront (save 20%). 30 days notice on monthly plans. Category: analytics.",
      terms: { monthlyPrice: 80, annualPrice: 768, currency: "GBP", category: "analytics", noticeDays: 30 },
    },
    forecast: {
      weeklyBalances: [2800, 2850, 2900, 2950, 3000, 3050, 3100, 3150, 3200, 3250, 3300, 3350],
      reserveFloor: 500,
    },
    transactionIds: [],
    log: [],
  }, {
    kase: {
      id: "case_pulsar", vendor: "Pulsar Ads",
      rawTerms: "Pulsar Ads: 150 USD per month. Annual pricing on request - talk to sales. 60 days notice. Category: marketing.",
      terms: { monthlyPrice: 150, annualPrice: null, currency: "USD", category: "marketing", noticeDays: 60 },
    },
    forecast: {
      weeklyBalances: [1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200],
      reserveFloor: 500,
    },
    transactionIds: [],
    log: [],
  }];
}

/** A fetch-compatible API handler. In production this handler belongs on the server. */
export function createConsoleApi(options: ConsoleApiOptions = {}): ConsoleHandler {
  const key = options.key ?? "local-demo-signing-key-change-before-deploy-32";
  const approver = options.approver ?? "demo-reviewer";
  const now = options.now ?? (() => new Date());
  let gateway = options.gateway ?? makeSim();
  let holderId: string | undefined;
  const audit = options.audit ?? new AuditLog();
  // Seeds are used by REFERENCE: adversarial tests mutate the array they passed in to
  // change the deal underneath an approval - cloning would hide that from the handler.
  let cases = options.seedCases ?? demoCases();
  // Email previews: the exact emails each workflow step WOULD send. No transport, nothing is sent.
  let outbox = new Outbox(now, options.live ? "Airwallex sandbox simulation" : "Local simulator");
  const recipient = options.notificationRecipient ?? "sandi@vyayasan.com";
  const dispatcher = new NotificationDispatcher(() => outbox, options.emailTransport ?? null, now, (event, detail, caseId) => audit.append(event, detail, caseId));

  // Demo-grade approver identity: a local ed25519 keypair signs every approval, so card creation
  // cryptographically requires THIS approver's key - "only they can approve" is real locally.
  // Production binds approvals to SSO identity instead; this key is persisted in the local state
  // file (never committed) so a restart keeps the same approver identity.
  let approverPrivateKeyPem: string;
  let approverPublicKeyPem: string;
  let approverFp: string;
  // Durable state via the StateStore seam (json demo engine, sqlite production engine).
  const store = options.store ?? (options.stateFile ? openStateStore(options.stateFile, options.stateEngine) : undefined);
  // Persisted state always wins over any seed: a restart must never wipe intake cases or locks.
  const loadedState = store ? store.load() : null;
  const savedApproverKey = loadedState && loadedState !== "corrupted" && typeof loadedState.approverKey?.privateKeyPem === "string" && loadedState.approverKey.privateKeyPem
    ? loadedState.approverKey.privateKeyPem : undefined;
  if (savedApproverKey) {
    approverPrivateKeyPem = savedApproverKey;
    approverPublicKeyPem = createPublicKey(savedApproverKey).export({ type: "spki", format: "pem" }).toString();
  } else {
    const pair = generateKeyPairSync("ed25519");
    approverPrivateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    approverPublicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  }
  approverFp = approverKeyId(approverPublicKeyPem);
  // One verifier for the life of the process: a demo reset must not revive an already used approval.
  const verifier = new ApprovalVerifier(key, approverPublicKeyPem);
  // Unresolved authorization locks (and their request ids) must survive a process restart:
  // losing one would let a blind retry duplicate a purchase.
  // Corrupt state fails CLOSED: starting clean would silently drop unresolved authorization
  // locks, so instead every mutating endpoint refuses until an operator resolves the file.
  let stateCorrupted = loadedState === "corrupted";
  if (loadedState && loadedState !== "corrupted") {
    try {
      // Fail closed on any shape drift: a silently mis-loaded store could drop locks or used nonces.
      if (!Array.isArray(loadedState.cases) || (loadedState.cases as CaseState[]).some((x) => !x?.kase?.id || !Array.isArray(x?.log))) throw new Error("bad shape");
      cases = loadedState.cases as CaseState[];
      if (Array.isArray(loadedState.usedNonces)) verifier.restore(loadedState.usedNonces);
      if (Array.isArray(loadedState.notifications)) outbox.restore(loadedState.notifications as never);
      if (typeof loadedState.holderId === "string") holderId = loadedState.holderId;
    } catch { stateCorrupted = true; }
  }
  // Boot-time restore of PRESERVED unresolved authorizations. When the live state file is gone
  // but an operator export survived (export-before-teardown), the retry lock must come back with
  // the process - an unresolved attempt that is only archived could be blind-retried into a
  // duplicate purchase. A restored lock never marks anything reconciled; only the normal
  // /api/reconcile path (exact ledger id match or operator attestation) clears it.
  const restoredUnresolved: { caseId: string; requestId: string; cardId: string; kind: "orphan" | "conflict"; keptRequestId?: string }[] = [];
  if (options.unresolvedRestoreFile) {
    try {
      const raw = JSON.parse(readFileSync(options.unresolvedRestoreFile, "utf8"));
      const entries = (Array.isArray(raw) ? raw : raw.unresolved) as { caseId?: string; pendingAuthorization?: PendingAuthorization }[];
      if (!Array.isArray(entries)) throw new Error("bad restore shape");
      for (const e of entries) {
        const pa = e?.pendingAuthorization;
        if (!e?.caseId || !pa?.requestId || !pa.cardId) throw new Error("bad restore entry");
        if (pa.reconciledAt) continue; // already resolved before export - nothing to restore
        const c = cases.find((x) => x.kase.id === e.caseId);
        if (c && !c.pendingAuthorization) {
          c.pendingAuthorization = { ...pa, lastError: `${pa.lastError ?? "unknown outcome"} [lock restored from preserved export at boot]` };
          c.log.push(`Unresolved authorization ${pa.requestId} restored from preserved export - purchases stay refused until reconciled.`);
          audit.append("unresolved_authorization_restored", { requestId: pa.requestId, cardId: pa.cardId }, e.caseId);
        } else if (c && c.pendingAuthorization!.requestId === pa.requestId) {
          // Idempotent re-restore of the same preserved attempt: the live lock already enforces it.
        } else if (c) {
          // CONFLICT (round-8 E): the case carries a DIFFERENT live unresolved lock. Never
          // overwrite it and never drop the preserved attempt: the live lock stays on the case,
          // the preserved attempt joins the gated orphan list as a conflict, loudly audited.
          restoredUnresolved.push({ caseId: e.caseId, requestId: pa.requestId, cardId: pa.cardId, kind: "conflict", keptRequestId: c.pendingAuthorization!.requestId });
          audit.append("unresolved_authorization_restore_conflict", { keptRequestId: c.pendingAuthorization!.requestId, conflictingRequestId: pa.requestId, cardId: pa.cardId }, e.caseId);
        } else {
          // The case itself did not survive: an ORPHAN. It cannot be enforced case-locally, so
          // it joins the global purchase gate below - display alone would be zero enforcement
          // (round-8 A). Never auto-attach it to a same-vendor case: vendor is not identity.
          restoredUnresolved.push({ caseId: e.caseId, requestId: pa.requestId, cardId: pa.cardId, kind: "orphan" });
          audit.append("unresolved_authorization_tombstone", { requestId: pa.requestId, cardId: pa.cardId }, e.caseId);
        }
      }
      if (restoredUnresolved.length)
        console.error(`WARNING: ${restoredUnresolved.length} unresolved authorization(s) restored without their case; the affected card ids must be reconciled at the provider before any reuse: ${restoredUnresolved.map((t) => `${t.cardId} (${t.requestId})`).join(", ")}. The purchase gate exists only while this process boots WITH the restore file - keep INTENTPAY_UNRESOLVED_RESTORE_FILE configured on every boot until every entry is resolved (docs/RECOVERY.md section 6.3).`);
    } catch (err) {
      // Fail closed like corrupt state: an unreadable restore file must not silently drop locks.
      stateCorrupted = true;
      console.error("unresolved-restore file unreadable - failing closed:", (err as Error).message);
    }
  }
  const persist = () => {
    if (!store) return;
    // JsonFileStore: atomic tmp+rename. SqliteStore: one transaction for the whole aggregate -
    // either every entity kind commits or none does; a crash mid-write leaves no torn state.
    store.save({ cases, usedNonces: verifier.snapshot(), notifications: outbox.list(), approverKey: { privateKeyPem: approverPrivateKeyPem, keyId: approverFp }, holderId: holderId ?? null });
  };
  const find = (id: string) => cases.find((c) => c.kase.id === id);

  // The live gateway's getTransaction is async; the simulator's is sync. Await both.
  const tryGet = async (id: string) => { try { return await gateway.getTransaction?.(id); } catch { return undefined; } };
  // Gateways may be sync (sim) or async (live) - await both, undefined on any failure.
  const tryCall = async <T>(fn: () => T | Promise<T>): Promise<T | undefined> => { try { return await fn(); } catch { return undefined; } };
  const checkContract = async(c:CaseState):Promise<string|null> => {
    if(!c.contractSource)return null;
    let error:string|undefined;
    try{if(!options.contractSource)throw Error("Contract source is not configured");const fresh=await options.contractSource.read(c.contractSource.id);if(fresh.version!==c.contractSource.version||c.sourceInvalidated)error="Contract source changed; explicitly refresh into a new review. Prior approval is blocked";}catch{error="Contract source could not be verified; spending is blocked";}
    if(error){c.sourceInvalidated=true;c.requiresReapproval=true;if(c.card&&c.card.status!=="CLOSED"){
      c.freezeState="pending";persist();try{const frozen=await gateway.freezeCard(c.card.id,`${c.card.id}:contract-stale`);if(frozen.status!=="FROZEN")throw Error("freeze unverified");c.card={...c.card,status:"FROZEN"};c.freezeState="verified";}catch{c.freezeState="unknown";}
    }c.log.push(error);audit.append("refused",{reason:error},c.kase.id);persist();return error;}return null;
  };
  const view = async (c: CaseState): Promise<CaseView> => {
    // Status is a fresh read, separate from saved issuance history. Never mutate provider
    // state or overwrite local workflow locks from a read-only case view.
    let currentCard = c.card;
    let cardStatusRead: CaseView["cardStatusRead"];
    if (c.card) {
      const checkedAt = now().toISOString();
      try {
        const status = await gateway.readCardStatus?.(c.card.id);
        if (status !== "ACTIVE" && status !== "FROZEN" && status !== "CLOSED") throw new Error("provider status unavailable or unrecognized");
        currentCard = { ...c.card, status };
        cardStatusRead = { state: "ok", checkedAt };
      } catch {
        cardStatusRead = { state: "unknown", checkedAt, error: "Current provider status unavailable. Saved status is not current evidence." };
      }
    }
    // Fetch each known transaction; on provider failure fall back to last-known evidence and
    // SAY SO. A silently empty list would look like "no transactions", which may be false.
    let ledgerError: string | undefined;
    const lastKnown = { ...(c.lastTransactions ?? {}) };
    const txns: CardTransaction[] = [];
    for (const id of c.transactionIds) {
      try {
        const t = await gateway.getTransaction?.(id);
        if (t) { lastKnown[id] = { txn: t, fetchedAt: now().toISOString() }; txns.push(t); continue; }
        throw new Error("not found");
      } catch (e) {
        ledgerError = (e as Error).message.slice(0, 200);
        const lk = c.lastTransactions?.[id];
        if (lk) txns.push(lk.txn); // stale but real; the ledger field says so
      }
    }
    c.lastTransactions = lastKnown;
    const knownTimes = Object.values(lastKnown).map((x) => x.fetchedAt).sort();
    const ledger: CaseView["ledger"] = !ledgerError ? { state: "ok" }
      : Object.keys(c.lastTransactions ?? {}).length ? { state: "degraded", lastKnownAt: knownTimes.at(-1), error: ledgerError }
      : { state: "unavailable", error: ledgerError };
    return {
    contractSource:c.contractSource,sourceInvalidated:c.sourceInvalidated,
    noticeProposal: c.noticeProposal,
    kase: c.kase,
    forecast: c.forecast,
    termsSource: c.kase.sourceNote ?? null,
    forecastSource: c.forecastSource ?? null,
    decision: c.kase.terms
      ? decide(c.kase.terms, { weeklyBalances: c.forecast.weeklyBalances, reserveFloor: c.forecast.reserveFloor, breachWeek: null }, DEFAULT_POLICY, now())
      : { cadence: "ESCALATE", reasons: ["terms not extracted yet"], savingsPct: null, annualBreachWeek: null, monthlyBreachWeek: null, reconsiderAt: null },
    intent: c.intent,
    intentHash: c.intent ? hashIntent(c.intent) : undefined,
    card: currentCard,
    cardStatusRead,
    transactions: txns,
    ledger,
    emailMode: options.emailTransport?.name ?? "preview",
    approverKeyId: approverFp,
    freezeState: c.freezeState,
    requiresReapproval: c.requiresReapproval,
    rejected: c.rejected,
    pendingAuthorization: c.pendingAuthorization,
    createCardUnresolved: c.createCardUnresolved,
    log: c.log,
  };
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const bad = (message: string, status: number) => json({ error: message }, status);

  // Route -> minimum role. Approver-only: review decisions (approve/reject) and promoting a
  // dry-run email to a real send. Everything else mutating: operator. Reads: viewer.
  const REQUIRED_ROLE: Record<string, Role> = {
    "POST /api/approve": "approver",
    "POST /api/notice-apply": "approver",
    "POST /api/agent-run": "operator",
    "POST /api/reconcile-card": "operator",
    "POST /api/reject": "approver",
    "POST /api/notifications/promote": "approver",
    "POST /api/resolve-restored": "approver"
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const allowed = typeof options.allowedOrigins === "function" ? options.allowedOrigins() : options.allowedOrigins;
    if (request.method === "POST") {
      const origin = request.headers.get("origin");
      // CSRF: with cookie auth a mutating request MUST present an allowed Origin - browsers
      // always send Origin on fetch/form POSTs, and SameSite=Lax already withholds the cookie
      // cross-site, so a missing/foreign Origin here is not a legitimate browser mutation.
      // (JSON content-type + zod are further barriers for classic form posts.)
      if (options.auth && (!origin || (allowed && !allowed.includes(origin)))) { audit.append("refused", { reason: "POST without an allowed Origin under cookie auth (CSRF guard)", origin: origin ?? "absent" }); return bad("origin required", 403); }
      if (!options.auth && allowed && origin && !allowed.includes(origin)) { audit.append("refused", { reason: "origin not allowed", origin }); return bad("origin not allowed", 403); }
    }
    let identity: Identity | null = null;
    if (options.auth) {
      identity = options.auth.authenticate(request);
      if (!identity) { audit.append("refused", { reason: "unauthenticated request", path: url.pathname }); return bad("authentication required", 401); }
      // /api/whoami stays reachable for the unenrolled: it exposes only their own identity so the
      // page can say "not enrolled" instead of failing opaquely. Everything else denies.
      if (!identity.role && url.pathname !== "/api/whoami") { audit.append("refused", { reason: "authenticated but not enrolled (deny-by-default)", sub: identity.sub }); return bad("your sign-in is not enrolled on this console - ask an administrator", 403); }
      if (!identity.role) return json({ identity: { sub: identity.sub, email: identity.email, name: identity.name, role: null, provider: identity.provider }, mode: "oidc" });
      const role: Role = identity.role;
      const need = REQUIRED_ROLE[`${request.method} ${url.pathname}`] ?? (request.method === "POST" ? "operator" : "viewer");
      if (ROLE_RANK[role] < ROLE_RANK[need]) { audit.append("refused", { reason: `role ${role} cannot ${request.method} ${url.pathname} (needs ${need})`, sub: identity.sub }); return bad(`role ${role} is not allowed to do that (needs ${need})`, 403); }
    } else if (request.method === "POST") {
      // Demo-only path: per-run random token delivered in the page's meta tag. Not production auth.
      if (options.sessionToken && request.headers.get("x-console-token") !== options.sessionToken) { audit.append("refused", { reason: "missing or wrong console token", path: url.pathname }); return bad("missing or wrong console token", 403); }
    }
    if (url.pathname === "/api/whoami" && request.method === "GET")
      return json({ identity: identity ? { sub: identity.sub, email: identity.email, name: identity.name, role: identity.role, provider: identity.provider } : null, mode: options.auth ? "oidc" : "demo-token" });
    if (url.pathname === "/api/cases" && request.method === "GET") {
      // The audit trail carries operational detail and other users' identities: viewers get
      // cases without it (review F6). Demo mode (no auth) is single-operator and keeps it.
      const auditForCaller = options.auth && identity?.role === "viewer" ? [] : audit.list();
      return json({ cases: await Promise.all(cases.map(view)), audit: auditForCaller, notifications: outbox.list(), live: options.live === true, stateCorrupted: stateCorrupted || undefined, restoredUnresolved: restoredUnresolved.length ? restoredUnresolved : undefined });
    }
    if (stateCorrupted && request.method === "POST" && url.pathname !== "/api/reset-demo") {
      return json({ error: "Persisted state is unreadable; refusing all changes (fail-closed). An operator must restore or remove the state file.", code: "state_corrupted" }, 409);
    }
    if (stateCorrupted && url.pathname === "/api/reset-demo") {
      // Reset is the sanctioned recovery: it drops all state, including any locks the corrupt file held.
      stateCorrupted = false;
      audit.append("state_corruption_reset", {});
    }
    // Orphan gate (round-8 A): preserved unresolved authorizations whose case did not survive
    // (or that conflicted with a live lock) cannot be enforced case-locally, so every
    // new-purchase path is refused until an operator resolves each one with provider evidence.
    // Deliberately global and fail-closed: a same-vendor case is NOT the same purchase, and a
    // silently allowed fresh purchase could duplicate an attempt the provider committed.
    if (restoredUnresolved.length && request.method === "POST" && ["/api/approve", "/api/agent-run", "/api/create-card", "/api/simulate", "/api/change-terms"].includes(url.pathname)) {
      audit.append("refused", { reason: "orphan unresolved authorization gate", orphans: restoredUnresolved.map((o) => o.requestId) });
      return json({ error: `${restoredUnresolved.length} preserved unresolved authorization(s) have no surviving case to enforce them; new purchases are refused until each is resolved by an operator with provider evidence (POST /api/resolve-restored).`, code: "orphan_authorization_unresolved", orphans: restoredUnresolved }, 409);
    }
    if (url.pathname === "/api/reset-demo" && request.method === "POST") {
      if (options.live) { audit.append("refused", { reason: "demo reset is simulator-only on a live-backed console" }); return bad("demo reset is only available in the local simulator; on the live sandbox it would erase real evidence and unresolved locks", 409); }
      gateway = (options.makeGateway ?? makeSim)(); holderId = undefined; cases = options.seedCases && options.seedCases.length === 0 ? [] : demoCases(); outbox = new Outbox(now, options.live ? "Airwallex sandbox simulation" : "Local simulator"); restoredUnresolved.length = 0; persist(); audit.append("reset", {});
      return json({ cases: cases.map(view) });
    }
    if (url.pathname === "/api/resolve-restored" && request.method === "POST") {
      const parsed = ResolveRestoredBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid resolve request: caseId, requestId, resolution and an evidence attestation (min 8 chars) are required", 400);
      if (!options.operatorToken) { audit.append("refused", { reason: "orphan resolution unavailable: no operator token configured" }); return bad("orphan resolution unavailable: INTENTPAY_OPERATOR_TOKEN is not configured", 403); }
      if (parsed.data.operatorToken !== options.operatorToken) { audit.append("refused", { reason: "wrong operator token for orphan resolution" }); return bad("wrong operator token", 403); }
      const idx = restoredUnresolved.findIndex((o) => o.caseId === parsed.data.caseId && o.requestId === parsed.data.requestId);
      if (idx === -1) return bad("no such restored unresolved authorization", 404);
      const [resolved] = restoredUnresolved.splice(idx, 1);
      audit.append("restored_orphan_resolved", { requestId: resolved.requestId, cardId: resolved.cardId, kind: resolved.kind, resolution: parsed.data.resolution, evidence: parsed.data.evidence }, resolved.caseId);
      // Not persisted by design: re-pointing a later boot at the same stale export re-raises the
      // orphan (fail-closed). The runbook has the operator retire the restore file once clear.
      return json({ resolved, remainingOrphans: restoredUnresolved });
    }
    if (url.pathname === "/api/notifications/promote" && request.method === "POST") {
      const parsed = PromoteBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid promote request", 400);
      if (!options.operatorToken) { audit.append("refused", { reason: "email promotion unavailable: no operator token configured" }); return bad("email promotion unavailable: INTENTPAY_OPERATOR_TOKEN is not configured", 403); }
      if (parsed.data.operatorToken !== options.operatorToken) { audit.append("refused", { reason: "wrong operator token for email promotion" }); return bad("wrong operator token", 403); }
      try {
        const notification = await dispatcher.promote(parsed.data.id, { operator: identity ? (identity.email ?? identity.sub) : "console-operator" });
        persist();
        return json({ notification });
      } catch (e) {
        audit.append("refused", { reason: `email promotion refused: ${(e as Error).message}` });
        return bad((e as Error).message, 409);
      }
    }
    if (url.pathname === "/api/approve" && request.method === "POST") {
      const parsed = ApproveBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid approval request", 400);
      const c = find(parsed.data.caseId);
      if (!c) return bad("case not found", 404);
      if (c) { const sourceError=await checkContract(c);if(sourceError)return bad(sourceError,409); }
      if (c.rejected) return bad("case is rejected; create a new case for a fresh review", 409);
      if (!c.kase.terms) return bad("terms not extracted: extraction must succeed before approval", 409);
      if (c.createCardUnresolved) return bad("card issuance outcome unresolved; reconcile via /api/reconcile-card before any new approval - a fresh approval could create a duplicate card", 409);
      if (c.freezeState === "unknown" || c.freezeState === "pending") return bad("freeze not verified; reconcile before approval", 409);
      if (c.card && c.card.status !== "CLOSED" && (c.card.status === "ACTIVE" || !c.requiresReapproval)) return bad("card already exists; change terms before re-approval", 409);
      const d = decide(c.kase.terms, { weeklyBalances: c.forecast.weeklyBalances, reserveFloor: c.forecast.reserveFloor, breachWeek: null }, DEFAULT_POLICY, now());
      if (d.cadence === "ESCALATE") { audit.append("refused", { reason: "policy escalated; a person must resolve before approval" }, c.kase.id); return bad("policy escalated this case; approve is not available", 409); }
      const cap = d.cadence === "annual" ? c.kase.terms.annualPrice! : c.kase.terms.monthlyPrice!;
      c.intent = mintIntent({ vendor: c.kase.vendor, cadence: d.cadence, amountCap: cap, currency: c.kase.terms.currency, categories: [c.kase.terms.category], terms: c.kase.terms, reconsiderAt: d.reconsiderAt });
      // With real auth, the approver of record is the authenticated identity, not a
      // console-global label or a client-supplied string.
      const approverLabel = identity ? (identity.email ?? identity.sub) : approver;
      const approval = issue(c.kase.id, c.intent, DEFAULT_POLICY.version, approverLabel, key, 60_000, now(), `Policy recommends ${d.cadence}: ${d.reasons.join("; ")}`,
        { privateKeyPem: approverPrivateKeyPem, keyId: approverFp });
      c.requiresReapproval = false;
      c.log.push(`Intent approved by ${approverLabel} (${identity ? "authenticated console sign-in" : `local demo approver key ${approverFp}`}): ${c.intent.cadence}, cap ${c.intent.amountCap} ${c.intent.currency}.`);
      audit.append("approval_issued", { cadence: c.intent.cadence, amountCap: c.intent.amountCap, currency: c.intent.currency, termsHash: c.intent.termsHash, nonce: approval.nonce, approverKeyId: approverFp, approver: approverLabel }, c.kase.id);
      await dispatcher.deliver(outbox.emit("approval_issued", { caseId: c.kase.id, vendor: c.kase.vendor, recipient, detail: { approver: approverLabel, cadence: c.intent.cadence, cap: c.intent.amountCap, currency: c.intent.currency, categories: c.intent.categories.join(", "), termsHash: c.intent.termsHash, cardState: !c.card ? "none" : c.card.status === "CLOSED" ? "closed" : "frozen" } }));
      persist();
      return json({ approval, case: await view(c) });
    }
    if (url.pathname === "/api/create-card" && request.method === "POST") {
      const parsed = CreateCardBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid create-card request", 400);
      const approval = parsed.data.approval as Approval;
      const c = find(approval.caseId);
      if (!c) return bad("case not found", 404);
      if (c) { const sourceError=await checkContract(c);if(sourceError)return bad(sourceError,409); }
      if (c.rejected) return bad("case is rejected; create a new case for a fresh review", 409);
      if (!c.intent) return bad("case not approved: approve before issuing a card", 409);
      if (c.createCardUnresolved) return bad("card issuance outcome unresolved; reconcile via /api/reconcile-card before any new issuance", 409);
      if (c.freezeState === "unknown" || c.freezeState === "pending") return bad("freeze not verified; reconcile before issue", 409);
      if (c.requiresReapproval || !c.kase.terms || hashTerms(c.kase.terms) !== c.intent.termsHash) return bad("terms changed; fresh approval required", 409);
      const refusal = verifier.check(approval, c.kase.id, c.intent, DEFAULT_POLICY.version, now());
      if (refusal) { audit.append("refused", { reason: refusal, nonce: approval.nonce }, c.kase.id); return bad(refusal, 409); }
      if (c.card?.status === "ACTIVE") return bad("active card already exists", 409);
      // Consume BEFORE the gateway call: if the call errors after an ambiguous remote commit, a blind retry must not double-create.
      verifier.consume(approval);
      persist(); // the consumed nonce must survive a restart, or the approval could be replayed
      try {
        // One request id per logical action: the nonce alone would alias cardholder and card creation to the same idempotent slot.
        if (!holderId) {
          const hr = await gateway.createCardholder({ name: "Sandi Samantaray", email: "sandi@vyayasan.com" }, `${approval.nonce}:cardholder`);
          // Round-4 N5: a failed provider lookup is unknown, not absence - the gateway made no
          // create attempt, so lock the case as cardholder-ambiguous instead of proceeding.
          if (hr.state === "unknown") throw new Error(`cardholder lookup failed at the provider (an error is not proof of absence): ${hr.error}`);
          holderId = hr.cardholder.id;
          persist(); // the cardholder id must survive a crash BEFORE card creation (round-3 N2)
        }
        const controls = cardPayload(c.intent);
        c.card = await gateway.createCard({ cardholderId: holderId, controls }, `${approval.nonce}:card`);
        // DRILL-ONLY: crash with the card committed remotely but NOT persisted locally.
        if (options.drillCrashAt === "after-card-create") process.kill(process.pid, "SIGKILL");
        c.freezeState = undefined;
        c.log.push(`Card ${c.card.id} created: limit ${controls.amountLimit} ${c.intent.currency} per transaction, currencies ${controls.currencyAllowlist.join("/")}, categories ${controls.merchantCategories.join("/")}.`);
        audit.append("card_created", { cardId: c.card.id, controls, nonce: approval.nonce }, c.kase.id);
        await dispatcher.deliver(outbox.emit("card_created", { caseId: c.kase.id, vendor: c.kase.vendor, recipient, detail: { limit: controls.amountLimit, currencies: controls.currencyAllowlist.join("/"), categories: controls.merchantCategories.join("/") } }));
        persist();
        return json({ card: c.card, case: await view(c) });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "card creation failed";
        // Lock issuance: the provider may have committed a card (or cardholder) we cannot see.
        // Enforcement, not a runbook: approve and create-card refuse while this stands, and only
        // a provider card listing (/api/reconcile-card) can clear it. Persisted, so the lock
        // survives a restart exactly like the authorization lock.
        c.createCardUnresolved = { nonce: approval.nonce, at: now().toISOString(), error: msg, cardholderId: holderId };
        audit.append("outcome_unknown", { error: msg, nonce: approval.nonce, locked: "card_issuance" }, c.kase.id);
        persist();
        return bad(`outcome unknown, reconcile before retrying: ${msg}`, 409);
      }
    }
    if (url.pathname === "/api/reconcile-card" && request.method === "POST") {
      const parsed = ReconcileCardBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid reconcile-card request", 400);
      const c = find(parsed.data.caseId);
      if (!c) return bad("case not found", 404);
      if (!c.createCardUnresolved) return bad("no unresolved card issuance on this case", 409);
      if (typeof gateway.listCards !== "function") {
        // No verified recovery route: live issuance stays disabled for this case (parent rule:
        // safety enforced or live operation disabled until recovery provable).
        return bad("this gateway cannot list provider cards, so card-issuance recovery is not provable here - issuance stays disabled for this case", 501);
      }
      // Cardholder resolution (round-3 N2): recorded id, in-memory id, then a provider-verified
      // lookup by the console cardholder's email - so a crash during cardholder CREATION is not
      // a dead-end. A gateway without lookup and no recorded id stays locked.
      let holder = c.createCardUnresolved.cardholderId ?? holderId;
      let holderVerifiedAbsent = false;
      let holderLookupUnknown = false;
      if (!holder && typeof gateway.findCardholderByEmail === "function") {
        // Round-4 N5: tri-state. A provider error (or a throwing gateway) is "unknown" and keeps
        // the lock; ONLY a successful empty listing counts as verified absence.
        const res = await tryCall(() => gateway.findCardholderByEmail!("sandi@vyayasan.com"));
        if (res?.state === "found") { holder = res.cardholder.id; holderId = holder; persist(); }
        else if (res?.state === "absent") holderVerifiedAbsent = true;
        else holderLookupUnknown = true;
      }
      if (!holder && !holderVerifiedAbsent) return bad(holderLookupUnknown
        ? "cardholder lookup failed at the provider (an error is not proof of absence) - issuance stays locked; retry when the provider recovers"
        : "cardholder id unknown locally (cardholder creation itself was ambiguous) and this gateway cannot look it up - issuance stays disabled for this case", 409);

      // Full listing: live gateway paginates internally and fails closed on overflow. A listing
      // READ failure keeps the lock (502); an empty listing is read TWICE before any unlock
      // (round-3 N3): provider visibility can lag.
      const listRemote = async (): Promise<Card[] | undefined> => {
        if (holderVerifiedAbsent) return []; // no cardholder at the provider => no cards can exist
        try { return await gateway.listCards(holder!); } catch { return undefined; }
      };
      const remote = await listRemote();
      if (remote === undefined) {
        audit.append("reconcile_card_failed", { error: "provider card listing failed" }, c.kase.id);
        return bad("provider card listing failed - issuance stays locked", 502);
      }
      if (parsed.data.decision === "check") return json({ remoteCards: remote, cardholderId: holder ?? null, note: holderVerifiedAbsent ? "no cardholder at the provider; card adoption is impossible - attest none-created after verifying" : undefined });

      if (parsed.data.decision === "none-created") {
        // Round-4 N3 residual: two immediate reads cannot establish a consistency window. Unless
        // the provider documents read-after-write consistency for its listing, an empty listing is
        // not authoritative proof of absence and this unlock stays disabled (use adopt/freeze-stray).
        if (gateway.supportsAuthoritativeAbsence !== true) return bad("this provider documents no read-after-write consistency guarantee for card listings, so an empty listing is not authoritative - 'none-created' is disabled here; resolve via adopt (verify controls) or freeze-stray against the actual provider card", 409);
        // Operator attestation is mandatory (round-3 N3): a click is not evidence. The provider
        // listing must be empty on TWO consecutive reads.
        const attestation = (parsed.data.attestation ?? "").trim();
        if (attestation.length < 8) return bad("none-created requires an attestation note (min 8 chars): state what you verified at the provider before unlocking", 409);
        if (remote.length > 0) return bad(`provider shows ${remote.length} card(s) for this cardholder - cannot attest none-created; adopt or freeze-stray the real card instead`, 409);
        const reread = await listRemote();
        if (reread === undefined) return bad("provider re-read failed - issuance stays locked", 502);
        if (reread.length > 0) return bad("the provider listing changed between reads - a card appeared; resolve the real card instead of attesting", 409);
        delete c.createCardUnresolved;
        c.log.push(`Operator attestation: no card was created (${attestation.slice(0, 200)}). Issuance unlocked - a fresh approval is required.`);
        audit.append("card_issuance_reconciled", { decision: "none-created", providerCardCount: 0, attestation: attestation.slice(0, 200) }, c.kase.id);
        persist();
        return json({ case: await view(c) });
      }

      // adopt / freeze-stray: the named card must be present in THIS cardholder's listing.
      const found = remote.find((r) => r.id === parsed.data.cardId);
      if (!found) return bad("cardId is not in the provider listing for this cardholder", 409);

      if (parsed.data.decision === "freeze-stray") {
        // A stray card whose controls cannot be brought in line must NOT be adopted: freeze it
        // at the provider, verify the freeze by re-listing, then unlock for a fresh approval.
        const frozen = await tryCall(() => gateway.freezeCard(found.id));
        if (!frozen) return bad("provider freeze failed - the stray card may still be spendable; lock stands", 502);
        const reread = await listRemote();
        const after = reread?.find((r) => r.id === found.id);
        if (!after || after.status === "ACTIVE") return bad("freeze not confirmed by a fresh provider listing - lock stands", 409);
        delete c.createCardUnresolved;
        c.log.push(`Stray card ${found.id} frozen at the provider after an ambiguous issuance. Issuance unlocked - a fresh approval is required.`);
        audit.append("card_issuance_reconciled", { decision: "freeze-stray", cardId: found.id }, c.kase.id);
        persist();
        return json({ case: await view(c) });
      }

      // adopt: NEVER overlay local assumptions (round-3 N1). The provider card's ACTUAL controls
      // must provably equal the approved intent's payload - verified by read-back, or corrected
      // provider-side and then verified. Otherwise refuse: freeze-stray + fresh approval.
      if (!c.intent) return bad("case has no approved intent; cannot adopt", 409);
      const controls = cardPayload(c.intent);
      const norm = (k: CardControls) => JSON.stringify({ amountLimit: k.amountLimit, currencyAllowlist: [...k.currencyAllowlist].sort(), merchantCategories: [...k.merchantCategories].sort() });
      const want = norm(controls);
      let providerControls = typeof gateway.readCardControls === "function" ? await tryCall(() => gateway.readCardControls!(found.id)) : undefined;
      if (!providerControls || norm(providerControls) !== want) {
        if (typeof gateway.setCardControls !== "function")
          return bad("provider card controls differ from the approved intent (or are unreadable) and this gateway cannot correct them - use freeze-stray and approve again", 409);
        await tryCall(() => gateway.setCardControls!(found.id, controls));
        providerControls = typeof gateway.readCardControls === "function" ? await tryCall(() => gateway.readCardControls!(found.id)) : undefined;
        if (!providerControls || norm(providerControls) !== want)
          return bad("could not bring the provider card in line with the approved intent (read-back mismatch) - use freeze-stray and approve again", 409);
      }
      c.card = { ...found, controls }; // provider-verified identical to the intent payload
      delete c.createCardUnresolved;
      c.freezeState = undefined;
      c.log.push(`Card ${found.id} adopted after provider controls verified against the approved intent.`);
      audit.append("card_issuance_reconciled", { decision: "adopt", cardId: found.id, controlsVerified: true }, c.kase.id);
      persist();
      return json({ card: c.card, case: await view(c) });
    }
    if (url.pathname === "/api/simulate" && request.method === "POST") {
      const parsed = SimulateBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid simulate request", 400);
      const c = find(parsed.data.caseId);
      if (c) { const sourceError=await checkContract(c);if(sourceError)return bad(sourceError,409); }
      if (c?.rejected) return bad("case is rejected; create a new case for a fresh review", 409);
      if (!c?.card || !c.intent) return bad("create the card first", 409);
      const base = { merchant: c.kase.vendor, category: c.intent.categories[0], currency: c.intent.currency };
      const auth = parsed.data.kind === "in-policy" ? { ...base, amount: c.intent.amountCap }
        : parsed.data.kind === "over-cap" ? { ...base, amount: c.intent.amountCap + 1 }
        : parsed.data.kind === "wrong-currency" ? { ...base, amount: c.intent.amountCap, currency: c.intent.currency === "EUR" ? "USD" : "EUR" }
        : { ...base, amount: c.intent.amountCap, category: c.intent.categories.includes("travel") ? "software" : "travel" };
      // An unresolved authorization locks the card against purchase retries.
      if (c.pendingAuthorization && !c.pendingAuthorization.reconciledAt) {
        return json({ error: "A previous authorization's outcome is unresolved. Reconcile the card's transactions before retrying - a blind retry could duplicate a purchase.", code: "authorization_unresolved", pendingAuthorization: c.pendingAuthorization }, 409);
      }
      // Retry of a reconciled no-match reuses the SAME request id: the provider's idempotency
      // deduplicates if the original attempt did commit after all. A different purchase kind is a
      // new logical action and gets a fresh request id.
      const requestId = c.pendingAuthorization?.reconciledAt && c.pendingAuthorization.kind === parsed.data.kind
        ? c.pendingAuthorization.requestId
        : `${c.kase.id}:${parsed.data.kind}:${c.transactionIds.length}`;
      const attempt: PendingAuthorization = { requestId, kind: parsed.data.kind, cardId: c.card.id, amount: auth.amount, currency: auth.currency, merchant: auth.merchant, startedAt: now().toISOString() };
      c.pendingAuthorization = attempt;
      audit.append("authorization_attempt", { requestId, kind: parsed.data.kind, amount: auth.amount, currency: auth.currency, merchant: auth.merchant }, c.kase.id);
      persist(); // the lock must exist on disk BEFORE the gateway call
      // Gateway outages (sandbox simulator down, network) surface as a structured 502,
      // not an uncaught exception that kills the console handler.
      let t;
      try {
        t = await gateway.authorize(c.card.id, auth, requestId);
      } catch (e) {
        // ANY thrown error - HTTP 4xx/5xx, transport, timeout - leaves the outcome UNKNOWN.
        // An HTTP status is not a definitive rejection: the request may have committed before the
        // error surfaced. Only a documented decline payload (handled below, status FAILED) is a
        // rejection. Never claim no transaction was recorded; require reconciliation first.
        const status = (e as { status?: unknown }).status;
        attempt.lastError = (e as Error).message.slice(0, 200);
        const detail = typeof status === "number" ? `gateway error HTTP ${status}` : "the gateway did not confirm a response";
        c.log.push(`Authorization outcome unknown (${detail}: ${(e as Error).message}). Reconcile the card's transactions before retrying.`);
        audit.append("authorization_outcome_unknown", { requestId, httpStatus: typeof status === "number" ? status : undefined, error: (e as Error).message.slice(0, 200) }, c.kase.id);
        await dispatcher.deliver(outbox.emit("gateway_outage", { caseId: c.kase.id, vendor: c.kase.vendor, recipient, detail: { error: (e as Error).message.slice(0, 200) } }));
        persist();
        return json({ error: `The authorization outcome is unknown - ${detail}. Reconcile the card's transactions before retrying to avoid a duplicate.`, code: "authorization_outcome_unknown", requestId }, 502);
      }
      // DRILL-ONLY: crash with the authorization committed remotely but NOT persisted locally
      // (the lock WAS persisted before the call - recovery must find it unreconciled).
      if (options.drillCrashAt === "after-authorize") process.kill(process.pid, "SIGKILL");
      attempt.transactionId = t.id;
      c.transactionIds.push(t.id);
      let transaction = t;
      if (t.status === "PENDING") {
        let cleared;
        try {
          cleared = await gateway.capture(t.id, `${t.id}:capture`);
        } catch (e) {
          attempt.lastError = (e as Error).message.slice(0, 200);
          c.log.push(`Capture of authorization ${t.id} could not be confirmed: ${(e as Error).message}. Outcome unknown; reconcile before retrying.`);
          audit.append("capture_outcome_unknown", { requestId, transactionId: t.id, error: (e as Error).message.slice(0, 200) }, c.kase.id);
          persist();
          return json({ error: "The authorization exists but its capture could not be confirmed. Reconcile before retrying.", code: "capture_outcome_unknown", transactionId: t.id, requestId }, 502);
        }
        // The capture response is the cleared truth; the list lookup is only a fallback.
        // Round-5 fix: "cleared" requires a CONFIRMED CLEARING state. A capture that answers
        // PENDING, or a PENDING capture plus a failed/absent lookup, is NEITHER cleared NOR
        // declined - it stays locked and unresolved, and no purchase_cleared email may fire.
        const lookedUp = cleared.status === "PENDING" ? await tryGet(t.id) : undefined;
        const final = lookedUp ?? cleared;
        transaction = final;
        if (final.status === "CLEARING") {
          c.pendingAuthorization = undefined;
          c.log.push(`Authorization ${t.id} cleared: ${Math.abs(final.amount)} ${final.currency} at ${final.merchant ?? "not reported"}.`);
          audit.append("authorization_cleared", { transactionId: t.id, amount: Math.abs(final.amount), currency: final.currency, providerMerchant: final.merchant }, c.kase.id);
          await dispatcher.deliver(outbox.emit("purchase_cleared", { caseId: c.kase.id, vendor: c.kase.vendor, recipient, detail: { amount: Math.abs(final.amount), currency: final.currency, cap: c.intent.amountCap, providerMerchant: final.merchant ?? "not reported" } }));
          persist();
        } else if (final.status === "FAILED") {
          // A documented failure payload at capture is a definitive decline.
          c.pendingAuthorization = undefined;
          c.log.push(`Authorization declined by the issuing gateway (${final.failureReason ?? "declined"}); the card enforced the approved intent.`);
          audit.append("authorization_declined", { transactionId: t.id, reason: final.failureReason, amount: t.amount }, c.kase.id);
          await dispatcher.deliver(outbox.emit("purchase_declined", { caseId: c.kase.id, vendor: c.kase.vendor, recipient, detail: { amount: t.amount, currency: t.currency, reason: final.failureReason ?? "declined", providerMerchant: final.merchant ?? "not reported" } }));
          persist();
        } else {
          // PENDING (or an unexpected status, or the lookup failed): outcome unconfirmed.
          // Keep the authorization lock; the reconcile flow owns resolution. No email kind
          // exists for this state on purpose - a "pending" email would be a new claim surface.
          const why = lookedUp === undefined && cleared.status === "PENDING"
            ? "the capture stayed PENDING and the status lookup failed"
            : `status is ${final.status}`;
          attempt.lastError = `capture unconfirmed: ${why}`;
          c.log.push(`Authorization ${t.id} is not final: ${why}. Neither cleared nor declined - reconcile the card's transactions before concluding anything.`);
          audit.append("capture_unconfirmed", { requestId, transactionId: t.id, status: final.status, lookupFailed: lookedUp === undefined && cleared.status === "PENDING" }, c.kase.id);
          persist();
          return json({ error: `The authorization is not final - ${why}. It is neither cleared nor declined; reconcile the card's transactions before retrying.`, code: "capture_unconfirmed", transactionId: t.id, requestId }, 409);
        }
      } else if (t.status === "CLEARING") {
        // Authorization came back already cleared (no capture step): same cleared truth as above.
        c.pendingAuthorization = undefined;
        c.log.push(`Authorization ${t.id} cleared: ${Math.abs(t.amount)} ${t.currency} at ${t.merchant ?? "not reported"}.`);
        audit.append("authorization_cleared", { transactionId: t.id, amount: Math.abs(t.amount), currency: t.currency, providerMerchant: t.merchant }, c.kase.id);
        await dispatcher.deliver(outbox.emit("purchase_cleared", { caseId: c.kase.id, vendor: c.kase.vendor, recipient, detail: { amount: t.amount, currency: t.currency, cap: c.intent.amountCap, providerMerchant: t.merchant ?? "not reported" } }));
        persist();
      } else if (t.status !== "FAILED") {
        // Hardening: only a documented FAILED payload is a rejection. Any other status here
        // (not PENDING, not FAILED) is neither cleared nor declined: lock stays, reconcile.
        attempt.lastError = `authorization status unexpected: ${t.status}`;
        c.log.push(`Authorization ${t.id} returned status ${t.status}: neither a documented decline nor a capturable authorization. Outcome unconfirmed - reconcile the card's transactions before retrying.`);
        audit.append("capture_unconfirmed", { requestId, transactionId: t.id, status: t.status }, c.kase.id);
        persist();
        return json({ error: `The authorization is not final - status is ${t.status}. It is neither cleared nor declined; reconcile the card's transactions before retrying.`, code: "capture_unconfirmed", transactionId: t.id, requestId }, 409);
      } else {
        // A decline payload in a successful response is the ONLY definitive rejection: the gateway
        // recorded and refused the authorization. No funds were authorized.
        c.pendingAuthorization = undefined;
        c.log.push(`Authorization declined by the issuing gateway (${t.failureReason}); the card enforced the approved intent.`);
        audit.append("authorization_declined", { transactionId: t.id, reason: t.failureReason, amount: t.amount }, c.kase.id);
        await dispatcher.deliver(outbox.emit("purchase_declined", { caseId: c.kase.id, vendor: c.kase.vendor, recipient, detail: { amount: t.amount, currency: t.currency, reason: t.failureReason ?? "declined", providerMerchant: t.merchant ?? "not reported" } }));
        persist();
      }
      return json({ transaction, case: await view(c) });
    }
    if (url.pathname === "/api/reconcile" && request.method === "POST") {
      const parsed = ReconcileBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid reconcile request", 400);
      const c = find(parsed.data.caseId);
      if (!c?.pendingAuthorization) return bad("no unresolved authorization to reconcile", 409);
      const p = c.pendingAuthorization;
      // Manual operator attestation: the person checked the provider dashboard themselves.
      // Required because this endpoint carries no documented idempotency guarantee.
      // A LOCAL operator attestation: the person reviewed the situation (e.g. the provider
      // dashboard) and takes responsibility. It is not proof of provider finality, and the
      // console's session token is a demo gate, not production authentication.
      if (parsed.data.manualConfirm) {
        p.reconciledAt = now().toISOString();
        p.manualConfirm = parsed.data.manualConfirm;
        if (p.probableMatch) {
          // Reviewed resolution of a probable match: adopt the reviewed transaction, unlock.
          if (!c.transactionIds.includes(p.probableMatch.transactionId)) c.transactionIds.push(p.probableMatch.transactionId);
          audit.append("reconciliation_probable_confirmed", { requestId: p.requestId, transactionId: p.probableMatch.transactionId, attestation: parsed.data.manualConfirm }, c.kase.id);
          c.log.push(`Operator reviewed the probable match ${p.probableMatch.transactionId} at ${p.reconciledAt}: ${parsed.data.manualConfirm}. Adopted; lock cleared.`);
          c.pendingAuthorization = undefined;
        } else {
          audit.append("reconciliation_manual_confirm", { requestId: p.requestId, attestation: parsed.data.manualConfirm }, c.kase.id);
          c.log.push(`Manually confirmed by a local operator at ${p.reconciledAt}: ${parsed.data.manualConfirm}. Retry unlocked; it reuses the original request id.`);
        }
        persist();
        return json({ outcome: "manual_confirm", case: await view(c) });
      }
      let ledger: CardTransaction[];
      try {
        ledger = await gateway.listTransactions(c.card?.id);
      } catch (e) {
        audit.append("reconciliation_failed", { requestId: p.requestId, error: (e as Error).message.slice(0, 200) }, c.kase.id);
        return json({ error: "Reconciliation could not read the gateway transaction ledger. Try again before retrying the purchase.", code: "reconciliation_failed" }, 502);
      }
      // Exact id match when the authorization was confirmed; otherwise a bounded heuristic:
      // same card, amount, currency, merchant, and a network-reported time inside the attempt
      // window. A ledger row without a timestamp can never auto-match. Heuristic adoption is
      // recorded as probable, never definitive.
      let match: CardTransaction | undefined;
      let basis: string;
      if (p.transactionId) {
        match = ledger.find((t) => t.id === p.transactionId);
        basis = "transaction_id";
      } else {
        const started = Date.parse(p.startedAt);
        const windowEnd = now().getTime();
        const candidates = ledger.filter((t) =>
          t.cardId === p.cardId && t.amount === p.amount && t.currency === p.currency && (t.merchant ?? "") === p.merchant &&
          t.transactedAt !== undefined && Date.parse(t.transactedAt) >= started - 5 * 60_000 && Date.parse(t.transactedAt) <= windowEnd + 5 * 60_000);
        if (candidates.length > 1) {
          audit.append("reconciliation_ambiguous", { requestId: p.requestId, candidates: candidates.map((t) => t.id) }, c.kase.id);
          return json({ error: `Reconciliation found ${candidates.length} ledger transactions matching the attempt's card, amount, currency, merchant and time window. A person must resolve which one is this attempt before any retry.`, code: "reconciliation_ambiguous", candidates: candidates.map((t) => t.id) }, 409);
        }
        match = candidates[0];
        basis = "card_amount_currency_merchant_time";
      }
      if (match) {
        if (basis === "transaction_id") {
          // Definitive: the authorization was confirmed before the failure, and the ledger names it.
          if (!c.transactionIds.includes(match.id)) c.transactionIds.push(match.id);
          c.pendingAuthorization = undefined;
          c.log.push(`Reconciled: the attempt exists in the gateway ledger as ${match.id} (${match.status}). Recorded; no retry needed.`);
          audit.append("reconciliation_matched", { requestId: p.requestId, transactionId: match.id, status: match.status, basis, definitive: true }, c.kase.id);
          persist();
          return json({ outcome: "matched", transaction: match, definitive: true, case: await view(c) });
        }
        // Probable only: record the candidate and KEEP THE LOCK. It can be an unrelated payment
        // that happens to match; spending stays blocked until an operator reviews it (or a later
        // reconcile finds a definitive id).
        p.probableMatch = { transactionId: match.id, status: match.status, basis, foundAt: now().toISOString() };
        c.log.push(`Reconcile found a PROBABLE match ${match.id} (${match.status}) on card, amount, currency, merchant and time window - heuristic only. The lock stays until an operator reviews it.`);
        audit.append("reconciliation_probable_match", { requestId: p.requestId, transactionId: match.id, status: match.status, basis, definitive: false }, c.kase.id);
        persist();
        return json({ outcome: "probable_match", transaction: match, definitive: false, case: await view(c) });
      }
      // No match: the lock STAYS. Ledger visibility can lag, and this endpoint documents no
      // idempotency guarantee, so only an operator's manual confirmation unlocks the retry.
      audit.append("reconciliation_no_match", { requestId: p.requestId, checkedAt: now().toISOString() }, c.kase.id);
      c.log.push(`Reconcile checked the ledger at ${now().toISOString()}: no matching transaction. The lock stays - ledger visibility can lag and this endpoint has no documented idempotency guarantee. Re-check later, or confirm manually after checking the provider dashboard.`);
      persist();
      return json({ outcome: "no_match", case: await view(c) });
    }
    if (url.pathname === "/api/notice-propose" && request.method === "POST") {
      const parsed = NoticeBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("Invalid notice upload", 400);
      const c = find(parsed.data.caseId);
      if(c?.contractSource)return bad("Contract-bound cases require explicit Salesforce refresh into a new review",409);
      if (!c?.kase.terms || !c.intent || c.requiresReapproval) return bad("Select a currently approved deal before comparing a notice", 409);
      if (c.pendingAuthorization || c.createCardUnresolved || c.freezeState === "unknown" || c.freezeState === "pending") return bad("Reconcile unresolved outcomes first", 409);
      if (!options.planner) return bad("No model configured; notice analysis is unavailable", 501);
      let notice: ReturnType<typeof parseNotice>;
      try { notice = parseNotice(parsed.data.filename, parsed.data.content); } catch(e) { return bad((e as Error).message, 400); }
      // Mention is a conservative matching guard, NOT authenticated vendor identity.
      if (!notice.text.toLowerCase().includes(c.kase.vendor.toLowerCase())) return bad("Notice does not name this case vendor. Match it manually before analysis; no change made", 409);
      const version = noticeVersion(c);
      const tempCase = { ...c.kase, rawTerms: notice.text, terms: undefined, sourceNote: "untrusted uploaded notice" };
      const plan = await options.planner(tempCase, c.forecast);
      const terms = plan.proposal?.extracted_terms;
      const decision = terms ? decide(terms, { ...c.forecast, breachWeek: null }, DEFAULT_POLICY, now()) : undefined;
      c.noticeProposal = makeNoticeProposal(version, notice.source, notice.text, c.kase.terms, plan, decision, now());
      // Read-only proposal: never changes approval, terms, card or outbox.
      audit.append("notice_proposed", { proposalId: c.noticeProposal.id, sha256: notice.source.sha256, status: c.noticeProposal.status }, c.kase.id);
      persist();
      return json({ proposal: c.noticeProposal, case: await view(c) });
    }
    if (url.pathname === "/api/notice-apply" && request.method === "POST") {
      const parsed = NoticeApplyBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("Explicit review confirmation and proposal id required", 400);
      const c = find(parsed.data.caseId), p = c?.noticeProposal;
      if (!c || !p || p.id !== parsed.data.proposalId) return bad("No matching staged proposal", 409);
      if (p.status !== "review" || !p.terms || noticeVersion(c) !== p.baseVersion || now().getTime() >= Date.parse(p.expiresAt)) return bad("Proposal is blocked, consumed, expired or stale; analyse the current notice again", 409);
      if (restoredUnresolved.length || c.pendingAuthorization || c.createCardUnresolved || c.freezeState === "unknown" || c.freezeState === "pending") return bad("Reconcile unresolved outcomes before applying", 409);
      // Persist a consumed/in-flight marker BEFORE the existing mutation path. A lost response
      // or crash never makes this proposal replayable. No approval or purchase is issued here.
      p.status = "applying"; c.requiresReapproval = true;
      if (c.card && c.card.status !== "CLOSED") c.freezeState = "pending";
      persist();
      audit.append("notice_apply_reviewed", { proposalId: p.id, sha256: p.source.sha256, reviewer: identity?.sub ?? "demo-reviewer" }, c.kase.id);
      const result = await handle(new Request(new URL("/api/change-terms", request.url), { method: "POST", headers: request.headers, body: JSON.stringify({ caseId: c.kase.id, terms: p.terms, rawTerms: p.rawTerms }) }));
      p.status = result.ok ? "applied" : "blocked";
      if (result.ok) c.kase.sourceNote = `Reviewed uploaded notice ${p.source.filename}; sender unverified; sha256 ${p.source.sha256}`;
      persist();
      return result;
    }
    if (url.pathname === "/api/change-terms" && request.method === "POST") {
      const parsed = ChangeTermsBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid terms change", 400);
      const c = find(parsed.data.caseId);
      if(c?.contractSource)return bad("Contract-bound cases require explicit Salesforce refresh into a new review",409);
      if (!c) return bad("case not found", 404);
      if (c.pendingAuthorization) { audit.append("refused", { reason: "terms change refused while an authorization outcome is unresolved", requestId: c.pendingAuthorization.requestId }, c.kase.id); return bad("an authorization outcome is unresolved; reconcile it before changing terms", 409); }
      const oldHash = c.kase.terms ? hashTerms(c.kase.terms) : undefined;
      const newHash = hashTerms(parsed.data.terms);
      if (oldHash === newHash && c.kase.rawTerms === parsed.data.rawTerms) return json({ case: await view(c) });
      // Retain the old intent only to test a purchase against the frozen old card.
      c.requiresReapproval = true;
      if (c.card && c.card.status === "CLOSED") {
        // A closed card is terminal: it already cannot authorize, which is the whole purpose of
        // the terms-change freeze. Never write to a terminal provider resource (and never assume
        // how a provider reacts to freezing a closed card).
        c.freezeState = "verified";
      } else if (c.card) {
        c.freezeState = "pending";
        try {
          const frozen = await gateway.freezeCard(c.card.id, `${c.card.id}:terms:${newHash}`);
          if (frozen.status !== "FROZEN") throw new Error("freeze not confirmed");
          c.card = { ...c.card, status: "FROZEN" };
          c.freezeState = "verified";
        } catch {
          c.freezeState = "unknown";
          c.requiresReapproval = true;
          audit.append("outcome_unknown", { cardId: c.card.id, reason: "terms-change freeze not confirmed" }, c.kase.id);
          return bad("freeze outcome unknown; reconcile before continuing", 409);
        }
      }
      c.kase.terms = parsed.data.terms;
      c.kase.rawTerms = parsed.data.rawTerms;
      c.requiresReapproval = true;
      if (c.intent) c.log.push("Deal changed. Approval invalidated; fresh human approval required. Old intent retained only for decline proof.");
      audit.append("terms_changed", { oldHash, newHash, cardId: c.card?.id }, c.kase.id);
      // Notify only when an approval actually existed to invalidate; a pre-approval terms edit invalidates nothing.
      if (c.intent) await dispatcher.deliver(outbox.emit(c.card ? "deal_changed_frozen" : "reapproval_required", { caseId: c.kase.id, vendor: c.kase.vendor, recipient, detail: { freezeState: c.freezeState ?? "no card", newTerms: parsed.data.rawTerms.slice(0, 300), cardState: !c.card ? "none" : c.card.status === "CLOSED" ? "closed" : "frozen" } }));
      persist();
      return json({ case: await view(c) });
    }
    if (url.pathname === "/api/freeze" && request.method === "POST") {
      const parsed = FreezeBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid freeze request", 400);
      const c = find(parsed.data.caseId);
      if (!c?.card) return bad("create the card first", 409);
      // Freezing only ever tightens, so a person may do it without a bound approval.
      c.freezeState = "pending";
      try {
        const frozen = await gateway.freezeCard(c.card.id, `${c.card.id}:manual-freeze`);
        if (frozen.status !== "FROZEN") throw new Error("freeze not confirmed");
        c.card = { ...c.card, status: "FROZEN" };
        c.freezeState = "verified";
      } catch {
        c.freezeState = "unknown";
        audit.append("outcome_unknown", { cardId: c.card.id, reason: "manual freeze not confirmed" }, c.kase.id);
        return bad("freeze outcome unknown; reconcile before continuing", 409);
      }
      c.log.push("Card freeze verified. New authorizations must decline.");
      audit.append("card_frozen", { cardId: c.card.id }, c.kase.id);
      persist();
      return json({ card: c.card, case: await view(c) });
    }
    if (url.pathname === "/api/close-card" && request.method === "POST") {
      const parsed = CloseCardBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid close request", 400);
      const c = find(parsed.data.caseId);
      if (!c?.card) return bad("create the card first", 409);
      if (c.pendingAuthorization) { audit.append("refused", { reason: "card close refused while an authorization outcome is unresolved", requestId: c.pendingAuthorization.requestId }, c.kase.id); return bad("an authorization outcome is unresolved; reconcile it before closing the card", 409); }
      // Permanent closure is terminal and cannot be undone: require a verified freeze first, so the
      // ladder is ACTIVE -> FROZEN -> CLOSED and no single request closes a transacting card.
      if (c.card.status !== "FROZEN") return bad("freeze the card before closing it permanently", 409);
      try {
        const closed = await gateway.closeCard(c.card.id, `${c.card.id}:manual-close`);
        if (closed.status !== "CLOSED") throw new Error("close not confirmed");
        c.card = { ...c.card, status: "CLOSED" };
      } catch {
        audit.append("outcome_unknown", { cardId: c.card.id, reason: "card close not confirmed" }, c.kase.id);
        return bad("close outcome unknown; reconcile before continuing", 409);
      }
      c.log.push("Card permanently closed at the provider. It can never transact again.");
      audit.append("card_closed", { cardId: c.card.id }, c.kase.id);
      persist();
      return json({ card: c.card, case: await view(c) });
    }
    if (url.pathname === "/api/salesforce/import" && request.method === "POST") {
      if(!options.contractSource)return bad("Salesforce source not configured",501);
      const input=await request.json().catch(()=>null) as any;
      if(!input||typeof input.contractId!=="string"||input.confirm!==true)return bad("Contract id and explicit review confirmation required",400);
      let source:ContractSnapshot;try{source=await options.contractSource.read(input.contractId);}catch{return bad("Salesforce contract read failed; no case created",409);}
      const parsed=IntakeBody.safeParse({...input,vendor:source.vendor,rawTerms:source.rawTerms,sourceNote:"Salesforce Contract "+source.id+"; status "+source.status+"; source text untrusted; synthetic test record"});
      if(!parsed.success)return bad("Twelve test weeklyBalances and reserveFloor required",400);
      if(input.previousCaseId){const old=find(input.previousCaseId);if(!old?.contractSource||old.contractSource.id!==source.id)return bad("Previous case/source mismatch",409);if(old.pendingAuthorization||old.createCardUnresolved)return bad("Reconcile unresolved previous case first",409);old.sourceInvalidated=true;await checkContract(old);if(old.freezeState==="unknown")return bad("Old card freeze not verified",409);}
      const id=`case_salesforce_${randomBytes(6).toString("hex")}`;
      const c:CaseState={kase:{id,vendor:source.vendor,rawTerms:source.rawTerms,sourceNote:parsed.data.sourceNote},contractSource:source,forecast:{weeklyBalances:parsed.data.weeklyBalances,reserveFloor:parsed.data.reserveFloor},forecastSource:parsed.data.forecastSource,transactionIds:[],log:["Explicit Salesforce Contract import. Source terms untrusted; no approval inherited. Forecast is synthetic test input."]};cases.push(c);audit.append("contract_import",{contractId:source.id,version:source.version},id);persist();return json({case:await view(c)},201);
    }
    if (url.pathname === "/api/intake" && request.method === "POST") {
      const parsed = IntakeBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid intake request: vendor, rawTerms, 12 weeklyBalances, reserveFloor and sourceNote are required", 400);
      const slug = parsed.data.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "vendor";
      const id = `case_${slug}_${randomBytes(3).toString("hex")}`;
      if (find(id)) return bad("case id collision; retry", 409);
      const c: CaseState = {
        kase: { id, vendor: parsed.data.vendor, rawTerms: parsed.data.rawTerms, sourceNote: parsed.data.sourceNote },
        forecast: { weeklyBalances: parsed.data.weeklyBalances, reserveFloor: parsed.data.reserveFloor },
        forecastSource: parsed.data.forecastSource,
        transactionIds: [],
        log: [`Case created from external intake (${parsed.data.sourceNote}). At intake: terms not extracted yet. Weekly balances and reserve floor are TEST SCENARIO INPUTS, not observed finances.`],
      };
      cases.push(c);
      audit.append("case_intake", { vendor: parsed.data.vendor, sourceNote: parsed.data.sourceNote, reserveFloor: parsed.data.reserveFloor }, id);
      persist();
      return json({ case: await view(c) }, 201);
    }
    if (url.pathname === "/api/reject" && request.method === "POST") {
      const parsed = RejectBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid reject request", 400);
      const c = find(parsed.data.caseId);
      if (!c) return bad("case not found", 404);
      // Reject claims "no card was created and no spend can happen". That is only TRUE when no
      // live card remains: a non-closed card could still authorize against the old approval, so
      // it must be closed first (the frozen state alone is provider-reversible).
      if (c.createCardUnresolved) { audit.append("refused", { reason: "rejection refused while card issuance is unresolved - a stray provider card may exist" }, c.kase.id); return bad("card issuance on this case is unresolved - a stray provider card may exist. Reconcile it first (POST /api/reconcile-card); rejecting now could assert 'no card' while a live card transacts", 409); }
      if (c.card && c.card.status !== "CLOSED") { audit.append("refused", { reason: "rejection refused while a live card exists - close it first", cardId: c.card.id }, c.kase.id); return bad("a live card exists on this case; close it before rejecting, otherwise spend could still happen", 409); }
      // Approver of record follows the same rule as approvals: the authenticated identity, never a client string.
      const rejectorLabel = identity ? (identity.email ?? identity.sub) : approver;
      c.rejected = parsed.data.reason;
      c.log.push(`Reviewer rejected the case: ${parsed.data.reason}. ${c.card ? "The card on this case is permanently closed - it can never transact again." : "No card was created."}`);
      audit.append("recommendation_rejected", { reason: parsed.data.reason, approver: rejectorLabel }, c.kase.id);
      await dispatcher.deliver(outbox.emit("recommendation_rejected", { caseId: c.kase.id, vendor: c.kase.vendor, recipient, detail: { approver: rejectorLabel, reason: parsed.data.reason, cardState: !c.card ? "none" : "closed" } }));
      persist();
      return json({ case: await view(c) });
    }
    if (url.pathname === "/api/agent-run" && request.method === "POST") {
      if (!options.executorModel) return bad("no model configured: the execution agent cannot run - use the human buttons", 501);
      const parsed = AgentRunBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid agent-run request", 400);
      const c = find(parsed.data.caseId);
      if (!c) return bad("case not found", 404);
      // The artifact and the route must name the SAME case: the inner create-card keys off
      // approval.caseId, so a mismatched body would read one case and mutate another.
      if (typeof parsed.data.approval.caseId === "string" && parsed.data.approval.caseId !== parsed.data.caseId)
        return bad("approval artifact belongs to a different case", 409);
      // Hard preconditions in code, before any model call: a person must have approved, and no
      // lock may stand. The agent never approves, never clears a lock, never overrides these.
      if (!c.intent) return bad("case not approved: a person approves before the agent runs", 409);
      if (c) { const sourceError=await checkContract(c);if(sourceError)return bad(sourceError,409); }
      if (c.requiresReapproval) return bad("deal changed; fresh human approval required before the agent runs", 409);
      if (c.rejected) return bad("case is rejected", 409);
      if (c.createCardUnresolved) return bad("card issuance outcome unresolved; reconcile before the agent runs", 409);
      if (c.freezeState === "unknown" || c.freezeState === "pending") return bad("freeze not verified; reconcile before the agent runs", 409);
      if (c.pendingAuthorization && !c.pendingAuthorization.reconciledAt) return bad("authorization unresolved; reconcile before the agent runs", 409);
      // A saved intent is not a reusable spending grant. Validate the exact approval before
      // even calling the model: a replay must not skip issuance and spend on the old card.
      const fullApproval = CreateCardBody.safeParse({ approval: parsed.data.approval });
      if (!fullApproval.success) return bad("invalid complete approval artifact", 400);
      const approvalRefusal = verifier.check(fullApproval.data.approval as Approval, c.kase.id, c.intent, DEFAULT_POLICY.version, now());
      if (approvalRefusal) { audit.append("refused", { reason: approvalRefusal }, c.kase.id); return bad(approvalRefusal, 409); }
      audit.append("agent_run_started", { caseId: c.kase.id, initiatedBy: identity ? (identity.email ?? identity.sub) : "demo-operator", scenario: parsed.data.scenario ?? "in-policy" }, c.kase.id);
      // The agent drives the SAME audited operations, in-process, under the initiating operator's
      // own identity (their cookie/token forwarded verbatim) - no new auth surface, no privilege.
      const fwd: Record<string, string> = { "content-type": "application/json" };
      const cookie = request.headers.get("cookie"); if (cookie) fwd.cookie = cookie;
      const tok = request.headers.get("x-console-token"); if (tok) fwd["x-console-token"] = tok;
      const ori = request.headers.get("origin"); if (ori) fwd.origin = ori;
      const callApi = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
        const init: RequestInit = body === undefined ? { method: "GET", headers: fwd } : { method: "POST", headers: fwd, body: JSON.stringify(body) };
        const r = await handle(new Request(`http://agent-internal${path}`, init));
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      let run: AgentRunResult;
      try {
        run = await runAgent(options.executorModel, c.kase.id, parsed.data.approval, callApi, { scenario: parsed.data.scenario });
      } catch (e) {
        audit.append("agent_run_error", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) }, c.kase.id);
        return bad("agent run failed: " + (e instanceof Error ? e.message : String(e)), 500);
      }
      audit.append("agent_run_finished", { ok: run.ok, steps: run.steps, needsReconcile: run.needsReconcile, summary: run.summary?.slice(0, 300), error: run.error?.slice(0, 200) }, c.kase.id);
      persist();
      return json({ run, case: await view(c) });
    }
    if (url.pathname === "/api/extract" && request.method === "POST") {
      if (!options.planner) return bad("no model configured: the terms above stay human-entered", 501);
      const parsed = ExtractBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid extract request", 400);
      const c = find(parsed.data.caseId);
      if (!c) return bad("case not found", 404);
      if (c.intent || c.card) return bad("extraction locked after approval; use the terms-change workflow", 409);
      const plan = await options.planner(c.kase, c.forecast);
      if (!plan.ok) {
        audit.append("model_error", { error: plan.error }, c.kase.id);
        c.log.push(`Model unavailable: ${plan.error}. Human-entered terms stand.`);
        return json({ plan, case: await view(c) });
      }
      audit.append(plan.gate?.accepted ? "model_proposal" : "model_proposal_rejected", {
        cadence: plan.proposal?.cadence, confidence: plan.proposal?.confidence, finalCadence: plan.gate?.finalCadence, reasons: plan.gate?.reasons,
        governance: plan.gate?.governance ? { rubricTotal: plan.gate.governance.rubric?.total, band: plan.gate.governance.rubric?.band, guardrails: plan.gate.governance.guardrailViolations.map((x) => x.check), reasoning: plan.gate.governance.reasoningViolations.map((x) => x.check), warnings: plan.gate.governance.warnings, critic: plan.gate.governance.critic?.veto } : undefined,
      }, c.kase.id);
      if (plan.gate?.accepted && plan.gate.finalCadence !== "ESCALATE" && plan.proposal) {
        c.kase.terms = { ...plan.proposal.extracted_terms };
        c.log.push(`Model extraction accepted by governance (${plan.gate.reasons.join("; ")}). A person still approves the intent.`);
      } else {
        c.log.push(`Model extraction not adopted: ${(plan.gate?.reasons ?? ["no proposal"]).join("; ")}.`);
      }
      return json({ plan, case: await view(c) });
    }
    return bad("not found", 404);
  };
  let writes: Promise<unknown> = Promise.resolve();
  const handler = (request: Request): Promise<Response> => {
    if (request.method !== "POST") return handle(request);
    const next = writes.then(() => handle(request));
    writes = next.catch(() => undefined);
    return next;
  };
  /** false while persisted state is unreadable (fail-closed) - readiness probes use this. */
  handler.readyCheck = () => !stateCorrupted;
  /** Flush safety state to disk; persisted on every mutation already, called again on shutdown. */
  // Final persist + release the store lease so a clean shutdown never blocks the next boot.
  handler.flush = () => { persist(); if (store && "close" in store) (store as { close: () => void }).close(); };
  return handler;
}

export interface ConsoleHandler {
  (request: Request): Promise<Response>;
  readyCheck(): boolean;
  flush(): void;
        }
