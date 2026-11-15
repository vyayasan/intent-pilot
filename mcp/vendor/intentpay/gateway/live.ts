import type {CardTransaction,CardTransactionStatus} from "../domain/types.js";
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
