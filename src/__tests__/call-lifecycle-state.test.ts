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

  it("activates an office and initializes its middleware phone once", () => {
    const state = createTestCallState();
    const office = getOfficeProfile("crystal-river");

    activateOffice(state, office);

    expect(state.office.activeKey).toBe("crystal-river");
    expect(state.office.phoneOverrides["crystal-river"]).toBe(
      office.amdOfficePhone,
    );

    state.office.phoneOverrides["crystal-river"] = "+17275550199";
    activateOffice(state, office);
    expect(state.office.phoneOverrides["crystal-river"]).toBe("+17275550199");
  });
});
