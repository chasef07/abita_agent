import { describe, expect, it } from "vitest";
import { DEV_OFFICE_PHONE } from "../customer/profile.js";
import {
  applyPlannerPatch,
  createInitialFlowState,
  planNextCommand,
} from "../flow/index.js";
import type { CallState } from "../tooling/call-state.js";
import { buildToolsForState } from "../tooling/tool-registry.js";

describe("dynamic tool exposure", () => {
  it("keeps record_turn_understanding first while a user turn is pending", () => {
    const state = createCallState();
    state.latestUserTranscript = "I need to schedule an appointment";
    state.turnUnderstandingAppliedForTranscript = null;

    const decision = buildToolsForState(state);

    expect(decision.reason).toBe("turn_update_pending_broad");
    expect(decision.visibleToolNames).toEqual([
      "record_turn_understanding",
      ...DEV_BROAD_TOOL_NAMES,
    ]);
  });

  it("keeps broad workflow tools visible while a user turn is pending", () => {
    const state = createCallState();
    state.flow.step = "confirm_booking";
    state.lastAvailabilitySlots = [
      {
        slotId: "slot-1",
        spoken: "Monday at 9 AM with Dr. Licht",
        provider: "Dr. Licht",
        date: "2026-06-01",
        time: "9:00 AM",
        datetime: "2026-06-01T09:00:00",
        routing: "all_three",
      },
    ];
    state.latestUserTranscript = "yes that appointment works";
    state.turnUnderstandingAppliedForTranscript = null;

    expect(buildToolsForState(state).visibleToolNames).toEqual([
      "record_turn_understanding",
      ...DEV_BROAD_TOOL_NAMES,
    ]);
  });

  it("keeps all workflow tools visible during insurance state", () => {
    const state = createCallState();
    state.flow.step = "check_insurance";
    state.flow.activeFlow = "insurance";
    state.flow.activeIntent = "insurance_question";

    const decision = buildToolsForState(state);

    expect(decision.visibleToolNames).toEqual(DEV_BROAD_TOOL_NAMES);
    expect(decision.visibleToolNames).toContain("check_insurance");
  });

  it("exposes booking while policy guards missing availability", () => {
    const state = createCallState();
    state.flow.step = "confirm_booking";

    expect(buildToolsForState(state).visibleToolNames).toEqual(
      DEV_BROAD_TOOL_NAMES,
    );
    expect(buildToolsForState(state).visibleToolNames).toContain("book_appt");

    state.lastAvailabilitySlots = [
      {
        slotId: "slot-1",
        spoken: "Monday at 9 AM with Dr. Licht",
        provider: "Dr. Licht",
        date: "2026-06-01",
        time: "9:00 AM",
        datetime: "2026-06-01T09:00:00",
        routing: "all_three",
      },
    ];

    expect(buildToolsForState(state).visibleToolNames).toEqual(
      DEV_BROAD_TOOL_NAMES,
    );
  });

  it("keeps appointment lookup visible with the broad workflow set", () => {
    const state = createCallState();
    state.flow.activeFlow = "appointment_management";
    state.flow.activeIntent = "existing_appointment_confirm";
    state.flow.patientStatus = "verified";
    state.flow.patients[state.flow.activePatientRef!].status = "verified";
    state.flow.step = "answer";

    expect(buildToolsForState(state).visibleToolNames).toEqual(
      DEV_BROAD_TOOL_NAMES,
    );
    expect(buildToolsForState(state).visibleToolNames).toContain(
      "confirm_appt",
    );
  });

  it("keeps appointment lookup visible even if appointment-management state drifts", () => {
    const state = createCallState();
    state.flow.activeFlow = "appointment_management";
    state.flow.activeIntent = "existing_appointment_confirm";
    state.flow.patientStatus = "verified";
    state.flow.patients[state.flow.activePatientRef!].status = "verified";
    state.flow.step = "get_availability";

    expect(buildToolsForState(state).visibleToolNames).toEqual(
      DEV_BROAD_TOOL_NAMES,
    );
  });

  it("uses planner state as exposure context without narrowing tools", () => {
    const state = createCallState();
    state.flow.activeIntent = "existing_appointment_reschedule";
    state.flow.activeFlow = "appointment_management";
    state.flow.patientStatus = "verified";
    state.flow.patients[state.flow.activePatientRef!].status = "verified";
    state.flow.patients[state.flow.activePatientRef!].appointments = [
      {
        id: 12345,
        date: "2026-06-01",
        time: "8:00 AM",
        provider: "Dr. Bach",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: true,
      },
    ];
    state.flow.schedulingGoal = {
      patientRef: "caller",
      status: "collecting",
      appointmentAction: "reschedule",
      preferredWindow: "Monday at 1 PM",
      evidence: ["Dr. Bach", "Monday at 1 PM"],
      updatedAt: Date.now(),
    };

    const command = planNextCommand(state.flow);
    applyPlannerPatch(state.flow, command);

    const decision = buildToolsForState(state);
    expect(decision.reason).toBe(
      "planner_guidance_broad:appointment_reschedule:searching_replacement",
    );
    expect(decision.visibleToolNames).toEqual(DEV_BROAD_TOOL_NAMES);
    expect(decision.visibleToolNames).not.toContain("reschedule_appt");
  });

  it("keeps appointment lookup visible before a preloaded patient is verified", () => {
    const state = createCallState();
    state.flow.step = "verify_patient";
    state.flow.patientStatus = "matched";
    state.flow.patients[state.flow.activePatientRef!].status = "matched";

    expect(buildToolsForState(state).visibleToolNames).toEqual(
      DEV_BROAD_TOOL_NAMES,
    );
  });

  it("keeps cancellation tools visible before a preloaded patient is verified", () => {
    const state = createCallState();
    state.flow.step = "confirm_cancel";
    state.flow.patientStatus = "matched";
    state.flow.patients[state.flow.activePatientRef!].status = "matched";

    expect(buildToolsForState(state).visibleToolNames).toEqual(
      DEV_BROAD_TOOL_NAMES,
    );
  });

  it("keeps update_insurance visible after accepted medical insurance for a verified patient", () => {
    const state = createCallState();
    state.flow.activeFlow = "insurance";
    state.flow.step = "get_availability";
    state.checkedInsurancePlan = "United Healthcare";
    state.checkedInsuranceCoverageType = "medical";

    expect(buildToolsForState(state).visibleToolNames).toEqual(
      DEV_BROAD_TOOL_NAMES,
    );
  });

  it("keeps add_patient_note visible after booking succeeds", () => {
    const state = createCallState();
    state.flow.step = "answer";
    state.flow.pendingActions.push({
      id: "pending_book_1",
      type: "book_appt",
      patientRef: "caller",
      slotHash: "A",
      appointmentTypeId: 1007,
      officeKey: "dev",
      routing: "all_three",
      availabilitySearchId: "availability_1",
      spokenSummary: "Monday at 9 AM with Dr. Licht",
      confirmed: true,
      consumed: true,
      createdTurnId: "turn-1",
      invalidated: false,
      bookingAttemptCount: 1,
      slotInvalidated: false,
    });

    expect(buildToolsForState(state).visibleToolNames).toEqual(
      DEV_BROAD_TOOL_NAMES,
    );
    expect(buildToolsForState(state).visibleToolNames).toContain(
      "add_patient_note",
    );
  });

  it("uses the legacy broad tool set when the flow harness is disabled", () => {
    const state = createCallState({ flowHarnessEnabled: false });

    const decision = buildToolsForState(state);

    expect(decision.reason).toBe("legacy_harness_disabled");
    expect(decision.visibleToolNames).toContain("verify_patient");
    expect(decision.visibleToolNames).toContain("book_appt");
    expect(decision.visibleToolNames).not.toContain(
      "record_turn_understanding",
    );
  });
});

