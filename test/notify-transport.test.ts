import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Outbox } from "../src/notify/outbox.js";
import { NotificationDispatcher } from "../src/notify/dispatcher.js";
import { AllowlistMailTransport, AmbiguousMailFailure, DefiniteMailFailure, DryRunTransport, HttpMailTransport } from "../src/notify/transport.js";

const input = { caseId: "case_acme", vendor: "Acme Analytics", recipient: "sandi@vyayasan.com", detail: { amount: 100, currency: "USD", cap: 100 } };
const emit = (o: Outbox) => o.emit("purchase_cleared", input);

describe("email transport seam", () => {
  it("preview default: no transport, record stays preview, nothing is sent", async () => {
    const outbox = new Outbox();
    const d = new NotificationDispatcher(() => outbox, null);
    const rec = emit(outbox);
    await d.deliver(rec);
    expect(outbox.get(rec.id)?.status).toBe("preview");
  });

  it("dry-run validates and marks the record dry-run with a receipt", async () => {
    const outbox = new Outbox();
    const d = new NotificationDispatcher(() => outbox, new DryRunTransport());
    const rec = emit(outbox);
    await d.deliver(rec);
    const after = outbox.get(rec.id)!;
    expect(after.status).toBe("dry-run");
    expect(after.receipt?.transport).toBe("dry-run");
    expect(after.receipt?.providerId).toMatch(/^dry_/);
  });

  it("never sends the same record twice, even after a restart (persisted status)", async () => {
    const outbox = new Outbox();
    let sends = 0;
    const counting = { name: "dry-run", async send() { sends++; return { providerId: "x" }; } };
    const d = new NotificationDispatcher(() => outbox, { ...counting, name: "http", send: counting.send });
    const rec = emit(outbox);
    await d.deliver(rec);
    expect(sends).toBe(1);
    // simulate restart: a fresh outbox restores persisted records, dispatcher re-attempts
    const restored = new Outbox();
    restored.restore(outbox.list());
    const d2 = new NotificationDispatcher(() => restored, { ...counting, name: "http", send: counting.send });
    await d2.deliver(restored.get(rec.id)!);
    expect(sends).toBe(1); // delivered once, never again
  });

  it("failed delivery stays failed for operator review - no blind resend", async () => {
    const outbox = new Outbox();
    let calls = 0;
    const flaky = { name: "http", async send() { calls++; throw new Error("HTTP 503"); } };
    const d = new NotificationDispatcher(() => outbox, flaky);
    const rec = emit(outbox);
    await d.deliver(rec);
    const failed = outbox.get(rec.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.receipt?.error).toContain("503");
    await d.deliver(rec); // must NOT retry automatically
    expect(calls).toBe(1);
  });

  it("dry-run rejects a bad recipient instead of pretending to deliver", async () => {
    const outbox = new Outbox();
    const d = new NotificationDispatcher(() => outbox, new DryRunTransport());
    const rec = outbox.emit("purchase_cleared", { ...input, recipient: "not-an-email" });
    await d.deliver(rec);
    expect(outbox.get(rec.id)?.status).toBe("failed");
  });

  it("http transport posts the record and records the provider id", async () => {
    let got: { body?: string; auth?: string } = {};
    const srv: Server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { got = { body: b, auth: String(req.headers.authorization ?? "") }; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ accepted: true, id: "msg_123" })); });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/send`;
    try {
      const outbox = new Outbox();
      const d = new NotificationDispatcher(() => outbox, new HttpMailTransport(url, "tok"));
      const rec = emit(outbox);
      await d.deliver(rec);
      const after = outbox.get(rec.id)!;
      expect(after.status).toBe("sent");
      expect(after.receipt?.providerId).toBe("msg_123");
      expect(got.auth).toBe("Bearer tok");
      const posted = JSON.parse(got.body!);
      expect(posted.to).toBe("sandi@vyayasan.com");
      expect(posted.sha256).toBe(rec.sha256);
    } finally { srv.close(); }
  });

  it("http transport failure records failed, never throws into the workflow", async () => {
    const srv: Server = createServer((_req, res) => { res.writeHead(500); res.end("down"); });
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/send`;
    try {
      const outbox = new Outbox();
      const d = new NotificationDispatcher(() => outbox, new HttpMailTransport(url));
      const rec = emit(outbox);
      await d.deliver(rec);
      expect(outbox.get(rec.id)?.status).toBe("failed");
      expect(outbox.get(rec.id)?.receipt?.error).toContain("HTTP 500");
    } finally { srv.close(); }
  });

  it("statuses survive restore: sent stays sent, failed stays failed", () => {
    const outbox = new Outbox();
    const a = emit(outbox);
    outbox.mark(a.id, "sent", { transport: "http", status: "sent", at: new Date().toISOString(), providerId: "m1" });
    const b = outbox.emit("purchase_declined", { ...input, detail: { amount: 101, currency: "USD", reason: "above_approved_cap" } });
    outbox.mark(b.id, "failed", { transport: "http", status: "failed", at: new Date().toISOString(), error: "HTTP 500" });
    const restored = new Outbox();
    restored.restore(outbox.list());
    expect(restored.get(a.id)?.status).toBe("sent");
    expect(restored.get(b.id)?.status).toBe("failed");
    expect(restored.get(a.id)?.receipt?.providerId).toBe("m1");
  });
});

