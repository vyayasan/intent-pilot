import { createHash, randomUUID } from "node:crypto";
import type { AuthorizationRequest, Card, CardTransaction, Cardholder } from "../domain/types.js";
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
  FUNDS: "insufficient_funds",
} as const;

type Maybe<T> = T | Promise<T>;
// Either side may be async: the sandbox gateway talks over the network, the simulator does not.
export interface IssuingGateway {
  createCardholder(req: { name: string; email: string }, requestId?: string): Maybe<Cardholder>;
  createCard(req: { cardholderId: string; controls: { amountLimit: number; currencyAllowlist: string[]; merchantCategories: string[] } }, requestId?: string): Maybe<Card>;
  freezeCard(cardId: string, requestId?: string): Maybe<Card>;
  unfreezeCard(cardId: string, requestId?: string): Maybe<Card>;
  authorize(cardId: string, auth: AuthorizationRequest, requestId?: string): Maybe<CardTransaction>;
  capture(transactionId: string, requestId?: string): Maybe<CardTransaction>;
  reverse(transactionId: string, requestId?: string): Maybe<CardTransaction>;
  refund(transactionId: string, requestId?: string): Maybe<CardTransaction>;
  listTransactions(cardId?: string): Maybe<CardTransaction[]>;
  getTransaction(id: string): Maybe<CardTransaction | undefined>;
}

export type SimGateway = {
  [K in keyof IssuingGateway]: IssuingGateway[K] extends (...a: infer A) => Maybe<infer R> ? (...a: A) => R : never;
};

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
    createCardholder: (req, requestId) => idem(requestId, () => {
      const c: Cardholder = { id: `cth_${randomUUID()}`, name: req.name, email: req.email };
      cardholders.set(c.id, c);
      return c;
    }),
    createCard: (req, requestId) => idem(requestId, () => {
      if (!cardholders.has(req.cardholderId)) throw new Error("cardholder not found");
      const c: Card = { id: `crd_${randomUUID()}`, cardholderId: req.cardholderId, controls: req.controls, status: "ACTIVE" };
      cards.set(c.id, c);
      return c;
    }),
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
    authorize: (cardId, auth, requestId) => idem(requestId, () => {
      const c = cards.get(cardId);
      if (!c) throw new Error("card not found");
      let t: CardTransaction;
      if (c.status === "FROZEN") t = fail(cardId, auth, DECLINE.FROZEN);
      else if (!Number.isFinite(auth.amount) || auth.amount <= 0) t = fail(cardId, auth, DECLINE.ABOVE_CAP);
      else if (!withinLimit(auth.amount, c.controls.amountLimit)) t = fail(cardId, auth, DECLINE.ABOVE_CAP);
      else if (!c.controls.currencyAllowlist.includes(auth.currency)) t = fail(cardId, auth, DECLINE.CURRENCY);
      else if (!c.controls.merchantCategories.includes(auth.category)) t = fail(cardId, auth, DECLINE.CATEGORY);
      // Controls pass, then the funding check: an amount equal to the limit clears and reaches it.
      else if (auth.amount > wallet) t = fail(cardId, auth, DECLINE.FUNDS);
      else {
        wallet -= auth.amount;
        t = { id: `txn_${randomUUID()}`, cardId, amount: auth.amount, currency: auth.currency, merchant: auth.merchant, category: auth.category, status: "PENDING" };
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
