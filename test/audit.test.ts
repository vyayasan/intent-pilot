import { describe, it, expect } from "vitest";
import { AuditLog, verifyChain } from "../src/audit/audit.js";
describe("audit log", () => {
  const mk = () => { const a = new AuditLog(undefined, () => new Date("2026-10-06T00:00:00Z")); a.append("intent_minted", { amount: 9 }, "c1"); a.append("card_created", { result: "ok" }, "c1"); a.append("reset"); return a; };
  it("verifies an untouched chain", () => expect(verifyChain(mk().list())).toEqual({ ok: true }));
  it("detects an edited entry", () => { const l = structuredClone([...mk().list()]); (l[1].detail as any).result = "forged"; expect(verifyChain(l).ok).toBe(false); });
  it("detects a deleted entry", () => { const l = [...mk().list()]; l.splice(1, 1); expect(verifyChain(l).brokenAt).toBe(3); });
  it("detects reordering", () => { const l = [...mk().list()]; [l[0], l[1]] = [l[1], l[0]]; expect(verifyChain(l).ok).toBe(false); });
});

describe("audit persistence across restarts", () => {
  it("restores the persisted trail with case attribution intact and continues the chain", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "audit-")), "audit.jsonl");
    const now = () => new Date("2026-10-27T08:00:00Z");
    const log1 = new AuditLog(file, now);
    log1.append("approval_issued", { cadence: "monthly" }, "case_acme");
    log1.append("approval_issued", { cadence: "annual" }, "case_flowdesk");
    // restart: a fresh AuditLog on the same file
    const log2 = new AuditLog(file, now);
    const restored = log2.list();
    expect(restored).toHaveLength(2);
    expect(restored[0].caseId).toBe("case_acme");
    expect(restored[1].caseId).toBe("case_flowdesk");
    const third = log2.append("card_created", { cardId: "crd_1" }, "case_acme");
    expect(third.seq).toBe(3);
    expect(third.prev).toBe(restored[1].hash);
    expect(verifyChain(log2.list()).ok).toBe(true);
  });
});