describe("mode changes and promotion", () => {
  it("a dry-run record is NOT auto-sent after switching to a real transport", async () => {
    const outbox = new Outbox();
    const rec = emit(outbox);
    await new NotificationDispatcher(() => outbox, new DryRunTransport()).deliver(rec);
    expect(outbox.get(rec.id)?.status).toBe("dry-run");
    // operator restarts with a real transport: no blind first send
    let sends = 0;
    const real = { name: "http", async send() { sends++; return { providerId: "p" }; } };
    await new NotificationDispatcher(() => outbox, real).deliver(rec);
    expect(sends).toBe(0);
    expect(outbox.get(rec.id)?.status).toBe("dry-run");
  });

  it("promote refuses without a real transport and refuses non-dry-run records", async () => {
    const outbox = new Outbox();
    const rec = emit(outbox);
    const dry = new NotificationDispatcher(() => outbox, new DryRunTransport());
    await expect(dry.promote(rec.id, { operator: "op" })).rejects.toThrow("real email transport");
    const real = new NotificationDispatcher(() => outbox, { name: "http", async send() { return {}; } });
    await expect(real.promote(rec.id, { operator: "op" })).rejects.toThrow("only a dry-run record");
  });

  it("promote sends once, stamps the receipt, and writes an audit record", async () => {
    const outbox = new Outbox();
    const rec = emit(outbox);
    await new NotificationDispatcher(() => outbox, new DryRunTransport()).deliver(rec);
    let sends = 0;
    const audits: [string, Record<string, unknown>][] = [];
    const d = new NotificationDispatcher(
      () => outbox,
      { name: "http", async send() { sends++; return { providerId: "p9" }; } },
      () => new Date("2026-10-27T07:00:00Z"),
      (ev, detail) => audits.push([ev, detail])
    );
    const after = await d.promote(rec.id, { operator: "console-operator" });
    expect(sends).toBe(1);
    expect(after?.status).toBe("sent");
    expect(after?.receipt?.providerId).toBe("p9");
    expect(after?.receipt?.promoted).toEqual({ from: "dry-run", at: "2026-10-27T07:00:00.000Z", operator: "console-operator" });
    expect(after?.receipt?.ambiguous).toBe(false);
    expect(audits).toEqual([["email_promoted", { notificationId: rec.id, operator: "console-operator", from: "dry-run", transport: "http" }]]);
    // promotion sticks: no resend by deliver() and no double promotion
    await d.deliver(rec);
    await expect(d.promote(rec.id, { operator: "console-operator" })).rejects.toThrow("only a dry-run record");
    expect(sends).toBe(1);
  });
});

