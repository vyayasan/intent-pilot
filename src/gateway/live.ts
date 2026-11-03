import type { AuthorizationRequest, Card, CardTransaction, CardTransactionStatus, Cardholder } from "../domain/types.js";
import type { IssuingGateway } from "../sim/simGateway.js";
import type { CardholderLookup, CardholderCreateResult } from "../sim/simGateway.js";
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
  // Sandbox authorize/capture responses carry type + process_result and no status; the transactions
  // list carries transaction_type + status. A decline is failed however it arrives.
  const declined = process === "DECLINED" || rawStatus === "DECLINED" || (j.failure_reason != null && j.failure_reason !== "");
  const status: CardTransactionStatus =
    declined ? "FAILED"
    : type === "CLEARING" ? "CLEARING"
    : (STATUS_MAP[rawStatus] ?? "PENDING");
  return {
    // One id space: list items link to the authorization's card_transaction_id via card_transaction_data.
    id: j.card_transaction_data?.card_transaction_id ?? j.card_transaction_id ?? j.id ?? j.transaction_id,
    cardId: j.card_id ?? "",
    amount: Number(j.amount ?? j.transaction_amount), currency: String(j.currency ?? j.transaction_currency ?? ""),
    merchant: j.merchant?.name ?? j.merchant_info ?? j.merchant_name ?? undefined,
    category: j.merchant?.category ?? j.merchant?.category_code ?? j.merchant_category_code ?? j.merchant_category ?? undefined,
    status,
    failureReason: status === "FAILED" ? String(j.failure_reason ?? j.decline_reason ?? "declined") : undefined,
    transactedAt: j.transacted_at ?? j.updated_at ?? undefined,
  };
}

export class LiveIssuingGateway implements IssuingGateway {
  // Authorization responses pair a transaction id with a lifecycle id; captures and reversals
  // address the lifecycle. In-memory for the demo; a service would persist the pair.
  private lifecycles = new Map<string, string>();
  constructor(private client: AirwallexClient) {}

  // No documented read-after-write consistency guarantee on Airwallex listings (cards/list and
  // cardholders/list docs checked 2026-10-27): "none-created" unlock stays disabled on this gateway.
  readonly supportsAuthoritativeAbsence = false;

