/**
 * INDEPENDENT ADVERSARIAL REVIEW tests (reviewer-authored, not builder-authored).
 * Snapshot: b12e7ea. Each test names the claim or boundary under attack.
 */
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivateIp, isPrivateHostname, assertPublicResolution } from "../../src/net/ssrf.js";
import { HttpMailTransport, AmbiguousMailFailure, DefiniteMailFailure } from "../../src/notify/transport.js";
import { Outbox } from "../../src/notify/outbox.js";
import { NotificationDispatcher } from "../../src/notify/dispatcher.js";
import { AuditLog, verifyChain } from "../../src/audit/audit.js";
import { ExtractedTermsSchema } from "../../src/agent/planner.js";

describe("SSRF guard: IPv4-mapped/encoded IPv6 bypass", () => {
  it("IPv4-mapped IPv6 literals of private ranges are refused", () => {
    // The metadata endpoint and loopback in mapped form MUST be private.
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:10.1.2.3")).toBe(true);
    expect(isPrivateIp("::ffff:a9fe:a9fe")).toBe(true); // hex-octet form of 169.254.169.254
  });
  it("a DNS answer of ::ffff:169.254.169.254 is refused at resolution time", () => {
    expect(() => assertPublicResolution("attacker.example", [{ address: "::ffff:169.254.169.254" }])).toThrow();
  });
  it("endpoint hostname as an IPv4-mapped IPv6 literal is refused", () => {
    expect(isPrivateHostname("[::ffff:7f00:1]")).toBe(true); // 127.0.0.1
    expect(isPrivateHostname("[::ffff:127.0.0.1]")).toBe(true);
  });
  it("end-to-end: the production-guarded transport connects to a mapped-IPv6 target only if the guard misses it", async () => {
    // A local listener stands in for an internal service; DNS is stubbed to answer the mapped form.
    const hits: string[] = [];
    const srv: Server = createServer((sock) => { hits.push("connect"); sock.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}"); });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const port = (srv.address() as any).port;
    try {
      const t = new HttpMailTransport(`https://internal-victim.example:${port}/send`, undefined, fetch, 3000, {
        guard: "production",
        lookupAll: async () => [{ address: "::ffff:127.0.0.1", family: 6 }],
      });
      const o = new Outbox();
      const rec = o.emit("purchase_cleared", { caseId: "c1", vendor: "V", recipient: "a@b.co", detail: { amount: 1, currency: "USD", cap: 1 } });
      await expect(t.send(rec)).rejects.toThrow(); // if the guard works this throws before connecting
      expect(hits).toEqual([]); // and nothing connected to the internal service
    } finally { srv.close(); }
  });
});

describe("mail classification: post-arrival errors must never be 'definitely not sent'", () => {
  const rec = () => new Outbox().emit("purchase_cleared", { caseId: "c1", vendor: "V", recipient: "a@b.co", detail: { amount: 1, currency: "USD", cap: 1 } });
  async function rawServer(reply: () => Buffer | null): Promise<{ port: number; arrived: () => number; close: () => void }> {
    let n = 0;
    const srv = createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.includes("\r\n\r\n")) {
          n++;
          const r = reply();
          if (r) sock.end(r); else sock.destroy();
        }
      });
    });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    return { port: (srv.address() as any).port, arrived: () => n, close: () => srv.close() };
  }
  it("a garbage (non-HTTP) reply AFTER the request arrived is ambiguous, not definite", async () => {
    const s = await rawServer(() => Buffer.from("THIS IS NOT HTTP\r\n\r\n"));
    try {
      const t = new HttpMailTransport(`http://127.0.0.1:${s.port}/send`, undefined, fetch, 3000, { guard: "off" });
      const err = await t.send(rec()).then(() => null, (e: Error) => e);
      expect(s.arrived()).toBe(1); // the endpoint DID receive the email payload
      expect(err, "send must fail").toBeTruthy();
      expect(err instanceof AmbiguousMailFailure, `post-arrival garbage classified as: ${err?.constructor.name}: ${err?.message}`).toBe(true);
    } finally { s.close(); }
  });
  it("a truncated HTTP reply (headers then close) AFTER arrival is ambiguous, not definite", async () => {
    const s = await rawServer(() => Buffer.from("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n{"));
    try {
      const t = new HttpMailTransport(`http://127.0.0.1:${s.port}/send`, undefined, fetch, 3000, { guard: "off" });
      const err = await t.send(rec()).then(() => null, (e: Error) => e);
      expect(s.arrived()).toBe(1);
      expect(err).toBeTruthy();
      expect(err instanceof AmbiguousMailFailure, `truncated reply classified as: ${err?.constructor.name}: ${err?.message}`).toBe(true);
    } finally { s.close(); }
  });
  it("connection destroyed without any reply AFTER arrival is ambiguous", async () => {
    const s = await rawServer(() => null);
    try {
      const t = new HttpMailTransport(`http://127.0.0.1:${s.port}/send`, undefined, fetch, 3000, { guard: "off" });
      const err = await t.send(rec()).then(() => null, (e: Error) => e);
      expect(s.arrived()).toBe(1);
      expect(err instanceof AmbiguousMailFailure, `dropped connection classified as: ${err?.constructor.name}: ${err?.message}`).toBe(true);
    } finally { s.close(); }
  });
});

describe("outbox: identical real events collapse onto one id", () => {
  const input = { caseId: "case_acme", vendor: "Acme", recipient: "a@b.co", detail: { amount: 100, currency: "USD", reason: "above_approved_cap" } };
  it("two distinct identical decline events produce distinct records that are both deliverable", async () => {
    const o = new Outbox();
    const sends: string[] = [];
    const transport = { name: "http", send: async (r: any) => { sends.push(r.id); return { providerId: "p" } } };
    const d = new NotificationDispatcher(() => o, transport as any);
    const first = o.emit("purchase_declined", input);
    const second = o.emit("purchase_declined", input); // a SECOND, real, identical decline later
    await d.deliver(first);
    await d.deliver(second);
    expect(sends.length, "both real events should be delivered").toBe(2);
    expect(o.get(second.id)?.status).toBe("sent");
  });
});

describe("audit persistence: restart continuity and truncation", () => {
  it("chain continues across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const f = join(dir, "a.jsonl");
    const a = new AuditLog(f);
    a.append("one", {}, "case_acme");
    const b = new AuditLog(f); // simulated restart
    b.append("two", {}, "case_flowdesk");
    expect(verifyChain(b.list())).toEqual({ ok: true });
    expect(b.list()[1].caseId).toBe("case_flowdesk");
  });
  it("DOCUMENTED LIMIT: deleting the LAST entries is invisible to verifyChain", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const f = join(dir, "a.jsonl");
    const a = new AuditLog(f);
    a.append("one", {}, "c"); a.append("two", {}, "c"); a.append("three", {}, "c");
    const lines = readFileSync(f, "utf8").trim().split("\n");
    writeFileSync(f, lines.slice(0, 1).join("\n") + "\n"); // attacker/accident truncates the tail
    const b = new AuditLog(f);
    const v = verifyChain(b.list());
    expect(v.ok, "tail truncation is NOT detectable by the current chain design").toBe(true); // documents the gap
  });
});

describe("console input validation: category string reaches the page unescaped", () => {
  it("terms category accepts HTML markup (render sink must escape)", () => {
    const parsed = ExtractedTermsSchema.safeParse({ monthlyPrice: 1, annualPrice: 10, currency: "USD", category: "<svg onload=alert(1)>", noticeDays: 0 });
    expect(parsed.success).toBe(true); // schema allows markup; page.ts renders card controls unescaped
  });
});
