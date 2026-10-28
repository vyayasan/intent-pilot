import type { CardTransactionStatus } from "./types.js";

// Card transaction state machine, kept deliberately separate from the transfer one: a declined
// card transaction ends in FAILED, while a failed transfer ends in CANCELLED. There is no APPROVED
// status - a cleared transaction can sit in PENDING longer than a demo, so CLEARING is the
// accepted state and failure_reason carries a decline.
const TRANSITIONS: Record<CardTransactionStatus, CardTransactionStatus[]> = {
  PENDING: ["CLEARING", "FAILED"],
  CLEARING: ["REVERSED", "REFUNDED"],
  FAILED: [],
  REVERSED: [],
  REFUNDED: [],
};

export const legalTransitions = (s: CardTransactionStatus): CardTransactionStatus[] => TRANSITIONS[s];
export const canTransition = (from: CardTransactionStatus, to: CardTransactionStatus) => TRANSITIONS[from].includes(to);
export const isTerminal = (s: CardTransactionStatus) => TRANSITIONS[s].length === 0;
/** CLEARING counts as accepted: the demo never waits for a status called APPROVED. */
export const isAccepted = (s: CardTransactionStatus) => s === "CLEARING";
