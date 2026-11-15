import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildConsoleServer } from "../src/console/server.js";

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = undefined; });

const start = async (env: NodeJS.ProcessEnv) => {
  const built = buildConsoleServer({ PORT: "3000", INTENTPAY_STATE_FILE: `/tmp/test-state-${Math.random().toString(36).slice(2)}.json`, INTENTPAY_AUDIT_FILE: `/tmp/test-audit-${Math.random().toString(36).slice(2)}.jsonl`, ...env });
  server = built.server;
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server!.address() as AddressInfo).port;
  const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: `127.0.0.1:${port}` } });
  const token = /console-token" content="([^"]+)/.exec(await page.text())![1];
  return { port, token, url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
};

describe("console server hardening", () => {
  it("refuses to boot on invalid configuration (fail fast)", () => {
    expect(() => buildConsoleServer({ INTENTPAY_EMAIL_TRANSPORT: "bogus" })).toThrow("invalid console configuration");
  });

  it("serves health and readiness probes without the session token", async () => {
    const { url, host } = await start({});
    const h = await fetch(`${url}/healthz`, { headers: { host } });
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true });
    const r = await fetch(`${url}/readyz`, { headers: { host } });
    expect(r.status).toBe(200);
  });

  it("sets security headers on the page, api responses and errors", async () => {
    const { url, host, token } = await start({});
    for (const res of [
      await fetch(`${url}/`, { headers: { host } }),
      await fetch(`${url}/api/cases`, { headers: { host } }),
      await fetch(`${url}/nope`, { headers: { host } })
    ]) {
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("content-security-policy")).toContain("font-src 'self' data: https://fonts.gstatic.com");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
    void token;
  });

  it("rejects oversized request bodies with 413", async () => {
    const { url, host, token } = await start({});
    const res = await fetch(`${url}/api/approve`, {
      method: "POST",
      headers: { host, "content-type": "application/json", "x-console-token": token, origin: `http://${host}` },
      body: JSON.stringify({ caseId: "case_acme", pad: "x".repeat(300 * 1024) })
    });
    expect(res.status).toBe(413);
  });

  it("rate limits POST bursts per client with 429", async () => {
    const { url, host, token } = await start({ INTENTPAY_RATE_LIMIT_PER_MIN: "3" });
    const post = () => fetch(`${url}/api/cases`, { method: "POST", headers: { host, "content-type": "application/json", "x-console-token": token, origin: `http://${host}` }, body: "{}" });
    expect((await post()).status).not.toBe(429);
    await post(); await post();
    const limited = await post();
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/rate limited/);
  });

  it("still serves the console flow normally under the limits", async () => {
    const { url, host, token } = await start({});
    const res = await fetch(`${url}/api/approve`, {
      method: "POST",
      headers: { host, "content-type": "application/json", "x-console-token": token, origin: `http://${host}` },
      body: JSON.stringify({ caseId: "case_acme" })
    });
    expect(res.status).toBe(200);
    expect((await res.json()).approval.cadence).toBe("monthly");
  });
});
