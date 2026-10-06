import { createHash } from "node:crypto";
import { z } from "zod";
import type { EvidenceItem } from "../domain/types.js";
import type { TapVerificationResult } from "./tap.js";

/** The local adapter shape is not a live Visa VIC integration. */
export interface InstructionProvider {
  getInstruction(id: string): Promise<VicInstruction | undefined> | VicInstruction | undefined;
}

/** An approved purchase intent in instruction form: the mandate a transaction is checked against. */
export interface VicInstruction {
  instructionId: string;
  maxAmount: number;
  currency: string;
  merchant: string;
  expiresAt: string;
  userAuthenticated: boolean;
  merchantCategories?: string[];
}

const instructionSchema = z.object({
  instructionId: z.string().min(1),
  maxAmount: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  merchant: z.string().min(1),
  expiresAt: z.string().datetime(),
  userAuthenticated: z.boolean(),
  merchantCategories: z.array(z.string().min(1)).optional()
});

/** A deterministic fixture-backed provider for tests and local demos. */
export class FixtureInstructionProvider implements InstructionProvider {
  private readonly instructions = new Map<string, VicInstruction>();

  constructor(fixtures: readonly VicInstruction[] = []) {
    for (const fixture of fixtures) {
      const parsed = instructionSchema.parse(fixture);
      this.instructions.set(parsed.instructionId, parsed);
    }
  }

  getInstruction(id: string): VicInstruction | undefined {
    const instruction = this.instructions.get(id);
    return instruction ? { ...instruction } : undefined;
  }
}

export interface MandateTransaction {
  id: string;
  amount: number;
  currency: string;
  merchant?: string;
  category?: string;
}

export interface MandateEvidenceResult {
  verified: boolean;
  reasons: string[];
  evidenceItem: EvidenceItem;
}

/**
 * Evaluate local instruction evidence against an already-verified TAP-style
 * signature and a card transaction. This creates a hash receipt, not a Visa-issued artifact.
 */
export function mandateEvidence(
  sig: TapVerificationResult,
  instruction: VicInstruction,
  transaction: MandateTransaction,
  now = new Date()
): MandateEvidenceResult {
  const parsed = instructionSchema.safeParse(instruction);
  const reasons: string[] = [];
  if (!sig.verified) reasons.push("request signature not verified");
  if (!parsed.success) {
    reasons.push("instruction is invalid");
  } else {
    const value = parsed.data;
    if (!value.userAuthenticated) reasons.push("user authentication missing");
    if (Date.parse(value.expiresAt) <= now.getTime()) reasons.push("instruction expired");
    if (transaction.amount > value.maxAmount) reasons.push("transaction amount exceeds instruction mandate");
    if (transaction.currency !== value.currency) reasons.push("currency does not match instruction mandate");
    if (transaction.merchant !== undefined && transaction.merchant !== value.merchant) reasons.push("merchant does not match instruction mandate");
    if (transaction.category !== undefined && value.merchantCategories !== undefined && !value.merchantCategories.includes(transaction.category)) reasons.push("merchant category outside instruction mandate");
  }
  const evidenceContent = JSON.stringify({
    instruction: parsed.success ? parsed.data : instruction,
    transaction: { id: transaction.id, amount: transaction.amount, currency: transaction.currency, merchant: transaction.merchant ?? null, category: transaction.category ?? null },
    signature: { verified: sig.verified, authority: sig.authority ?? null, path: sig.path ?? null, keyId: sig.keyId ?? null, tag: sig.tag ?? null },
    reasons
  });
  const sha256 = createHash("sha256").update(evidenceContent, "utf8").digest("hex");
  const evidenceItem: EvidenceItem = { name: `vic-mandate-${instruction.instructionId}`, sha256, kind: "mandate" };
  return { verified: reasons.length === 0, reasons, evidenceItem };
}
