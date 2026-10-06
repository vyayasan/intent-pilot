import type { AuthorizationRequest, Card, CardTransaction, CardTransactionStatus, Cardholder } from "../domain/types.js";
import type { IssuingGateway } from "../sim/simGateway.js";
import type { AirwallexClient } from "./airwallex.js";

// The same IssuingGateway interface as the simulator, backed by the Airwallex sandbox.
// REST payload field names follow the issuing docs (cardholder "type" on REST, "cardholder_type" on MCP);
// the exact shapes are exercised against the sandbox in the live run before the demo.

const STATUS_MAP: Record<string, CardTransactionStatus> = {
  PENDING: "PENDING", CLEARING: "CLEARING", FAILED: "FAILED", REVERSED: "REVERSED", REFUNDED: "REFUNDED",
};

// CLEARING is the accepted state: a cleared transaction can sit in PENDING longer than a demo,
// so the mapping keys on transaction_type for acceptance and failure_reason for a decline.
export function toCardTransaction(j: any): CardTransaction {
  const type = String(j.transaction_type ?? "").toUpperCase();
  const rawStatus = String(j.status ?? "").toUpperCase();
  const status: CardTransactionStatus =
    type === "CLEARING" ? "CLEARING" : (STATUS_MAP[rawStatus] ?? "PENDING");
  return {
    id: j.id, cardId: j.card_id ?? "",
    amount: Number(j.amount), currency: String(j.currency ?? ""),
    merchant: j.merchant?.name ?? j.merchant_name ?? undefined,
    category: j.merchant?.category ?? j.merchant_category ?? undefined,
    status,
    failureReason: status === "FAILED" ? String(j.failure_reason ?? "declined") : undefined,
  };
}

export class LiveIssuingGateway implements IssuingGateway {
  constructor(private client: AirwallexClient) {}

  async createCardholder(req: { name: string; email: string }, requestId?: string): Promise<Cardholder> {
    const [firstName, ...rest] = req.name.trim().split(/\s+/);
    const j = await this.client.createCardholder({
      type: "INDIVIDUAL",
      individual: { name: { first_name: firstName, last_name: rest.join(" ") || firstName }, email: req.email },
    }, requestId);
    return { id: j.id, name: req.name, email: req.email };
  }

  async createCard(req: { cardholderId: string; controls: Card["controls"] }, requestId?: string): Promise<Card> {
    const j = await this.client.createCard({
      cardholder_id: req.cardholderId,
      card_type: "VIRTUAL",
      card_controls: {
        transaction_limits: [{ amount: req.controls.amountLimit, interval: "PER_TRANSACTION" }],
        allowed_currencies: req.controls.currencyAllowlist,
        allowed_merchant_categories: req.controls.merchantCategories,
      },
    }, requestId);
    return { id: j.id, cardholderId: req.cardholderId, controls: req.controls, status: "ACTIVE" };
  }

  async freezeCard(cardId: string, requestId?: string): Promise<Card> {
    const j = await this.client.updateCard(cardId, { status: "FROZEN" }, requestId);
    return { id: j.id ?? cardId, cardholderId: j.cardholder_id ?? "", controls: { amountLimit: 0, currencyAllowlist: [], merchantCategories: [] }, status: "FROZEN" };
  }

  async authorize(cardId: string, auth: AuthorizationRequest, requestId?: string): Promise<CardTransaction> {
    const j = await this.client.simCreateAuthorization({
      card_id: cardId, amount: auth.amount, currency: auth.currency,
      merchant: { name: auth.merchant, category: auth.category },
    }, requestId);
    return toCardTransaction(j);
  }

  async capture(transactionId: string, requestId?: string) { return toCardTransaction(await this.client.simCapture(transactionId, requestId)); }
  async reverse(transactionId: string, requestId?: string) { return toCardTransaction(await this.client.simReverse(transactionId, requestId)); }
  async refund(transactionId: string, requestId?: string) { return toCardTransaction(await this.client.simRefund({ transaction_id: transactionId }, requestId)); }

  async listTransactions(cardId?: string): Promise<CardTransaction[]> {
    const j = await this.client.listTransactions({ cardId });
    return (j.items ?? []).map(toCardTransaction);
  }
  async getTransaction(id: string) {
    return (await this.listTransactions()).find((t) => t.id === id);
  }
}