describe("failure classification: ambiguous vs definite", () => {
  it("a timeout is AMBIGUOUS (may have been sent) and is never retried automatically", async () => {
    const srv: Server = createServer(() => { /* never responds */ });
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/send`;
    try {
      const outbox = new Outbox();
      let calls = 0;
      const countingFetch: typeof fetch = (async (...a: Parameters<typeof fetch>) => { calls++; return fetch(...a); }) as typeof fetch;
      const d = new NotificationDispatcher(() => outbox, new HttpMailTransport(url, undefined, countingFetch, 100));
      const rec = emit(outbox);
      await d.deliver(rec);
      const after = outbox.get(rec.id)!;
      expect(after.status).toBe("failed");
      expect(after.receipt?.ambiguous).toBe(true);
      expect(after.receipt?.error).toContain("timeout");
      await d.deliver(rec); // no blind retry of an ambiguous outcome
      expect(calls).toBe(1);
    } finally { srv.close(); }
  });

  it("a 5xx AFTER the request arrived is AMBIGUOUS - a provider may have sent before failing", async () => {
    // the fake provider accepts and "sends" every request, then answers 500: without a documented
    // delivery-receipt contract the console must treat this as unknown, and must never resend.
    let delivered = 0;
    const srv: Server = createServer((_req, res) => { delivered++; res.writeHead(500); res.end("down"); });
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/send`;
    try {
      const outbox = new Outbox();
      const d = new NotificationDispatcher(() => outbox, new HttpMailTransport(url));
      const rec = emit(outbox);
      await d.deliver(rec);
      const after = outbox.get(rec.id)!;
      expect(after.status).toBe("failed");
      expect(after.receipt?.ambiguous).toBe(true);
      expect(after.receipt?.error).toContain("HTTP 500");
      expect(after.receipt?.error).toContain("may have been sent");
      await d.deliver(rec); // no blind resend of a maybe-sent email
      expect(delivered).toBe(1);
    } finally { srv.close(); }
  });

  it("a bare 4xx after the request arrived is AMBIGUOUS - a side effect can precede the answer", async () => {
    // adversarial: the fake provider "sends" as a side effect, THEN answers 400 with no receipt
    let delivered = 0;
    const srv: Server = createServer((_req, res) => { delivered++; res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "bad request" })); });
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/send`;
    try {
      const outbox = new Outbox();
      const d = new NotificationDispatcher(() => outbox, new HttpMailTransport(url));
      const rec = emit(outbox);
      await d.deliver(rec);
      const after = outbox.get(rec.id)!;
      expect(after.status).toBe("failed");
      expect(after.receipt?.ambiguous).toBe(true);
      expect(after.receipt?.error).toContain("HTTP 400");
      expect(after.receipt?.error).toContain("may have been sent");
      await d.deliver(rec); // no blind resend
      expect(delivered).toBe(1);
    } finally { srv.close(); }
  });

  it("a 4xx WITH a validated delivery-rejection receipt is DEFINITE - not sent", async () => {
    const srv: Server = createServer((_req, res) => { res.writeHead(422, { "content-type": "application/json" }); res.end(JSON.stringify({ rejected: true, reason: "unknown recipient domain" })); });
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/send`;
    try {
      const outbox = new Outbox();
      const d = new NotificationDispatcher(() => outbox, new HttpMailTransport(url));
      const rec = emit(outbox);
      await d.deliver(rec);
      const after = outbox.get(rec.id)!;
      expect(after.status).toBe("failed");
      expect(after.receipt?.ambiguous).toBe(false);
      expect(after.receipt?.error).toContain("unknown recipient domain");
      expect(after.receipt?.error).toContain("not sent");
    } finally { srv.close(); }
  });

  it("a malformed rejection receipt does not count - still ambiguous", async () => {
    const srv: Server = createServer((_req, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ rejected: true })); }); // no reason
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/send`;
    try {
      const outbox = new Outbox();
      const d = new NotificationDispatcher(() => outbox, new HttpMailTransport(url));
      const rec = emit(outbox);
      await d.deliver(rec);
      expect(outbox.get(rec.id)?.receipt?.ambiguous).toBe(true);
    } finally { srv.close(); }
  });

  it("a refused connection is DEFINITE (request never left)", async () => {
    const srv: Server = createServer(() => {});
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const outbox = new Outbox();
    const d = new NotificationDispatcher(() => outbox, new HttpMailTransport(`http://127.0.0.1:${port}/send`));
    const rec = emit(outbox);
    await d.deliver(rec);
    const after = outbox.get(rec.id)!;
    expect(after.status).toBe("failed");
    expect(after.receipt?.ambiguous).toBe(false);
    expect(after.receipt?.error).toMatch(/never left.*ECONNREFUSED/);
  });
});

  it("a client-side pre-send rejection (blocked port) is DEFINITE, not ambiguous", async () => {
    const outbox = new Outbox();
    const d = new NotificationDispatcher(() => outbox, new HttpMailTransport("http://127.0.0.1:9/dead")); // port 9 is on the fetch blocklist
    const rec = emit(outbox);
    await d.deliver(rec);
    const after = outbox.get(rec.id)!;
    expect(after.status).toBe("failed");
    expect(after.receipt?.ambiguous).toBe(false);
    expect(after.receipt?.error).toContain("never left");
  });