const DEV_BROAD_TOOL_NAMES = [
  "verify_patient",
  "add_patient",
  "update_insurance",
  "get_availability",
  "confirm_appt",
  "cancel_appt",
  "add_patient_note",
  "book_appt",
  "check_insurance",
  "lookup_knowledge",
  "transfer_call",
] as const;

function createCallState(overrides: Partial<CallState> = {}): CallState {
  return {
    flow: createInitialFlowState({
      officeKey: "dev",
      patientId: "patient-1",
      patientName: "Jane Doe",
      dob: "01/01/1980",
      callerPhone: "+17275551212",
      routing: "all_three",
      coverageType: "medical",
    }),
    flowHarnessEnabled: true,
    flowGuardObservations: [],
    preCallLookup: {
      status: "verified",
      durationMs: 12,
    },
    latestUserTranscript: null,
    turnUnderstandingAppliedForTranscript: null,
    dynamicToolsEnabled: true,
    officeKey: "dev",
    amdOfficePhone: DEV_OFFICE_PHONE,
    sipRoomName: "room",
    sipParticipantIdentity: "caller",
    callId: "call-123",
    callerPhone: "+17275551212",
    trunkPhone: DEV_OFFICE_PHONE,
    patientId: "patient-1",
    patientName: "Jane Doe",
    dob: "01/01/1980",
    insuranceCarrier: "Aetna",
    insPlanId: "plan-1",
    respPartyId: "resp-1",
    checkedInsurancePlan: "Aetna",
    checkedInsuranceCoverageType: "medical",
    routing: "all_three",
    lastAvailabilityRouting: null,
    lastAvailabilitySlots: [],
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointments: [],
    transferred: false,
    transferInFlight: false,
    ...overrides,
  };
}
