import { AgentSession, initializeLogger } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import {
  applyPreCallBootstrap,
  createInitialCallState,
  type InitialCallInput,
} from "../runtime/initial-call-state.js";
import type { PreCallBootstrap } from "../runtime/precall-bootstrap.js";
import type { CallState } from "../state/call-state.js";

const call = {
  amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
  callId: "call-test",
  callerPhone: "+17275551212",
  maxDurationMs: 900_000,
  officeKey: "spring-hill",
  roomName: "room-test",
  sipParticipantIdentity: "sip-participant",
  trunkPhone: SPRING_HILL_OFFICE_PHONE,
  voiceLanguage: {
    current: "en",
    speaker: "test-speaker",
    ttsLanguage: "en",
    ttsProvider: "rime-inference",
  },
} satisfies InitialCallInput;

const bootstrap = {
  phoneLookup: {
    status: "verified",
    patientId: "private-patient-id",
    name: "Doe, Jane",
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
    appointmentsMessage: null,
    appointments: [
      {
        id: 123,
        cancellationToken: "private-cancellation-token",
        rescheduleToken: "private-reschedule-token",
        date: "June 1",
        time: "9:00 AM",
        provider: "Dr. Bach",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: true,
      },
    ],
    lookupDurationMs: 25,
  },
} satisfies PreCallBootstrap;

describe("initial call state", () => {
  initializeLogger({ pretty: false, level: "silent" });

  it("initializes typed session userData in the constructor before lookup hydration", () => {
    const state = createInitialCallState(call);
    const session = new AgentSession<CallState>({
      userData: state,
      vad: null,
    });

    expect(session.userData).toBe(state);
    expect(session.userData.runtime.preCallLookup).toEqual({
      status: "not_attempted",
      durationMs: null,
    });
    expect(session.userData.runtime.maxCallDurationMs).toBe(900_000);
  });

  it("hydrates the same userData object with full private candidate state", () => {
    const state = createInitialCallState(call);
    const session = new AgentSession<CallState>({
      userData: state,
      vad: null,
    });

    applyPreCallBootstrap(state, call, bootstrap);

    expect(session.userData).toBe(state);
    expect(session.userData.runtime.preCallLookup).toMatchObject({
      status: "verified",
      candidateCount: 1,
    });
    expect(session.userData.identity.privateCandidates).toMatchObject([
      {
        patientId: "private-patient-id",
        allowedProviders: ["private-provider-reference"],
        appointments: [
          expect.objectContaining({
            cancellationToken: "private-cancellation-token",
            rescheduleToken: "private-reschedule-token",
          }),
        ],
      },
    ]);
    expect(session.userData.identity.privateCandidates[0]).not.toHaveProperty(
      "cancellationToken",
    );
    expect(session.userData.identity.activePatient).toBeNull();
  });
});
