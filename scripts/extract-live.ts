import { createConsoleApi, demoCases } from "../src/console/api.js";
import { AuditLog } from "../src/audit/audit.js";
import { modelFromEnv } from "../src/agent/model.js";
import { extractTerms } from "../src/agent/planner.js";
import { appendFileSync } from "node:fs";

// Live model extraction run: same /api/extract path the console uses, in-process,
// against the configured OpenAI-compatible endpoint (EXTRACTION_BASE_URL/EXTRACTION_MODEL).
// Results are appended to runs/extraction-live-oss.jsonl, one line per case.
const model = modelFromEnv();
if (!model) throw new Error("no model configured: set ANTHROPIC_API_KEY or EXTRACTION_BASE_URL+EXTRACTION_MODEL");
const api = createConsoleApi({ key: "extract-live", approver: "sandi", audit: new AuditLog(undefined), sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases: demoCases(), planner: (kase, forecast) => extractTerms(model, kase, forecast) });
const extract = async (caseId: string) => {
  const r = await api(new Request("http://localhost:3000/api/extract", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify({ caseId }) }));
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ...d };
};
const out = process.env.EXTRACTION_RUN_OUT ?? "runs/extraction-live-oss.jsonl";
for (const caseId of (process.argv.slice(2).length ? process.argv.slice(2) : ["case_acme", "case_flowdesk", "case_northwind", "case_pulsar"])) {
  const started = Date.now();
  const d: any = await extract(caseId);
  const rec = {
    ts: new Date().toISOString(), model: process.env.EXTRACTION_MODEL ?? (process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_MODEL ?? "anthropic-default" : "unknown"),
    baseUrlHost: process.env.EXTRACTION_BASE_URL ? new URL(process.env.EXTRACTION_BASE_URL).host : "api.anthropic.com",
    caseId, ms: Date.now() - started, httpStatus: d.status,
    ok: d.plan?.ok ?? false, error: d.plan?.error ?? null,
    proposal: d.plan?.proposal ?? null, gate: d.plan?.gate ?? null,
    adoptedTerms: d.case?.kase?.terms ?? null,
  };
  appendFileSync(out, JSON.stringify(rec) + "\n");
  console.log(`${caseId}: ${rec.ok ? (rec.gate?.accepted ? `accepted (${rec.gate.finalCadence})` : `rejected (${(rec.gate?.reasons ?? []).join("; ")})`) : `error ${rec.error}`}`);
}
console.log(`wrote ${out}`);