describe("http transport production SSRF guard", () => {
  it("refuses a non-https endpoint in production before any network activity", async () => {
    let called = 0;
    const countingFetch = (async (...a: Parameters<typeof fetch>) => { called++; return fetch(...a); }) as typeof fetch;
    const t = new HttpMailTransport("http://mail.example.com/send", undefined, countingFetch, 10_000, { guard: "production" });
    await expect(t.send(emit(new Outbox()))).rejects.toThrow(/must be https/);
    expect(called).toBe(0);
  });

  it("refuses a private literal hostname in production before any network activity", async () => {
    let called = 0;
    const countingFetch = (async (...a: Parameters<typeof fetch>) => { called++; return fetch(...a); }) as typeof fetch;
    const t = new HttpMailTransport("https://169.254.169.254/latest", undefined, countingFetch, 10_000, { guard: "production" });
    await expect(t.send(emit(new Outbox()))).rejects.toThrow(/private\/internal/);
    expect(called).toBe(0);
  });

  it("refuses when DNS resolves a public-looking name to a private address (resolution-time guard)", async () => {
    // DNS-rebinding shape: the hostname passes every literal check, the resolver answers internal.
    const t = new HttpMailTransport("https://guard-test.example/send", undefined, fetch, 10_000, {
      guard: "production",
      lookupAll: async () => [{ address: "10.0.0.7", family: 4 }]
    });
    await expect(t.send(emit(new Outbox()))).rejects.toThrow(/resolves to a private\/internal address/);
  });

  it("never follows redirects: a 302 is not followed and classifies ambiguous", async () => {
    let hits = 0;
    const srv: Server = createServer((req, res) => {
      hits++;
      if (req.url === "/send") { res.writeHead(302, { location: "/target" }).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accepted: true, id: "x" }));
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const outbox = new Outbox();
      const d = new NotificationDispatcher(() => outbox, new HttpMailTransport(`http://127.0.0.1:${port}/send`));
      const rec = emit(outbox);
      await d.deliver(rec);
      const after = outbox.get(rec.id)!;
      expect(after.status).toBe("failed");
      expect(after.receipt?.ambiguous).toBe(true); // response arrived, no valid receipt -> unknown
      expect(hits).toBe(1); // /target was never requested - the redirect was not followed
    } finally { srv.close(); }
  });
});

