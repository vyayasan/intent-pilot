import { describe, it, expect } from "vitest";
import { canTransition, isAccepted, isTerminal, legalTransitions } from "../src/domain/stateMachine.js";

describe("card transaction state machine", () => {
  it("treats CLEARING as accepted and never waits for APPROVED", () => {
    expect(isAccepted("CLEARING")).toBe(true);
    expect(isAccepted("PENDING")).toBe(false);
  });
  it("ends a declined authorization in FAILED", () => {
    expect(canTransition("PENDING", "FAILED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
  });
  it("allows capture, then reverse or refund, and nothing else", () => {
    expect(legalTransitions("PENDING")).toEqual(["CLEARING", "FAILED"]);
    expect(legalTransitions("CLEARING")).toEqual(["REVERSED", "REFUNDED"]);
    expect(canTransition("FAILED", "CLEARING")).toBe(false);
    expect(canTransition("REVERSED", "REFUNDED")).toBe(false);
  });
});
