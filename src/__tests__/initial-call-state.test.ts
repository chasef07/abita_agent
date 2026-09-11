import { AgentSession, initializeLogger } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import {
  applyPreCallLookup,
  createInitialCallState,
  type InitialCallInput,
} from "../runtime/initial-call-state.js";
import type { CallState, PhoneLookupResult } from "../state/call-state.js";

const call = {
  callId: "call-test",
  callerPhone: "+17275551212",
  officeKey: "spring-hill",
  roomName: "room-test",
  sipParticipantIdentity: "sip-participant",
  trunkPhone: SPRING_HILL_OFFICE_PHONE,
  voiceLanguage: {
    current: "en",
    speaker: "test-speaker",
    ttsLanguage: "eng",
    ttsProvider: "rime",
  },
} satisfies InitialCallInput;

const phoneLookup = {
  status: "verified",
  patientId: "private-patient-id",
  name: "Doe, Jane",
  dob: "01/01/1980",
  phone: "+17275551212",
  insuranceCarrier: "Aetna",
  insPlanId: "private-plan-id",
  respPartyId: "private-party-id",
  routing: "all_three",
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
} satisfies PhoneLookupResult;

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
    });
  });

  it("adds phone-lookup candidates without replacing initialized state or resetting live runtime work", () => {
    const state = createInitialCallState(call);
    const session = new AgentSession<CallState>({
      userData: state,
      vad: null,
    });

    const runtime = state.runtime;
    const identity = state.identity;
    const voiceLanguage = state.runtime.voiceLanguage;
    const workflow = state.workflow;
    state.runtime.transferState = "pending";
    state.workflow.visitType = "medical";
    state.identity.operationVersion = 3;
    state.runtime.staffTasks.push({
      createdAt: "2026-09-10T00:00:00Z",
      idempotencyKey: "startup-task",
      status: "created",
      taskId: "task-1",
    });

    applyPreCallLookup(state, phoneLookup);

    expect(state.runtime).toBe(runtime);
    expect(state.identity).toBe(identity);
    expect(state.runtime.voiceLanguage).toBe(voiceLanguage);
    expect(state.workflow).toBe(workflow);
    expect(state.runtime.transferState).toBe("pending");
    expect(state.workflow.visitType).toBe("medical");
    expect(state.identity.operationVersion).toBe(3);
    expect(state.runtime.staffTasks).toHaveLength(1);

    expect(session.userData).toBe(state);
    expect(session.userData.runtime.preCallLookup).toMatchObject({
      status: "verified",
    });
    expect(session.userData.identity.privateCandidates).toMatchObject([
      {
        patientId: "private-patient-id",
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
