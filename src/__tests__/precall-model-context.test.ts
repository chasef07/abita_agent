import { initializeLogger } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { HOLLYWOOD_OFFICE_PHONE } from "../customers/abita/profile.js";
import {
  createInitialLookupChatContext,
  modelFacingLookupStatus,
  type ModelFacingLookupStatus,
} from "../runtime/precall-model-context.js";
import type { PhoneLookupResult } from "../state/call-state.js";

function messageText(status: ModelFacingLookupStatus): string[] {
  return createInitialLookupChatContext(status).items.flatMap((item) =>
    item.type === "message" && item.textContent ? [item.textContent] : [],
  );
}

describe("pre-call model context", () => {
  initializeLogger({ pretty: false, level: "silent" });

  it.each([
    [{ status: "verified" }, "single_match"],
    [{ status: "multiple_matches" }, "multiple_matches"],
    [{ status: "no_match" }, "no_match"],
    [{ status: "lookup_failed" }, "lookup_failed"],
  ] as const)("maps lookup status %s to %s", (lookup, expected) => {
    expect(
      modelFacingLookupStatus(lookup as NonNullable<PhoneLookupResult>),
    ).toBe(expected);
  });

  it("contains exactly the closed status and no private lookup data", () => {
    const phoneLookup: PhoneLookupResult = {
      status: "verified",
      patientId: "private-patient-id",
      name: "Santos, Maria",
      dob: "01/01/1980",
      phone: "+17275551212",
      insuranceCarrier: "Aetna",
      insPlanId: "private-plan-id",
      respPartyId: "private-party-id",
      routing: "all_three",
      allowedProviders: ["private-provider-reference"],
      routingAmbiguous: false,
      preauthRequired: false,
      appointmentsStatus: "found",
      appointments: [
        {
          id: 123,
          appointmentRef: "private-appointment-reference",
          cancellationToken: "private-cancellation-token",
          date: "2099-01-01",
          time: "9:30 AM",
          provider: "Dr. Private",
          type: "Follow-up",
          facility: "Hollywood",
          confirmed: true,
        },
      ],
    };
    const status = modelFacingLookupStatus(phoneLookup);
    const { agent } = createVoiceAgent(status, HOLLYWOOD_OFFICE_PHONE, {
      suppressGreeting: true,
    });
    const initialContext = agent.chatCtx.items.flatMap((item) =>
      item.type === "message" && item.textContent ? [item.textContent] : [],
    );
    const modelFacing = JSON.stringify({
      instructions: agent.instructions,
      initialContext,
    });

    expect(initialContext).toEqual(["single_match"]);
    for (const privateValue of [
      "private-patient-id",
      "Santos, Maria",
      "01/01/1980",
      "+17275551212",
      "Aetna",
      "private-plan-id",
      "private-party-id",
      "private-provider-reference",
      "private-appointment-reference",
      "private-cancellation-token",
      "2099-01-01",
      "Dr. Private",
    ]) {
      expect(modelFacing).not.toContain(privateValue);
    }
  });

  it("instructs the model to ask the exact privacy-safe identity question", () => {
    const { agent } = createVoiceAgent("single_match", HOLLYWOOD_OFFICE_PHONE, {
      suppressGreeting: true,
    });

    expect(agent.instructions).toContain(
      "If the caller is speaking English and has not supplied the patient's first name",
    );
    expect(agent.instructions).toContain(
      'For single_match in English, say exactly: "I see a record associated with this number. Could you spell the patient\'s first name?"',
    );
    expect(agent.instructions).toContain(
      'For multiple_matches in English, say exactly: "I see a few records associated with this number. Could you spell the patient\'s first name?"',
    );
    expect(agent.instructions).toContain(
      "If the caller already supplied the patient's first name, call resolve_patient with it instead of asking again.",
    );
  });

  it("uses one system message for every allowed status", () => {
    for (const status of [
      "single_match",
      "multiple_matches",
      "no_match",
      "lookup_failed",
    ] satisfies ModelFacingLookupStatus[]) {
      const chatCtx = createInitialLookupChatContext(status);

      expect(messageText(status)).toEqual([status]);
      expect(chatCtx.items).toHaveLength(1);
      expect(chatCtx.items[0]).toMatchObject({
        type: "message",
        role: "system",
        textContent: status,
      });
    }
  });
});
