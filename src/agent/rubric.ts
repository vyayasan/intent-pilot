import { z } from "zod";

// The model scores the judgments code cannot compute from structured fields. It returns whole numbers 0 to 5 with
// citations. It never does the arithmetic: the weights, the total and the band live here, in one config a reviewer
// can read and tune. Unlike the cadence decision itself, which is pure policy math on the extracted terms.

export const CRITERIA = ["cash_fit", "terms_clarity", "vendor_signals", "policy_fit"] as const;
export type Criterion = (typeof CRITERIA)[number];

export interface RubricConfig {
  /** Must sum to 1. */
  weights: Record<Criterion, number>;
  /** Weighted total (0..1) at or above `strong` is strong; below `mixed` is weak. */
  bands: { strong: number; mixed: number };
  /** The most the rubric may move the model's own confidence, up or down. */
  maxAdjustment: number;
}

export const DEFAULT_RUBRIC: RubricConfig = {
  weights: { cash_fit: 0.4, terms_clarity: 0.25, vendor_signals: 0.2, policy_fit: 0.15 },
  bands: { strong: 0.75, mixed: 0.45 },
  maxAdjustment: 0.1,
};

export function validateRubricConfig(c: RubricConfig): void {
  const sum = CRITERIA.reduce((s, k) => s + c.weights[k], 0);
  if (Math.abs(sum - 1) > 1e-9 || CRITERIA.some((k) => c.weights[k] < 0)) throw new Error("rubric weights must be non-negative and sum to 1");
  if (!(c.bands.mixed > 0 && c.bands.mixed < c.bands.strong && c.bands.strong <= 1)) throw new Error("rubric bands must satisfy 0 < mixed < strong <= 1");
  if (!(c.maxAdjustment >= 0 && c.maxAdjustment <= 0.25)) throw new Error("rubric maxAdjustment must be between 0 and 0.25");
}

const Score = z.object({
  score: z.number().int().min(0).max(5),
  /** Fact keys or phrases from the vendor terms text this score rests on. */
  cites: z.array(z.string().max(120)).max(6),
  note: z.string().trim().min(1).max(300),
});
export const RubricSchema = z.object({
  cash_fit: Score, terms_clarity: Score, vendor_signals: Score, policy_fit: Score,
});
export type RubricScores = z.infer<typeof RubricSchema>;

export type Band = "strong" | "mixed" | "weak";
export interface RubricResult {
  total: number; band: Band; weights: Record<Criterion, number>;
  baseConfidence: number; adjustedConfidence: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function scoreRubric(s: RubricScores, baseConfidence: number, cfg: RubricConfig = DEFAULT_RUBRIC): RubricResult {
  validateRubricConfig(cfg);
  const total = r2(CRITERIA.reduce((t, k) => t + cfg.weights[k] * (s[k].score / 5), 0));
  const band: Band = total >= cfg.bands.strong ? "strong" : total >= cfg.bands.mixed ? "mixed" : "weak";
  const delta = band === "strong" ? cfg.maxAdjustment : band === "weak" ? -cfg.maxAdjustment : 0;
  return { total, band, weights: cfg.weights, baseConfidence, adjustedConfidence: Math.min(1, Math.max(0, r2(baseConfidence + delta))) };
}
