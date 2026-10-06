import { createConsoleApi, demoCases } from "../src/console/api.js";
import { AuditLog } from "../src/audit/audit.js";

// End-to-end smoke: queue -> policy decision -> approve -> card -> in-policy purchase clears,
// over-cap purchase declines with the policy rule as the reason. Runs in-process, no server needed.
const NOW = new Date("2026-10-06T09:00:00Z");
const audit = new AuditLog(undefined, () => NOW);
const api = createConsoleApi({ key: "smoke", approver: "sandi", now: () => NOW, audit, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"], seedCases: demoCases() });
const post = async (path: string, body: unknown) => {
  const r = await api(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": "tok", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));
  const d = await r.json().catch(() => ({}));
  if (r.status >= 400) throw new Error(`${path} -> ${r.status} ${JSON.stringify(d)}`);
  return d;
};
const view = (c: any) => c.cases.find((x: any) => x.kase.id === "case_acme");

const cases = await api(new Request("http://localhost:3000/api/cases")).then((r) => r.json());
const acme = view(cases);
console.log(`policy: ${acme.decision.cadence} (annual breaches week ${acme.decision.annualBreachWeek}, saves ${acme.decision.savingsPct}%)`);
if (acme.decision.cadence !== "monthly" || acme.decision.annualBreachWeek !== 7) throw new Error("policy decision drifted from the documented scenario");

const { approval } = await post("/api/approve", { caseId: "case_acme" });
console.log(`approved: ${approval.cadence} cap ${approval.amountCap} ${approval.currency}`);
const { card } = await post("/api/create-card", { approval });
console.log(`card: limit ${card.controls.amountLimit}, currencies ${card.controls.currencyAllowlist}, categories ${card.controls.merchantCategories}`);
const ok = await post("/api/simulate", { caseId: "case_acme", kind: "in-policy" });
console.log(`in-policy purchase: ${ok.transaction.status}`);
if (ok.transaction.status !== "CLEARING") throw new Error("in-policy purchase did not clear");
const no = await post("/api/simulate", { caseId: "case_acme", kind: "over-cap" });
console.log(`over-cap purchase: ${no.transaction.status} (${no.transaction.failureReason})`);
if (no.transaction.status !== "FAILED" || no.transaction.failureReason !== "above_approved_cap") throw new Error("over-cap purchase was not declined on the cap");
console.log(`audit: ${audit.list().length} entries`);
console.log("SMOKE PASS");
