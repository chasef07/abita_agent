import { describe, expect, it } from "vitest";
import { getOfficeConfigByPhone } from "../customers/profile.js";
import { createInitialCallState } from "../state/initial-call-state.js";
import type {
  PhoneLookupResult,
  PreCallLookupTelemetry,
} from "../state/call-state.js";

const callerPhone = "+17275551212";
const trunkPhone = "+17275919997";
const call = {
  callId: "call-123",
  callerPhone,
  trunkPhone,
  sipRoomName: "room-123",
  sipParticipantIdentity: "sip-caller-123",
};
const voiceLanguage = {
  current: "en" as const,
  ttsProvider: "rime" as const,
  ttsLanguage: "eng" as const,
  speaker: "astra",
};

function bootstrap(
  phoneLookup: PhoneLookupResult,
  telemetry: PreCallLookupTelemetry = phoneLookup
    ? {
        status: phoneLookup.status,
        durationMs: phoneLookup.lookupDurationMs ?? null,
      }
    : { status: "not_attempted", durationMs: null },
) {
  return {
    office: getOfficeConfigByPhone(trunkPhone),
    phoneLookup,
    telemetry,
  };
}

describe("initial call state", () => {
  it("promotes one verified lookup into pre-call and active patient state", () => {
    const state = createInitialCallState({
      call,
      bootstrap: bootstrap(
        {
          status: "verified",
          patientId: "patient-1",
          name: "Doe, Jane",
          dob: "01/01/1980",
          phone: callerPhone,
          insuranceCarrier: "Aetna",
          insPlanId: "plan-1",
          respPartyId: "resp-1",
          routing: "all_three",
          allowedProviders: ["Dr. Bach"],
          routingAmbiguous: false,
          preauthRequired: true,
          appointmentsStatus: "found",
          appointmentsMessage: "Appointments found",
          appointments: [
            {
              id: 12345,
              date: "2026-07-20",
              time: "9:00 AM",
              provider: "Dr. Bach",
              type: "Follow-up",
              appointmentTypeId: 42,
              facility: "Spring Hill",
              confirmed: true,
            },
          ],
          lookupDurationMs: 37,
        },
        {
          status: "verified",
          durationMs: 37,
          candidateCount: 1,
          appointmentsStatus: "found",
        },
      ),
      voiceLanguage,
      maxDurationMs: 900_000,
    });

    expect(state).toMatchObject({
      office: {
        activeKey: "spring-hill",
        phoneOverrides: { "spring-hill": "+17275919997" },
      },
      identity: {
        preCall: {
          status: "single_match_pending_confirmation",
          source: "phone_lookup",
          callerPhone,
          lookupDurationMs: 37,
          selectedCandidateRef: "caller",
          appointmentLoadStatus: "found",
          appointmentMessage: "Appointments found",
          identityPromotion: "none",
          candidates: [
            {
              ref: "caller",
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/01/1980",
              patientId: "patient-1",
              relationshipToCaller: "self",
              appointmentsStatus: "found",
              appointments: [
                expect.objectContaining({ id: 12345, appointmentTypeId: 42 }),
              ],
              insuranceCarrier: "Aetna",
              insPlanId: "plan-1",
              respPartyId: "resp-1",
              routing: "all_three",
              allowedProviders: ["Dr. Bach"],
              routingAmbiguous: false,
              preauthRequired: true,
            },
          ],
        },
        patient: {
          status: "matched",
          identityConfirmed: false,
          patientId: "patient-1",
          name: "Doe, Jane",
          dob: "01/01/1980",
          phone: callerPhone,
          appointmentsStatus: "found",
          appointments: [
            expect.objectContaining({ id: 12345, appointmentTypeId: 42 }),
          ],
        },
        patientBackend: { insPlanId: "plan-1", respPartyId: "resp-1" },
      },
      insurance: {
        onFile: {
          plan: "Aetna",
          canonicalPlan: "Aetna",
          coverageType: null,
          currentCarrier: "Aetna",
        },
        lastEligibilityCheck: null,
      },
      workflow: {
        routing: {
          routing: "all_three",
          allowedProviders: ["Dr. Bach"],
          routingAmbiguous: false,
          preauthRequired: true,
        },
      },
      availability: {
        slots: [],
        latestRouting: null,
        bookingTokensBySlotId: {},
        nextSlotIndex: 0,
      },
      runtime: {
        preCallLookup: {
          status: "verified",
          durationMs: 37,
          candidateCount: 1,
          appointmentsStatus: "found",
        },
        latestUserTranscript: null,
        maxCallDurationMs: 900_000,
        sipRoomName: "room-123",
        sipParticipantIdentity: "sip-caller-123",
        callId: "call-123",
        callerPhone,
        trunkPhone,
        transferState: "idle",
        appointmentActions: [],
        staffTasks: [],
        voiceLanguage,
      },
    });
  });

  it("keeps multiple matches pending without promoting a patient", () => {
    const state = createInitialCallState({
      call,
      bootstrap: bootstrap({
        status: "multiple_matches",
        message: "Found two patients",
        matches: [
          { firstName: "Jane" },
          {
            status: "verified",
            patientId: "patient-2",
            name: "Doe, Maria",
            dob: "02/02/1985",
            phone: callerPhone,
            insuranceCarrier: "Humana",
            insPlanId: null,
            respPartyId: null,
            routing: "bach_only",
            allowedProviders: ["Dr. Bach"],
            routingAmbiguous: false,
            preauthRequired: false,
            appointmentsStatus: "none",
            appointments: [],
          },
        ],
        lookupDurationMs: 22,
      }),
      voiceLanguage,
      maxDurationMs: 900_000,
    });

    expect(state.identity.preCall).toMatchObject({
      status: "multiple_matches_pending_selection",
      candidates: [
        { ref: "precall:1", firstName: "Jane", appointments: [] },
        {
          ref: "precall:2",
          firstName: "Maria",
          lastName: "Doe",
          patientId: "patient-2",
          relationshipToCaller: "unknown",
          appointmentsStatus: "none",
          insuranceCarrier: "Humana",
          routing: "bach_only",
        },
      ],
    });
    expect(state.identity.patient).toMatchObject({
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
      appointments: [],
      appointmentsStatus: null,
    });
    expect(state.insurance.onFile).toBeNull();
    expect(state.workflow.routing).toEqual({
      routing: null,
      allowedProviders: [],
      routingAmbiguous: false,
      preauthRequired: false,
    });
  });

  it.each([
    {
      name: "no match",
      lookup: {
        status: "no_match" as const,
        phone: callerPhone,
        message: "No match",
        lookupDurationMs: 14,
      },
      expectedPreCall: {
        status: "no_match",
        lookupDurationMs: 14,
        candidates: [],
        identityPromotion: "none",
      },
      telemetry: {
        status: "no_match" as const,
        durationMs: 14,
        candidateCount: 0,
      },
    },
    {
      name: "lookup failure",
      lookup: {
        status: "lookup_failed" as const,
        phone: callerPhone,
        reason: "network_error" as const,
        retryable: true,
        lookupDurationMs: 51,
      },
      expectedPreCall: {
        status: "lookup_failed",
        lookupDurationMs: 51,
        failureReason: "network_error",
        retryable: true,
        candidates: [],
        identityPromotion: "none",
      },
      telemetry: {
        status: "lookup_failed" as const,
        durationMs: 51,
        candidateCount: 0,
        failureReason: "network_error" as const,
        retryable: true,
      },
    },
  ])(
    "initializes safe empty state after $name",
    ({ lookup, expectedPreCall, telemetry }) => {
      const state = createInitialCallState({
        call,
        bootstrap: bootstrap(lookup, telemetry),
        voiceLanguage,
        maxDurationMs: 900_000,
      });

      expect(state.identity.preCall).toMatchObject(expectedPreCall);
      expect(state.runtime.preCallLookup).toEqual(telemetry);
      expect(state.identity.patient).toEqual({
        status: "unknown",
        identityConfirmed: false,
        patientId: null,
        name: null,
        dob: null,
        phone: callerPhone,
        appointments: [],
        appointmentsStatus: null,
      });
      expect(state.insurance.onFile).toBeNull();
      expect(state.availability).toEqual({
        slots: [],
        latestRouting: null,
        bookingTokensBySlotId: {},
        nextSlotIndex: 0,
      });
    },
  );

  it("initializes explicit defaults when lookup was not attempted", () => {
    const state = createInitialCallState({
      call,
      bootstrap: bootstrap(null),
      voiceLanguage,
      maxDurationMs: 900_000,
    });

    expect(state.identity.preCall).toEqual({
      status: "not_attempted",
      source: "phone_lookup",
      callerPhone,
      candidates: [],
      identityPromotion: "none",
    });
    expect(state.runtime).toMatchObject({
      preCallLookup: { status: "not_attempted", durationMs: null },
      maxCallDurationMs: 900_000,
      voiceLanguage,
    });
  });
});
