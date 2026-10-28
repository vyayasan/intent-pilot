// Case-7 drill seam: ONE controlled ambiguous card-creation outcome against the real provider.
//
// What this does: wraps the live IssuingGateway and, for a single createCard call, performs the
// REAL vendor request exactly as the unwrapped gateway would (same origin, same payload, same
// request id), waits for the provider to commit, then DISCARDS the provider's response and throws
// a transport-style error instead. From the console's perspective the outcome is genuinely
// unknown: the provider may have created the card. The existing lock path (createCardUnresolved)
// engages, and only a real provider card listing via /api/reconcile-card can clear it.
//
// Hard boundaries (reviewer preconditions, 27 Oct):
// - Never in production: the factory throws when production boot is on.
// - Single attempt: after one dropped create the wrapper passes everything through; the console's
//   own lock blocks further creates until reconcile anyway.
// - The request itself is never altered, delayed, or dropped - the vendor receives it unchanged.
//   Only the RESPONSE is dropped, after the vendor has committed.
// - Nothing about the card (id, controls) is retained anywhere: the honest recovery path is the
//   real provider card listing, not stashed drill knowledge.
// - No credential, header, or request/response body logging. The thrown error names the drill.
// - The origin is unchanged: the inner gateway's client still speaks to its configured endpoint
//   (api.sandbox.airwallex.com). This is a seam at the gateway, not an SSRF guard bypass.
// - Orphan cleanup happens through the real reconcile-card flow (freeze-stray / adopt with
//   control verification), never through drill-side shortcuts.
import type { IssuingGateway } from "../sim/simGateway.js";
import type { Card } from "../domain/types.js";

export class DropCreateResponseGateway implements IssuingGateway {
  private armed: boolean;
  constructor(private readonly inner: IssuingGateway, arm = true) {
    this.armed = arm;
  }
  /** True after the one instrumented drop has fired; the wrapper is then transparent. */
  get spent(): boolean { return !this.armed; }
  createCard(...args: Parameters<IssuingGateway["createCard"]>): Promise<Card> {
    if (!this.armed) return Promise.resolve(this.inner.createCard(...args));
    this.armed = false; // single attempt, even if the call itself fails genuinely
    // Real vendor commit, unchanged request. If the provider resolves with a card payload, the
    // response is discarded and the console sees a transport-style unknown outcome instead.
    return Promise.resolve(this.inner.createCard(...args)).then((card) => {
      void card;
      throw new Error("network error: response lost after the provider call (case-7 instrumented drop; the request reached the vendor unchanged, the response was deliberately discarded - outcome genuinely unknown to the console)");
    });
  }
  // Everything else delegates untouched.
  createCardholder(...args: Parameters<IssuingGateway["createCardholder"]>) { return this.inner.createCardholder(...args); }
  freezeCard(...args: Parameters<IssuingGateway["freezeCard"]>) { return this.inner.freezeCard(...args); }
  unfreezeCard(...args: Parameters<IssuingGateway["unfreezeCard"]>) { return this.inner.unfreezeCard(...args); }
  closeCard(...args: Parameters<IssuingGateway["closeCard"]>) { return this.inner.closeCard(...args); }
  authorize(...args: Parameters<IssuingGateway["authorize"]>) { return this.inner.authorize(...args); }
  capture(...args: Parameters<IssuingGateway["capture"]>) { return this.inner.capture(...args); }
  reverse(...args: Parameters<IssuingGateway["reverse"]>) { return this.inner.reverse(...args); }
  refund(...args: Parameters<IssuingGateway["refund"]>) { return this.inner.refund(...args); }
  listTransactions(...args: Parameters<IssuingGateway["listTransactions"]>) { return this.inner.listTransactions(...args); }
  listCards(...args: Parameters<IssuingGateway["listCards"]>) { return this.inner.listCards(...args); }
  readCardControls(...args: Parameters<IssuingGateway["readCardControls"]>) { return this.inner.readCardControls(...args); }
  setCardControls(...args: Parameters<IssuingGateway["setCardControls"]>) { return this.inner.setCardControls(...args); }
  findCardholderByEmail(...args: Parameters<IssuingGateway["findCardholderByEmail"]>) { return this.inner.findCardholderByEmail(...args); }
  getTransaction(...args: Parameters<IssuingGateway["getTransaction"]>) { return this.inner.getTransaction(...args); }
  get supportsAuthoritativeAbsence(): boolean | undefined { return this.inner.supportsAuthoritativeAbsence; }
}