describe("send allowlist (hard boundary)", () => {
  const sending = () => ({ calls: 0, name: "gmail", async send() { this.calls++; return { providerId: "msg_1" }; } });
  const approvedInput = { caseId: "case_1", vendor: "Todoist", recipient: "sandi@vyayasan.com", detail: { approver: "sandi@vyayasan.com", cadence: "annual", cap: 60, currency: "USD", categories: "software", termsHash: "h" } };

  it("delivers an allowlisted kind to the fixed recipient and withholds every other kind, visibly and audited", async () => {
    const inner = sending();
    const t = new AllowlistMailTransport(inner as never, { kinds: ["approval_issued", "card_created"], to: "sandi@vyayasan.com" });
    const outbox = new Outbox();
    const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const d = new NotificationDispatcher(() => outbox, t as never, () => new Date(), (event, detail) => audits.push({ event, detail }));
    const ok = outbox.emit("approval_issued", approvedInput);
    await d.deliver(ok);
    expect(outbox.get(ok.id)?.status).toBe("sent");
    expect(inner.calls).toBe(1);
    // An error/cleanup path emitting another kind (e.g. gateway_outage) stays UNSENT
    const blocked = outbox.emit("gateway_outage", { ...approvedInput, detail: { ...approvedInput.detail, error: "HTTP 400" } });
    await d.deliver(blocked);
    const b = outbox.get(blocked.id)!;
    expect(b.status).toBe("failed"); // visible on the record, not a silent drop
    expect(b.receipt?.ambiguous).toBe(false);
    expect(b.receipt?.error).toMatch(/outside the approved send allowlist - withheld/);
    expect(inner.calls).toBe(1); // the real transport was never invoked
    const w = audits.filter((a) => a.event === "email_withheld");
    expect(w).toHaveLength(1);
    expect(w[0].detail.kind).toBe("gateway_outage");
  });

  it("count discipline: after the approved number of sends, repeated approve/create events are withheld", async () => {
    const inner = sending();
    const t = new AllowlistMailTransport(inner as never, { kinds: ["approval_issued", "card_created"], to: "sandi@vyayasan.com", maxSends: 2 });
    const outbox = new Outbox();
    const d = new NotificationDispatcher(() => outbox, t as never);
    const a1 = outbox.emit("approval_issued", approvedInput);
    await d.deliver(a1);
    const c1 = outbox.emit("card_created", { ...approvedInput, detail: { ...approvedInput.detail, limit: 60, currencies: "USD" } });
    await d.deliver(c1);
    // a repeated event (e.g. a second approval) exceeds the approved count
    const a2 = outbox.emit("approval_issued", approvedInput);
    await d.deliver(a2);
    expect(outbox.get(a1.id)?.status).toBe("sent");
    expect(outbox.get(c1.id)?.status).toBe("sent");
    expect(outbox.get(a2.id)?.status).toBe("failed");
    expect(outbox.get(a2.id)?.receipt?.error).toMatch(/approved send count \(2\) already reached - withheld/);
    expect(inner.calls).toBe(2);
  });

  it("count discipline: an AMBIGUOUS outcome consumes budget (may have been sent), a definite failure does not", async () => {
    let behavior: "ambiguous" | "definite" | "ok" = "ambiguous";
    const inner = { calls: 0, name: "gmail", async send() { this.calls++; if (behavior === "ambiguous") throw new AmbiguousMailFailure("timeout - may have been sent"); if (behavior === "definite") throw new DefiniteMailFailure("refused - not sent"); return { providerId: "m" }; } };
    const t = new AllowlistMailTransport(inner as never, { kinds: ["approval_issued", "card_created"], to: "sandi@vyayasan.com", maxSends: 2 });
    const outbox = new Outbox();
    const d = new NotificationDispatcher(() => outbox, t as never);
    // first slot goes ambiguous: consumes one of two, outcome unknown, never retried blindly
    const r1 = outbox.emit("approval_issued", approvedInput);
    await d.deliver(r1);
    expect(outbox.get(r1.id)?.status).toBe("failed");
    expect(outbox.get(r1.id)?.receipt?.ambiguous).toBe(true);
    // a definite failure does NOT consume
    behavior = "definite";
    const r2 = outbox.emit("card_created", { ...approvedInput, detail: { ...approvedInput.detail, limit: 60, currencies: "USD" } });
    await d.deliver(r2);
    expect(outbox.get(r2.id)?.receipt?.ambiguous).toBe(false);
    // one budget left: a success takes it
    behavior = "ok";
    const r3 = outbox.emit("card_created", { ...approvedInput, detail: { ...approvedInput.detail, limit: 60, currencies: "USD" } });
    await d.deliver(r3);
    expect(outbox.get(r3.id)?.status).toBe("sent");
    // budget exhausted by ambiguous(1) + sent(1): the next record is withheld
    const r4 = outbox.emit("card_created", { ...approvedInput, detail: { ...approvedInput.detail, limit: 60, currencies: "USD" } });
    await d.deliver(r4);
    expect(outbox.get(r4.id)?.receipt?.error).toMatch(/approved send count \(2\) already reached - withheld/);
    expect(inner.calls).toBe(3); // ambiguous + definite + success; the withheld record never reached the provider
  });

  it("case scope: records for any other case are withheld", async () => {
    const inner = sending();
    const t = new AllowlistMailTransport(inner as never, { kinds: ["approval_issued"], to: "sandi@vyayasan.com", caseId: "case_1" });
    const outbox = new Outbox();
    const d = new NotificationDispatcher(() => outbox, t as never);
    const other = outbox.emit("approval_issued", { ...approvedInput, caseId: "case_2" });
    await d.deliver(other);
    expect(outbox.get(other.id)?.status).toBe("failed");
    expect(outbox.get(other.id)?.receipt?.error).toMatch(/case is outside the approved send allowlist - withheld/);
    expect(inner.calls).toBe(0);
  });

  it("state semantics: a record emitted under preview mode stays preview and is never sent by the preview boot", async () => {
    const outbox = new Outbox();
    const previewDispatcher = new NotificationDispatcher(() => outbox, null);
    const rec = outbox.emit("approval_issued", approvedInput); // fresh record starts as preview
    await previewDispatcher.deliver(rec);
    expect(outbox.get(rec.id)?.status).toBe("preview"); // preview means nothing is sent, ever, in this boot
    // and the send allowlist does not gate fresh records by their initial preview status:
    // a fresh allowed record under a live gated transport reaches the transport and sends
    const inner = sending();
    const t = new AllowlistMailTransport(inner as never, { kinds: ["approval_issued"], to: "sandi@vyayasan.com" });
    const outbox2 = new Outbox();
    const d2 = new NotificationDispatcher(() => outbox2, t as never);
    const fresh = outbox2.emit("approval_issued", approvedInput);
    await d2.deliver(fresh);
    expect(outbox2.get(fresh.id)?.status).toBe("sent");
  });

  it("blocks a different recipient even for an allowlisted kind", async () => {
    const inner = sending();
    const t = new AllowlistMailTransport(inner as never, { kinds: ["approval_issued"], to: "sandi@vyayasan.com" });
    const outbox = new Outbox();
    const d = new NotificationDispatcher(() => outbox, t as never);
    const rec = outbox.emit("approval_issued", { ...approvedInput, recipient: "someone-else@example.com" });
    await d.deliver(rec);
    expect(outbox.get(rec.id)?.status).toBe("failed");
    expect(inner.calls).toBe(0);
  });

  it("matches the fixed recipient case-insensitively and keeps the inner transport name", async () => {
    const inner = sending();
    const t = new AllowlistMailTransport(inner as never, { to: "Sandi@Vyayasan.com" });
    expect(t.name).toBe("gmail");
    const outbox = new Outbox();
    const d = new NotificationDispatcher(() => outbox, t as never);
    const rec = outbox.emit("approval_issued", approvedInput);
    await d.deliver(rec);
    expect(outbox.get(rec.id)?.status).toBe("sent");
  });
});
