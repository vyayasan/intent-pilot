import { describe, it, expect } from "vitest";
import { page, pageJs } from "../src/console/page.js";

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

// Read-only refresh must never silently claim a failed fetch is fresh evidence.
describe("provider snapshot presentation", () => {
  it("offers an explicit refresh and marks a failed response stale", () => {
    expect(page).toContain('id="refresh"');
    expect(pageJs).toContain("Refresh failed - displayed snapshot may be stale");
    expect(pageJs).toContain("!Array.isArray(d.cases)");
    expect(pageJs).toContain("document.getElementById('refresh').onclick = function(){ load(); }");
  });
  it("labels preview transport and issuance controls without denying existing Gmail", () => {
    expect(pageJs).toContain("preview mode, nothing sent");
    expect(pageJs).not.toContain("no email delivery exists yet");
    expect(pageJs).toContain("Email delivery: Gmail");
    expect(pageJs).toContain("approved controls at issuance");
    expect(pageJs).not.toContain("the deal was NOT changed");
    expect(pageJs).toContain("Terms-change outcome unknown: response lost");
  });
});

it('rejected case remains visibly rejected and hides purchase actions',()=>{
 expect(pageJs).toContain("c.rejected ? 'rejected - no further purchase'");
 expect(pageJs).toContain('No new approval, card or purchase is allowed on this case.');
 expect(pageJs).toContain("#approve,#mkcard,#runagent,#extract");
});