  async createCardholder(req: { name: string; email: string }, requestId?: string): Promise<CardholderCreateResult> {
    // Cardholders are unique by email on the account: a fresh console run must reuse, not duplicate.
    // Round-4 N5: a lookup ERROR is unknown, not absence - never create off a failed lookup.
    const lookup = await this.findCardholderByEmail(req.email);
    if (lookup.state === "unknown") return lookup;
    if (lookup.state === "found") return { state: "found", cardholder: lookup.cardholder };
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
    return { state: "created", cardholder: { id: j.cardholder_id ?? j.id, name: req.name, email: req.email } };
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

  async listCards(cardholderId: string): Promise<Card[]> {
    // Docs-verified route (see AirwallexClient.listCards). FULL pagination (round-3 N3): a
    // single first page is not evidence of absence. Bounded at 10 pages (1000 cards); beyond
    // that we fail closed rather than reconcile against a partial listing.
    const out: Card[] = [];
    for (let page = 0; page < 10; page++) {
      const j = await this.client.listCardsPage(cardholderId, page);
      const items = j.items ?? [];
      for (const x of items) out.push({
        id: x.card_id ?? x.id,
        cardholderId: x.cardholder_id ?? cardholderId,
        controls: { amountLimit: 0, currencyAllowlist: [], merchantCategories: [] },
        status: x.card_status === "ACTIVE" ? "ACTIVE" : x.card_status === "CLOSED" ? "CLOSED" : "FROZEN", // unknown status -> conservative
      });
      if (!j.has_more && items.length < 100) return out;
    }
    throw new Error("provider card listing exceeds 10 pages - refusing to reconcile against a partial listing");
  }

  // Reverse map for read-back comparison: the provider echoes MCC codes, intents use names.
  private static readonly MCC_REVERSE: Record<string, string> = Object.fromEntries(Object.entries(LiveIssuingGateway.MCC).map(([k, v]) => [v, k]));
  private static controlsFromProvider(x: any): Card["controls"] | undefined {
    const ac = x?.authorization_controls;
    if (!ac || !Array.isArray(ac.allowed_currencies) || !Array.isArray(ac.allowed_merchant_categories)) return undefined;
    const lim = ac.transaction_limits?.limits?.[0];
    if (typeof lim?.amount !== "number") return undefined;
    return {
      amountLimit: lim.amount,
      currencyAllowlist: [...ac.allowed_currencies].sort(),
      merchantCategories: ac.allowed_merchant_categories.map((m: string) => LiveIssuingGateway.MCC_REVERSE[m] ?? m).sort(),
    };
  }

  async readCardStatus(cardId: string): Promise<Card["status"] | undefined> {
    const j = await this.client.getCard(cardId);
    // Only documented states establish current status. Unknown is not "frozen".
    return j.card_status === "ACTIVE" ? "ACTIVE" : j.card_status === "INACTIVE" ? "FROZEN" : j.card_status === "CLOSED" ? "CLOSED" : undefined;
  }

  async readCardControls(cardId: string): Promise<Card["controls"] | undefined> {
    const j = await this.client.getCard(cardId);
    return LiveIssuingGateway.controlsFromProvider(j);
  }

  async setCardControls(cardId: string, controls: Card["controls"]): Promise<Card["controls"] | undefined> {
    // Docs-verified 27 Oct 2026: cards/update accepts authorization_controls and its response
    // echoes the full updated card - the echo is the read-back.
    const j = await this.client.updateCard(cardId, { authorization_controls: {
      allowed_transaction_count: "MULTIPLE",
      transaction_limits: { currency: controls.currencyAllowlist[0], limits: [{ amount: controls.amountLimit, interval: "PER_TRANSACTION" }] },
      allowed_currencies: controls.currencyAllowlist,
      allowed_merchant_categories: controls.merchantCategories.map((c) => LiveIssuingGateway.MCC[c] ?? c),
    } });
    return LiveIssuingGateway.controlsFromProvider(j);
  }

  async findCardholderByEmail(email: string): Promise<CardholderLookup> {
    // Round-4 N5: provider errors propagate as "unknown" - never swallow into "absent".
    let j: { items?: Array<Record<string, string>> };
    try {
      j = await this.client.listCardholders(email);
    } catch (e) {
      return { state: "unknown", error: e instanceof Error ? e.message : String(e) };
    }
    const f = (j.items ?? [])[0];
    return f
      ? { state: "found", cardholder: { id: f.cardholder_id ?? f.id, name: f.name ?? "", email } }
      : { state: "absent" };
  }

  async freezeCard(cardId: string, requestId?: string): Promise<Card> {
    // Verified live: the update endpoint takes card_status (INACTIVE/ACTIVE/CLOSED); an unknown field is silently ignored.
    await this.client.updateCard(cardId, { card_status: "INACTIVE" }, requestId);
    const j = await this.client.call<any>("GET", `/api/v1/issuing/cards/${encodeURIComponent(cardId)}`);
    if (j.card_status !== "INACTIVE" || (j.card_id ?? j.id) !== cardId) throw new Error("freeze read-back not confirmed");
    return { id: j.card_id ?? j.id ?? cardId, cardholderId: j.cardholder_id ?? "", controls: { amountLimit: 0, currencyAllowlist: [], merchantCategories: [] }, status: "FROZEN" };
  }

  async closeCard(cardId: string, requestId?: string): Promise<Card> {
    // Documented provider path (10-06 live finding): the update endpoint takes card_status=CLOSED.
    // Permanent and terminal, so verify by independent read-back with the same discipline as freeze.
    await this.client.updateCard(cardId, { card_status: "CLOSED" }, requestId);
    const j = await this.client.call<any>("GET", `/api/v1/issuing/cards/${encodeURIComponent(cardId)}`);
    if (j.card_status !== "CLOSED" || (j.card_id ?? j.id) !== cardId) throw new Error("close read-back not confirmed");
    return { id: j.card_id ?? j.id ?? cardId, cardholderId: j.cardholder_id ?? "", controls: { amountLimit: 0, currencyAllowlist: [], merchantCategories: [] }, status: "CLOSED" };
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
    const out: CardTransaction[] = [];
    for (let page = 0; page < 100; page++) {
      const j = await this.client.listTransactions({ cardId, size: 100, page });
      out.push(...(j.items ?? []).map(toCardTransaction));
      if (!j.has_more) return out;
    }
    throw new Error("provider transaction listing exceeds 100 pages - refusing partial ledger");
  }
  async getTransaction(id: string) {
    return (await this.listTransactions()).find((t) => t.id === id);
  }
}
