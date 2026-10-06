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
  const type = String(j.transaction_type ?? j.type ?? "").toUpperCase();
  const rawStatus = String(j.status ?? "").toUpperCase();
  const process = String(j.process_result ?? "").toUpperCase(); // simulator authorizations
  const status: CardTransactionStatus =
    process === "DECLINED" ? "FAILED"
    : type === "CLEARING" ? "CLEARING"
    : (STATUS_MAP[rawStatus] ?? "PENDING");
  return {
    id: j.id ?? j.card_transaction_id ?? j.transaction_id,
    cardId: j.card_id ?? "",
    amount: Number(j.amount ?? j.transaction_amount), currency: String(j.currency ?? j.transaction_currency ?? ""),
    merchant: j.merchant?.name ?? j.merchant_info ?? j.merchant_name ?? undefined,
    category: j.merchant?.category ?? j.merchant?.category_code ?? j.merchant_category_code ?? j.merchant_category ?? undefined,
    status,
    failureReason: status === "FAILED" ? String(j.failure_reason ?? j.decline_reason ?? "declined") : undefined,
  };
}

export class LiveIssuingGateway implements IssuingGateway {
  // Authorization responses pair a transaction id with a lifecycle id; captures and reversals
  // address the lifecycle. In-memory for the demo; a service would persist the pair.
  private lifecycles = new Map<string, string>();
  constructor(private client: AirwallexClient) {}

  async createCardholder(req: { name: string; email: string }, requestId?: string): Promise<Cardholder> {
    // Cardholders are unique by email on the account: a fresh console run must reuse, not duplicate.
    const existing = await this.client.listCardholders(req.email).catch(() => ({ items: [] }));
    const found = (existing.items ?? [])[0];
    if (found) return { id: found.cardholder_id ?? found.id, name: req.name, email: req.email };
    const [firstName, ...rest] = req.name.trim().split(/\s+/);
    // Shape verified against the sandbox (see RUNLOG.md): email is top-level, the individual block
    // requires date_of_birth, express_consent_obtained and address.country.
    const j = await this.client.createCardholder({
      type: "INDIVIDUAL",
      email: req.email,
      individual: {
        name: { first_name: firstName, last_name: rest.join(" ") || firstName },
        date_of_birth: "1990-01-01",
        express_consent_obtained: "yes",
        address: { country: "GB", city: "London", line1: "1 Demo Street", postcode: "E1 1AA" },
      },
    }, requestId);
    return { id: j.cardholder_id ?? j.id, name: req.name, email: req.email };
  }

  // Our policy categories are semantic names; the card controls take ISO merchant category codes.
  // A production build would resolve these from the full MCC registry.
  private static readonly MCC: Record<string, string> = { software: "5734", analytics: "7372", marketing: "7311" };

  async createCard(req: { cardholderId: string; controls: Card["controls"] }, requestId?: string): Promise<Card> {
    // Shape verified against the sandbox (see RUNLOG.md): program takes purpose only on this account,
    // created_by / is_personalized are mandatory, and categories are MCC codes.
    const j = await this.client.createCard({
      cardholder_id: req.cardholderId,
      form_factor: "VIRTUAL",
      brand: "VISA",
      created_by: "sandi@vyayasan.com",
      is_personalized: true,
      issue_to: "ORGANISATION",
      program: { purpose: "COMMERCIAL" },
      authorization_controls: {
        allowed_transaction_count: "MULTIPLE",
        transaction_limits: { currency: req.controls.currencyAllowlist[0], limits: [{ amount: req.controls.amountLimit, interval: "PER_TRANSACTION" }] },
        allowed_currencies: req.controls.currencyAllowlist,
        allowed_merchant_categories: req.controls.merchantCategories.map((c) => LiveIssuingGateway.MCC[c] ?? c),
      },
    }, requestId);
    return { id: j.card_id ?? j.id, cardholderId: req.cardholderId, controls: req.controls, status: "ACTIVE" };
  }

  async freezeCard(cardId: string, requestId?: string): Promise<Card> {
    // Verified live: the update endpoint takes card_status (INACTIVE/ACTIVE/CLOSED); an unknown field is silently ignored.
    const j = await this.client.updateCard(cardId, { card_status: "INACTIVE" }, requestId);
    return { id: j.id ?? cardId, cardholderId: j.cardholder_id ?? "", controls: { amountLimit: 0, currencyAllowlist: [], merchantCategories: [] }, status: "FROZEN" };
  }

  async unfreezeCard(cardId: string, requestId?: string): Promise<Card> {
    const j = await this.client.updateCard(cardId, { card_status: "ACTIVE" }, requestId);
    return { id: j.id ?? cardId, cardholderId: j.cardholder_id ?? "", controls: { amountLimit: 0, currencyAllowlist: [], merchantCategories: [] }, status: "ACTIVE" };
  }

  async authorize(cardId: string, auth: AuthorizationRequest, requestId?: string): Promise<CardTransaction> {
    // Simulator shape verified against the sandbox docs and live calls: transaction_amount /
    // transaction_currency, merchant_category_code as an MCC, merchant_info for the name.
    const j = await this.client.simCreateAuthorization({
      card_id: cardId, transaction_amount: auth.amount, transaction_currency: auth.currency,
      merchant_category_code: LiveIssuingGateway.MCC[auth.category ?? ""] ?? auth.category,
      merchant_info: auth.merchant,
    }, requestId);
    const t = toCardTransaction(j);
    if (j.card_transaction_lifecycle_id) this.lifecycles.set(t.id, j.card_transaction_lifecycle_id);
    return t;
  }

  async capture(transactionId: string, requestId?: string) {
    const lc = this.lifecycles.get(transactionId) ?? transactionId;
    return toCardTransaction(await this.client.simCapture(lc, requestId));
  }
  async reverse(transactionId: string, requestId?: string) {
    const lc = this.lifecycles.get(transactionId) ?? transactionId;
    return toCardTransaction(await this.client.simReverse(lc, requestId));
  }
  async refund(transactionId: string, requestId?: string) { return toCardTransaction(await this.client.simRefund({ transaction_id: transactionId }, requestId)); }

  async listTransactions(cardId?: string): Promise<CardTransaction[]> {
    const j = await this.client.listTransactions({ cardId });
    return (j.items ?? []).map(toCardTransaction);
  }
  async getTransaction(id: string) {
    return (await this.listTransactions()).find((t) => t.id === id);
  }
}
