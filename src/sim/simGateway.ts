import { createHash, randomUUID } from "node:crypto";
import type { AuthorizationRequest, Card, CardTransaction, Cardholder } from "../domain/types.js";
import type { CardControls } from "../domain/types.js";
import { canTransition } from "../domain/stateMachine.js";
import { withinLimit } from "../policy/policy.js";

// In-memory stand-in for the Airwallex issuing sandbox. The live gateway implements the same interface.
// Decline reasons are named after the policy rule that blocked the authorization, so a declined
// authorization explains which part of the approved intent it violated.

export const DECLINE = {
  ABOVE_CAP: "above_approved_cap",
  CURRENCY: "currency_not_allowed",
  CATEGORY: "category_not_allowed",
  FROZEN: "card_frozen",
  CLOSED: "card_closed",
  FUNDS: "insufficient_funds",
} as const;

type Maybe<T> = T | Promise<T>;
/** Tri-state cardholder lookup (round-4 N5): a provider ERROR is never proof of absence.
 *  "unknown" keeps locks standing; only a successful empty listing is "absent". */
export type CardholderLookup =
  | { state: "found"; cardholder: Cardholder }
  | { state: "absent" }
  | { state: "unknown"; error: string };
/** createCardholder reuses the lookup first: on "unknown" it must NOT create (duplicate hole). */
export type CardholderCreateResult =
  | { state: "created" | "found"; cardholder: Cardholder }
  | { state: "unknown"; error: string };
// Either side may be async: the sandbox gateway talks over the network, the simulator does not.
export interface IssuingGateway {
  createCardholder(req: { name: string; email: string }, requestId?: string): Maybe<CardholderCreateResult>;
  createCard(req: { cardholderId: string; controls: { amountLimit: number; currencyAllowlist: string[]; merchantCategories: string[] } }, requestId?: string): Maybe<Card>;
  freezeCard(cardId: string, requestId?: string): Maybe<Card>;
  unfreezeCard(cardId: string, requestId?: string): Maybe<Card>;
  /** Permanently close a card (documented provider path: update card_status=CLOSED). Terminal -
   *  a closed card can never transact again and cannot be reopened. */
  closeCard(cardId: string, requestId?: string): Maybe<Card>;
  authorize(cardId: string, auth: AuthorizationRequest, requestId?: string): Maybe<CardTransaction>;
  capture(transactionId: string, requestId?: string): Maybe<CardTransaction>;
  reverse(transactionId: string, requestId?: string): Maybe<CardTransaction>;
  refund(transactionId: string, requestId?: string): Maybe<CardTransaction>;
  listTransactions(cardId?: string): Maybe<CardTransaction[]>;
  /** Provider-side card listing - the recovery route for an ambiguous create. A gateway that
   *  cannot list cards cannot prove card recovery; the console refuses reconciliation and keeps
   *  issuance locked (the runtime typeof check in api.ts covers test doubles cast through never). */
  listCards(cardholderId: string): Maybe<Card[]>;
  /** Provider-side read-back of a card's actual controls - adopt requires verifying or
   *  correcting these, never overlaying local assumptions (round-3 N1). */
  readCardControls(cardId: string): Maybe<CardControls | undefined>;
  /** Correct a card's controls provider-side and return the post-write read-back. */
  setCardControls(cardId: string, controls: CardControls): Maybe<CardControls | undefined>;
  /** Cardholder recovery for a cardholder-ambiguous failure (round-3 N2, tri-state round-4 N5). */
  findCardholderByEmail(email: string): Maybe<CardholderLookup>;
  /** True only when the provider documents read-after-write consistency for its card listing,
   *  so a successful empty listing is authoritative proof of absence. Without it the
   *  "none-created" unlock is disabled (round-4 N3 residual). */
  supportsAuthoritativeAbsence?: boolean;
  getTransaction(id: string): Maybe<CardTransaction | undefined>;
}

export type SimGateway = {
  [K in keyof IssuingGateway as IssuingGateway[K] extends (...a: never[]) => unknown ? K : never]: IssuingGateway[K] extends (...a: infer A) => Maybe<infer R> ? (...a: A) => R : never;
} & { supportsAuthoritativeAbsence?: boolean };

