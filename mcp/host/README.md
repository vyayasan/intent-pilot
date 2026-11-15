# Local MCP Apps example host

This is an adapted official example host retained with its upstream license/notices. It is used to inspect the separate read-only IntentPay MCP Apps prototype, not to approve or run purchases.

Start it through the parent [`mcp/README.md`](../README.md): from `mcp/`, run `npm ci`, `npm run build`, then `npm start` with your own sandbox configuration. The adapted host runs on `http://127.0.0.1:38180`, its isolated sandbox on port 38181, and the MCP endpoint on port 38101. Only `show_review` is exposed.

This local example host is not a Claude deployment and proves no other host's compatibility. The supplied snapshot is saved synthetic scenario data; current card and ledger reads require the matching sandbox account. Root repository tests do not call the live sandbox.

Key files: `src/implementation.ts` (host/server bridge), `src/index.tsx` (host UI), `src/sandbox.ts` (isolated iframe proxy), `serve.ts` (loopback servers). The two-iframe pattern isolates untrusted app content from the host.

Upstream provenance: MCP Apps SDK v2.0.4, commit `7af9a75da720b8a81be0f9aff47b25f75e9530ad`. The upstream `LICENSE` is retained unchanged. IntentPay adaptations do not relicense upstream code.
