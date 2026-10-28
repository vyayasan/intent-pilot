import { describe, it, expect } from "vitest";
import { pageJs } from "../src/console/page.js";

// The console client is a template string tsc cannot typecheck; these guards pin the
// source-confirmed rendering defects closed in the connected-run review.
describe("console page client", () => {
  it("parses as a function body (syntax guard for the template-string JS)", () => {
    expect(() => new Function(pageJs)).not.toThrow();
  });

  it("renders an unstated vendor notice as 'not stated', never as 0 days", () => {
    expect(pageJs).toContain("t.noticeDays == null ? 'not stated'");
    expect(pageJs).not.toContain("t.noticeDays || 0");
  });

  it("offers the synthetic deal fixture only on seeded fixture cases and never on a live console", () => {
    expect(pageJs).toContain("!c.termsSource && !state.live");
    expect(pageJs).toContain("state.live ? 'none' : ''");
  });
});