export function makeSim(opts: { walletBalance?: number } = {}): SimGateway & { walletBalance: () => number } {
  let wallet = opts.walletBalance ?? 10_000;
  const cardholders = new Map<string, Cardholder>();
  const cards = new Map<string, Card>();
  const transactions = new Map<string, CardTransaction>();
  // request_id -> stored result, so a retry of the same logical action returns the same outcome
  // instead of creating a second financial action.
  const seen = new Map<string, unknown>();
  const idem = <T>(requestId: string | undefined, fn: () => T): T => {
    if (!requestId) return fn();
    const key = createHash("sha256").update(requestId).digest("hex");
    if (seen.has(key)) return seen.get(key) as T;
    const out = fn();
    seen.set(key, out);
    return out;
  };

  const fail = (cardId: string, auth: AuthorizationRequest, reason: string): CardTransaction => ({
    id: `txn_${randomUUID()}`, cardId, amount: auth.amount, currency: auth.currency,
    merchant: auth.merchant, category: auth.category, status: "FAILED", failureReason: reason,
    transactedAt: new Date().toISOString(),
  });

  const requireTxn = (id: string) => {
    const t = transactions.get(id);
    if (!t) throw new Error("transaction not found");
    return t;
  };
  const move = (t: CardTransaction, to: CardTransaction["status"]) => {
    if (!canTransition(t.status, to)) throw new Error(`illegal transition ${t.status} -> ${to}`);
    t.status = to;
    return t;
  };

  return {
    walletBalance: () => wallet,
    supportsAuthoritativeAbsence: true, // the simulator is strongly consistent by construction
    createCardholder: (req, requestId) => idem(requestId, () => {
      const c: Cardholder = { id: `cth_${randomUUID()}`, name: req.name, email: req.email };
      cardholders.set(c.id, c);
      const r: CardholderCreateResult = { state: "created", cardholder: c };
      return r;
    }),
    createCard: (req, requestId) => idem(requestId, () => {
      if (!cardholders.has(req.cardholderId)) throw new Error("cardholder not found");
      const c: Card = { id: `crd_${randomUUID()}`, cardholderId: req.cardholderId, controls: req.controls, status: "ACTIVE" };
      cards.set(c.id, c);
      return c;
    }),
    listCards: (cardholderId) => [...cards.values()].filter((c) => c.cardholderId === cardholderId),
    readCardControls: (cardId) => cards.get(cardId)?.controls,
    setCardControls: (cardId, controls) => {
      const c = cards.get(cardId);
      if (!c) throw new Error("card not found");
      c.controls = controls;
      return c.controls;
    },
    findCardholderByEmail: (email): CardholderLookup => {
      const f = [...cardholders.values()].find((c) => c.email.toLowerCase() === email.toLowerCase());
      return f ? { state: "found", cardholder: f } : { state: "absent" };
    },
    freezeCard: (cardId, requestId) => idem(requestId, () => {
      const c = cards.get(cardId);
      if (!c) throw new Error("card not found");
      c.status = "FROZEN";
      return c;
    }),
    unfreezeCard: (cardId, requestId) => idem(requestId, () => {
      const c = cards.get(cardId);
      if (!c) throw new Error("card not found");
      c.status = "ACTIVE";
      return c;
    }),
    closeCard: (cardId, requestId) => idem(requestId, () => {
      const c = cards.get(cardId);
      if (!c) throw new Error("card not found");
      c.status = "CLOSED";
      return c;
    }),
    authorize: (cardId, auth, requestId) => idem(requestId, () => {
      const c = cards.get(cardId);
      if (!c) throw new Error("card not found");
      let t: CardTransaction;
      if (c.status === "CLOSED") t = fail(cardId, auth, DECLINE.CLOSED);
      else if (c.status === "FROZEN") t = fail(cardId, auth, DECLINE.FROZEN);
      else if (!Number.isFinite(auth.amount) || auth.amount <= 0) t = fail(cardId, auth, DECLINE.ABOVE_CAP);
      else if (!withinLimit(auth.amount, c.controls.amountLimit)) t = fail(cardId, auth, DECLINE.ABOVE_CAP);
      else if (!c.controls.currencyAllowlist.includes(auth.currency)) t = fail(cardId, auth, DECLINE.CURRENCY);
      else if (!c.controls.merchantCategories.includes(auth.category)) t = fail(cardId, auth, DECLINE.CATEGORY);
      // Controls pass, then the funding check: an amount equal to the limit clears and reaches it.
      else if (auth.amount > wallet) t = fail(cardId, auth, DECLINE.FUNDS);
      else {
        wallet -= auth.amount;
        t = { id: `txn_${randomUUID()}`, cardId, amount: auth.amount, currency: auth.currency, merchant: auth.merchant, category: auth.category, status: "PENDING", transactedAt: new Date().toISOString() };
      }
      transactions.set(t.id, t);
      return t;
    }),
    capture: (id, requestId) => idem(requestId, () => move(requireTxn(id), "CLEARING")),
    reverse: (id, requestId) => idem(requestId, () => {
      const t = move(requireTxn(id), "REVERSED");
      wallet += t.amount;
      return t;
    }),
    refund: (id, requestId) => idem(requestId, () => {
      const t = move(requireTxn(id), "REFUNDED");
      wallet += t.amount;
      return t;
    }),
    listTransactions: (cardId) => [...transactions.values()].filter((t) => !cardId || t.cardId === cardId),
    getTransaction: (id) => transactions.get(id),
  };
}
