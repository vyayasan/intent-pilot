/** Independent adversarial review of delta 2b070d6 (atop b12e7ea). */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStore, SqliteStore, type PersistedState } from "../src/console/state.js";
import { createConsoleApi } from "../src/console/api.js";
import { assertPublicEndpoint } from "../src/net/ssrf.js";

const state = (label: string): PersistedState => ({
  cases: [{ kase: { id: label, vendor: label, rawTerms: "x", terms: null }, forecast: { weeklyBalances: [1], reserveFloor: 0 }, transactionIds: [], log: [] }],
  usedNonces: [], notifications: [],
  approverKey: { privateKeyPem: "", keyId: "" }
});

describe("REGRESSION: legacy corrupt JSON + sqlite migration fails OPEN", () => {
  it("a corrupt legacy JSON state must keep the console fail-closed after migration logic runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    const dbPath = join(dir, "console-state.db");
    writeFileSync(join(dir, "console-state.json"), "{ this is not valid json !!!");
    const store = openStateStore(dbPath, "sqlite"); // migration path runs here
    const loaded = store.load();
    // b12e7ea behavior with a corrupt JSON file: stateCorrupted=true, all mutations refused (fail-closed).
    // 2b070d6: corrupted legacy JSON is skipped by the migrator, sqlite db is empty -> load() null -> clean start.
    expect(loaded, "corrupt legacy state must not silently become a clean start").toBe("corrupted");
  });
  it("end-to-end: api boots fail-closed (readyCheck false) when legacy JSON is corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    const dbPath = join(dir, "console-state.db");
    writeFileSync(join(dir, "console-state.json"), "{ not json");
    const api = createConsoleApi({ stateFile: dbPath, stateEngine: "sqlite" });
    expect(api.readyCheck(), "console should refuse readiness with un-migratable corrupt state").toBe(false);
  });
});

describe("sqlite store: stale-aggregate lost update across two writers", () => {
  it("FIXED by single-writer lease: the second writer is refused at open (no merge, no fork)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lw-"));
    const p = join(dir, "s.db");
    const a = new SqliteStore(p);
    a.save(state("A1"));
    // Reviewer's two-process scenario: the second opener now throws instead of silently
    // forking the aggregate (whole-aggregate last-writer-wins is no longer reachable).
    expect(() => new SqliteStore(p)).toThrow(/owned by another live console process/);
    a.close();
  });
});

describe("endpoint trust: mapped-IPv6 literals bypass assertPublicEndpoint", () => {
  it("https://[::ffff:7f00:1] (loopback in mapped form) is refused as an OIDC/mail endpoint", () => {
    expect(() => assertPublicEndpoint("https://[::ffff:7f00:1]/token")).toThrow();
  });
  it("https://[::ffff:a9fe:a9fe] (cloud metadata in mapped form) is refused", () => {
    expect(() => assertPublicEndpoint("https://[::ffff:a9fe:a9fe]/token")).toThrow();
  });
  it("sanity: plain private literals ARE refused", () => {
    expect(() => assertPublicEndpoint("https://127.0.0.1/token")).toThrow();
    expect(() => assertPublicEndpoint("https://[fd00::1]/token")).toThrow();
    expect(() => assertPublicEndpoint("https://192.168.1.10/token")).toThrow();
  });
});
