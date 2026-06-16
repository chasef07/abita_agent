import { describe, expect, it } from "vitest";
import {
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customer/profile.js";
import {
  SWEETWATER_VOICE_EXPERIMENT_ID,
  assignSweetwaterVoiceExperiment,
  isSweetwaterVoiceExperimentTrunk,
} from "../voice-experiment.js";

describe("Sweetwater voice experiment", () => {
  it("gates assignment to Sweetwater trunks", () => {
    for (const trunkPhone of SWEETWATER_TRUNK_PHONES) {
      expect(isSweetwaterVoiceExperimentTrunk(trunkPhone)).toBe(true);
    }

    expect(isSweetwaterVoiceExperimentTrunk("+17275919997")).toBe(false);
  });

  it("sticks assignment by caller phone across Sweetwater calls", () => {
    const first = assignSweetwaterVoiceExperiment({
      callId: "call-a",
      callerPhone: "(555) 123-4567",
      trunkPhone: SWEETWATER_OFFICE_PHONE,
    });
    const second = assignSweetwaterVoiceExperiment({
      callId: "call-b",
      callerPhone: "+1 555 123 4567",
      trunkPhone: "7864657475",
    });

    expect(first).toMatchObject({
      assignment: "sticky_caller_phone_hash",
      experimentId: SWEETWATER_VOICE_EXPERIMENT_ID,
      scope: "sweetwater",
    });
    expect(second?.variant).toBe(first?.variant);
    expect(second?.assignmentHash).toBe(first?.assignmentHash);
    expect(first?.assignmentHash).not.toContain("555");
  });

  it("falls back to call id when the caller phone is not available", () => {
    const assignment = assignSweetwaterVoiceExperiment({
      callId: "room-call-123",
      callerPhone: "sip-participant",
      trunkPhone: SWEETWATER_OFFICE_PHONE,
    });

    expect(assignment).toMatchObject({
      assignment: "call_id_hash",
      experimentId: SWEETWATER_VOICE_EXPERIMENT_ID,
      provider: assignment?.variant,
      scope: "sweetwater",
    });
  });

  it("does not assign non-Sweetwater calls", () => {
    expect(
      assignSweetwaterVoiceExperiment({
        callId: "call-a",
        callerPhone: "+15551234567",
        trunkPhone: "+17275919997",
      }),
    ).toBeNull();
  });
});
