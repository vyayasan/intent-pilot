import { describe, it, expect } from "vitest";
import { ApprovalVerifier, issue } from "../src/approval/approval.js";
import { mintIntent } from "../src/intent/intent.js";
import type { Terms } from "../src/domain/types.js";

const terms: Terms = { monthlyPrice: 100, annualPrice: 984, currency: "USD", category: "software", noticeDays: 30 };
const intent = mintIntent({ vendor: "Acme SaaS", cadence: "monthly", amountCap: 100, currency: "USD", categories: ["software"], terms, reconsiderAt: null });
const now = new Date("2026-10-06T09:00:00Z");
const KEY = "test-approval-key";

describe("bound approvals", () => {
  it("issues and verifies against the live intent", () => {
    const a = issue("case-1", intent, "2026-10-06.1", "sandi", KEY, 60_000, now, "looks right");
    expect(new ApprovalVerifier(KEY).check(a, "case-1", intent, "2026-10-06.1", now)).toBeNull();
  });

  it("refuses when the deal changes after approval", () => {
    const v = new ApprovalVerifier(KEY);
    const a = issue("case-1", intent, "2026-10-06.1", "sandi", KEY, 60_000, now);
    expect(v.check(a, "case-1", { ...intent, amountCap: 101 }, "2026-10-06.1", now)).toBe("intent changed");
    expect(v.check(a, "case-1", { ...intent, termsHash: "0".repeat(64) }, "2026-10-06.1", now)).toBe("terms changed");
    expect(v.check(a, "case-2", intent, "2026-10-06.1", now)).toBe("case mismatch");
    expect(v.check(a, "case-1", intent, "2026-10-06.2", now)).toBe("policy version changed");
  });

  it("refuses a forged signature, an expired approval and a reused nonce", () => {
    const v = new ApprovalVerifier(KEY);
    const a = issue("case-1", intent, "2026-10-06.1", "sandi", KEY, 60_000, now);
    expect(v.check({ ...a, sig: "0".repeat(64) }, "case-1", intent, "2026-10-06.1", now)).toBe("bad signature");
    expect(v.check(a, "case-1", intent, "2026-10-06.1", new Date(now.getTime() + 120_000))).toBe("approval expired");
    expect(v.check(a, "case-1", intent, "2026-10-06.1", now)).toBeNull();
    v.consume(a);
    expect(v.check(a, "case-1", intent, "2026-10-06.1", now)).toBe("approval already used");
  });

  it("refuses under the wrong key", () => {
    const a = issue("case-1", intent, "2026-10-06.1", "sandi", KEY, 60_000, now);
    expect(new ApprovalVerifier("other-key").check(a, "case-1", intent, "2026-10-06.1", now)).toBe("bad signature");
  });
});
