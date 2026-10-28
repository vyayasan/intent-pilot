/** Regression probes for the independent review fixes (builder-owned, reviewer findings F1-F7). */
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { HttpMailTransport } from "../src/notify/transport.js";
import { Outbox } from "../src/notify/outbox.js";
import { NotificationDispatcher } from "../src/notify/dispatcher.js";

const input = { caseId: "case_acme", vendor: "Acme", recipient: "sandi@vyayasan.com", detail: { amount: 100, currency: "USD", cap: 100 } };
const emit = (o: Outbox) => o.emit("purchase_cleared", input);

describe("F2: a 2xx with an unreadable receipt body is AMBIGUOUS, never 'sent'", () => {
  it("bare 200 with garbage body -> failed + ambiguous", async () => {
    const srv: Server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }).end("ok but not json"); });
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const outbox = new Outbox();
      const d = new NotificationDispatcher(() => outbox, new HttpMailTransport(`http://127.0.0.1:${port}/send`));
      const rec = emit(outbox);
      await d.deliver(rec);
      const after = outbox.get(rec.id)!;
      expect(after.status).toBe("failed");
      expect(after.receipt?.ambiguous).toBe(true);
      expect(after.receipt?.error).toMatch(/unreadable receipt/);
    } finally { srv.close(); }
  });
});

describe("F7: page sinks escape all case/card-derived control fields", () => {
  it("page.ts source has no unescaped interpolation of intent/card control fields", () => {
    const src = readFileSync("src/console/page.ts", "utf8");
    // Any interpolation of these attacker-influenced fields must be inside esc(...)
    const raw = src.match(/'\s*\+\s*(?!esc\()c\.(intent|card\.controls)\.[a-zA-Z.()]+/g) ?? [];
    const unescaped = raw.filter((x) => !x.includes("esc("));
    expect(unescaped, `unescaped sinks: ${unescaped.join(", ")}`).toEqual([]);
  });
});
