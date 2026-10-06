import { describe, it, expect } from "vitest";
import { AuditLog, verifyChain } from "../src/audit/audit.js";
describe("audit log", () => {
  const mk = () => { const a = new AuditLog(undefined, () => new Date("2026-10-06T00:00:00Z")); a.append("intent_minted", { amount: 9 }, "c1"); a.append("card_created", { result: "ok" }, "c1"); a.append("reset"); return a; };
  it("verifies an untouched chain", () => expect(verifyChain(mk().list())).toEqual({ ok: true }));
  it("detects an edited entry", () => { const l = structuredClone([...mk().list()]); (l[1].detail as any).result = "forged"; expect(verifyChain(l).ok).toBe(false); });
  it("detects a deleted entry", () => { const l = [...mk().list()]; l.splice(1, 1); expect(verifyChain(l).brokenAt).toBe(3); });
  it("detects reordering", () => { const l = [...mk().list()]; [l[0], l[1]] = [l[1], l[0]]; expect(verifyChain(l).ok).toBe(false); });
});
