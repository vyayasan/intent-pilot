// Core domain for the intent-bound purchase agent. Amounts are major units. Terms text is untrusted:
// it is vendor-authored input that the model reads, and every derived fact is checked in code.

export type Cadence = "monthly" | "annual";

export interface Terms {
  monthlyPrice: number | null;
  annualPrice: number | null;
  currency: string;
  category: string;
  noticeDays: number | null;
}

export interface CashForecast {
  weeklyBalances: number[]; // projected end-of-week balances
  reserveFloor: number; // minimum reserve that must survive
  breachWeek: number | null; // first week a cadence would breach the floor, null = none
}

export interface PurchaseIntent {
  id: string;
  vendor: string;
  cadence: Cadence;
  amountCap: number;
  currency: string;
  categories: string[]; // merchant category allowlist
  termsHash: string; // hash of the exact terms the approver saw
  reconsiderAt: string | null; // when the agent should re-weigh the choice
}

export interface Approval {
  id: string;
  intentHash: string; // bound to the intent exactly: change the deal and the approval no longer matches
  approvedBy: string;
  approvedAt: string;
}

export interface CardControls {
  amountLimit: number;
  currencyAllowlist: string[];
  merchantCategories: string[];
}

export type CardTransactionStatus = "PENDING" | "CLEARING" | "FAILED" | "REVERSED" | "REFUNDED";

export interface CardTransaction {
  id: string;
  cardId: string;
  amount: number;
  currency: string;
  merchant?: string;
  category?: string;
  status: CardTransactionStatus;
  failureReason?: string;
}

export interface EvidenceItem { name: string; sha256: string; kind: "jpg" | "pdf" | "mandate" }

export interface PurchaseCase {
  id: string;
  vendor: string;
  rawTerms: string; // untrusted vendor text
  terms?: Terms;
  forecast?: CashForecast;
  intent?: PurchaseIntent;
}

export type CardStatus = "ACTIVE" | "FROZEN";

export interface Cardholder { id: string; name: string; email: string }

export interface Card {
  id: string;
  cardholderId: string;
  controls: CardControls;
  status: CardStatus;
}

export interface AuthorizationRequest {
  amount: number;
  currency: string;
  merchant: string;
  category: string;
}
