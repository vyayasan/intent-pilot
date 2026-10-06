import { writeFileSync } from "node:fs";
import { decide, DEFAULT_POLICY } from "../src/policy/policy.js";
import { makeSim } from "../src/sim/simGateway.js";
import { scenarios, evalNow } from "./scenarios.js";
import { simScenarios } from "./simscenarios.js";
import { runGov } from "./governance.js";
import { govScenarios } from "./govscenarios.js";

type Row = { family: string; id: string; summary: string; expected: string; actual: string; pass: boolean };
const rows: Row[] = [];

for (const s of scenarios) {
  let actual: string; let breachWeek: number | null = null; let reconsider = false;
  try {
    const d = decide(s.terms, s.forecast, DEFAULT_POLICY, evalNow);
    actual = d.cadence; breachWeek = d.annualBreachWeek; reconsider = d.reconsiderAt != null;
  } catch { actual = "ERROR"; }
  let pass = actual === s.expected;
  if (s.expected !== "ESCALATE") pass = pass && breachWeek === (s.expectBreachWeek ?? null) && reconsider === s.expectReconsider;
  rows.push({ family: `policy/${s.family}`, id: s.id, summary: s.summary, expected: s.expected, actual, pass });
}

for (const s of simScenarios) {
  const sim = makeSim({ walletBalance: s.wallet });
  const holder = sim.createCardholder({ name: "Eval Runner", email: "evals@example.com" });
  const card = sim.createCard({ cardholderId: holder.id, controls: { amountLimit: s.limit, currencyAllowlist: s.allowCurrencies, merchantCategories: s.allowCategories } });
  const t = sim.authorize(card.id, s.auth);
  const pass = t.status === s.expectedStatus && (s.expectedReason === undefined || t.failureReason === s.expectedReason);
  rows.push({ family: `sim/${s.family}`, id: s.id, summary: s.summary, expected: s.expectedReason ? `${s.expectedStatus}:${s.expectedReason}` : s.expectedStatus, actual: t.failureReason ? `${t.status}:${t.failureReason}` : t.status, pass });
}

for (const s of govScenarios) {
  let outcome: { pass: boolean; detail: string };
  try { outcome = runGov(s, evalNow); } catch (e) { outcome = { pass: false, detail: `ERROR ${(e as Error).message}` }; }
  rows.push({ family: `governance/${s.family}`, id: s.id, summary: s.summary, expected: `${s.expectAccepted ? "accept" : "reject"}:${s.expectCadence}`, actual: outcome.detail, pass: outcome.pass });
}

const passed = rows.filter((r) => r.pass).length;
const families = [...new Set(rows.map((r) => r.family))];
const lines: string[] = [];
lines.push("# Kit 2 Eval Results", "");
lines.push(`Run: ${new Date().toISOString()} (fixture clock ${evalNow.toISOString()})`, "");
lines.push(`**${passed}/${rows.length} scenarios pass.** Deterministic fixtures only; no live model, no live API.`, "");
for (const f of families) {
  const fr = rows.filter((r) => r.family === f);
  lines.push(`## ${f} (${fr.filter((r) => r.pass).length}/${fr.length})`, "");
  lines.push("| Scenario | Expected | Actual | Pass |", "|---|---|---|---|");
  for (const r of fr) lines.push(`| ${r.id} | ${r.expected} | ${r.actual} | ${r.pass ? "yes" : "NO"} |`);
  lines.push("");
}
lines.push("## What each scenario proves", "");
for (const s of scenarios) lines.push(`- **${s.id}** (${s.summary}): ${s.why}`);
for (const s of simScenarios) lines.push(`- **${s.id}** (${s.summary}): ${s.why}`);
for (const s of govScenarios) lines.push(`- **${s.id}** (${s.summary}): ${s.why}`);
writeFileSync("evals/RESULTS.md", lines.join("\n") + "\n");
console.log(`${passed}/${rows.length} pass`);
for (const r of rows.filter((r) => !r.pass)) console.log(`FAIL ${r.family}/${r.id}: expected ${r.expected}, got ${r.actual}`);
process.exit(passed === rows.length ? 0 : 1);
