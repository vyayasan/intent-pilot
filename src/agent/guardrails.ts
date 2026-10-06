import type { PurchaseCase } from "../domain/types.js";
import type { Proposal } from "./planner.js";
import { CRITERIA } from "./rubric.js";

/** Policy-derived figures the model may also rely on: breach weeks, the saving, the floor and the projection. */
export interface PolicyContext { extraNumbers: (number | null)[] }

// Guardrails constrain what the model may say before anything else looks at it. Each check is plain code with a
// named reason. Any failure means the extraction is rejected and the case waits for a person.

export interface Violation { check: string; detail: string }

const CERTAINTY = /\b(guarantee[sd]?|certain(ly)? (to )?save|will (definitely |certainly )?save|cannot go wrong|100% (sure|certain)|no risk|risk[- ]free)\b/i;
const INSTRUCTION_LIKE = /\b(ignore (all |the |any )?(previous|prior|above|policy|rules)|disregard|system\s*:|you (must|should) (now )?(accept|approve|create|charge)|override)\b/i;

/** Every fact the model may rely on: the raw vendor terms text plus the policy-derived figures, serialised once. */
function allowedText(c: PurchaseCase, ctx?: PolicyContext): string {
  const extra = (ctx?.extraNumbers ?? []).filter((n): n is number => n != null).map(String).join(" ");
  return (c.rawTerms.toLowerCase().replace(/[$,]/g, "") + " " + extra);
}
const numbersIn = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));

export function checkGuardrails(p: Proposal, c: PurchaseCase, ctx?: PolicyContext): { violations: Violation[]; warnings: string[] } {
  const v: Violation[] = [], warnings: string[] = [];
  const text = [p.rationale, ...CRITERIA.map((k) => p.rubric[k].note)].join("\n");
  const hay = allowedText(c, ctx);

  // 1. No new facts: every extracted number must appear in the vendor terms text.
  const t = p.extracted_terms;
  const extracted = [t.monthlyPrice, t.annualPrice, t.noticeDays].filter((n): n is number => n != null).map(String);
  const missing = extracted.filter((n) => !hay.includes(n.replace(/\.0+$/, "")));
  if (missing.length) v.push({ check: "no_new_facts", detail: `extracted numbers not found in the terms text: ${missing.slice(0, 5).join(", ")}` });

  // 2. The currency must appear in the text, and the category must be a plain word present in it.
  if (!hay.includes(t.currency.toLowerCase())) v.push({ check: "no_new_facts", detail: `currency ${t.currency} does not appear in the terms text` });
  if (!/^[a-z][a-z-]{2,23}$/.test(t.category.toLowerCase()) || !hay.includes(t.category.toLowerCase()))
    v.push({ check: "no_new_facts", detail: `category "${t.category.slice(0, 24)}" does not appear in the terms text` });

  // 3. Numbers in the rationale must come from the terms text too.
  const unknownNumbers = [...new Set(numbersIn(text))].filter((n) => !hay.includes(n) && !extracted.includes(n));
  if (unknownNumbers.length) v.push({ check: "no_new_facts", detail: `rationale carries numbers not in the terms text: ${unknownNumbers.slice(0, 5).join(", ")}` });

  // 4. Citations must be real phrases from the terms text.
  const strip = (x: string) => x.toLowerCase().replace(/[$,]/g, "").trim();
  const badCites = [...p.cited_facts, ...CRITERIA.flatMap((k) => p.rubric[k].cites)].filter((x) => !hay.includes(strip(x)));
  if (badCites.length) v.push({ check: "citations", detail: `cites phrases not in the terms text: ${badCites.slice(0, 3).map((x) => JSON.stringify(x)).join(", ")}` });

  // 5. Bounded tone: no promises about the outcome.
  if (CERTAINTY.test(text)) v.push({ check: "bounded_language", detail: "rationale promises an outcome" });

  // 6. No links anywhere in the output.
  if (/https?:\/\/|www\./i.test(text)) v.push({ check: "no_links", detail: "output contains a link" });

  // Warning only: the terms text tried to instruct the reader. The model is told to treat it as data, and it cannot
  // change the outcome anyway, but the reviewer should know.
  if (INSTRUCTION_LIKE.test(c.rawTerms)) warnings.push("terms text contains instruction-like wording; treated as data");

  // Warning only: the annual price is not a discount on twelve months. Worth a human glance, not a refusal.
  if (t.monthlyPrice != null && t.annualPrice != null && t.annualPrice >= t.monthlyPrice * 12)
    warnings.push("annual price is not cheaper than twelve monthly payments");
  return { violations: v, warnings };
}
