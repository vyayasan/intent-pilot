/** Misc independent checks, snapshot 2b070d6. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleApi } from "../src/console/api.js";
import { AuditLog } from "../src/audit/audit.js";
import type { AuthProvider } from "../src/console/auth.js";

describe("viewer information exposure", () => {
  it("GET /api/cases ships the ENTIRE global audit trail (all cases, all users' refused subs) to a viewer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v-"));
    const audit = new AuditLog(join(dir, "a.jsonl"));
    const viewerAuth: AuthProvider = {
      name: "fake",
      authenticate: () => ({ sub: "viewer-1", role: "viewer", provider: "test" }),
    };
    const api = createConsoleApi({ stateFile: join(dir, "s.json"), audit, auth: viewerAuth });
    audit.append("approval_issued", { amountCap: 400, currency: "USD" }, "case_flowdesk");
    audit.append("refused", { reason: "role viewer cannot POST /api/approve", sub: "other-user-sub-9" });
    const res = await api(new Request("http://x/api/cases", { headers: { origin: "http://x" } }));
    const body = (await res.json()) as any;
    // FIXED (review F6): a viewer receives NO audit trail at the API level at all.
    expect(body.audit).toEqual([]);
  });
});

describe("credential file permissions", () => {
  it("state file holding the approver PRIVATE KEY is written with default (umask) perms, not 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p-"));
    const sf = join(dir, "s.json");
    const api = createConsoleApi({ stateFile: sf });
    await api(new Request("http://x/api/reject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId: "case_acme", reason: "no" }) }));
    api.flush();
    const mode = statSync(sf).mode & 0o777;
    expect(mode, `state file mode ${mode.toString(8)} contains approver private key`).toBe(0o600);
  });
});
