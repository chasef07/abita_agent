import { describe, expect, it } from "vitest";
import { getOfficeProfile } from "../customers/abita/profile.js";
import { createTestCallState } from "./support/call-state.js";
import {
  acceptTransfer,
  activateOffice,
  beginTransfer,
  markTransferAmbiguous,
  transferIsAccepted,
  transferStatus,
} from "../state/call-lifecycle.js";

describe("call lifecycle state", () => {
  it("tracks the transfer lifecycle", () => {
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
  });

  it("activates the office used for middleware routing", () => {
    const state = createTestCallState();
    const office = getOfficeProfile("crystal-river");
    activateOffice(state, office);
    expect(state.office.activeKey).toBe("crystal-river");
  });
});
