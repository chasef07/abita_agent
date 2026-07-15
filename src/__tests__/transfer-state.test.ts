import { describe, expect, it } from "vitest";
import { createTestCallState } from "./support/call-state.js";
import {
  acceptTransfer,
  beginTransfer,
  markTransferAmbiguous,
  recordLatestUserTranscript,
  transferIsAccepted,
  transferStatus,
} from "../state/call-lifecycle.js";

describe("transfer state", () => {
  it("owns the transfer lifecycle behind one state interface", () => {
    const state = createTestCallState();

    expect(transferStatus(state)).toBe("idle");
    expect(transferIsAccepted(state)).toBe(false);

    beginTransfer(state);
    expect(transferStatus(state)).toBe("pending");

    markTransferAmbiguous(state);
    expect(transferStatus(state)).toBe("ambiguous");
    expect(transferIsAccepted(state)).toBe(false);

    acceptTransfer(state);
    expect(transferStatus(state)).toBe("accepted");
    expect(transferIsAccepted(state)).toBe(true);

    recordLatestUserTranscript(state, "I need to reschedule.");
    expect(state.runtime.latestUserTranscript).toBe("I need to reschedule.");
  });
});
