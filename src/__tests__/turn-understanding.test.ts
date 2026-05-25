import { describe, expect, it } from "vitest";
import {
  applyTurnUnderstandingFromTranscript,
  createInitialFlowState,
  createPendingBookingAction,
  flowDecisionForWorkflowCommand,
  inferObviousTurnUnderstanding,
  planNextCommand,
  parseTurnUnderstanding,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  type CallerAppointment,
  type TurnUnderstanding,
} from "../flow/index.js";

describe("turn understanding reducer", () => {
  it("captures reschedule intent and preferred window as structured state", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
      appointments: [appointment(12345)],
    });

    const update = applyTurnUnderstandingFromTranscript(
      flow,
      "This is Jane. Could we push it into next week, mornings if possible?",
      {
        goal: "manage_existing_appointment",
        appointmentAction: "reschedule",
        patient: {
          patientMentioned: "caller",
          relationshipToCaller: "self",
        },
        scheduling: {
          preferredWindow: "next week mornings",
        },
        interruption: "none",
        confidence: 0.88,
        evidence: ["push it", "next week", "mornings"],
      },
    );

    expect(update.inferred).toMatchObject({
      activeIntent: "existing_appointment_reschedule",
    });
    expect(flow).toMatchObject({
      activeFlow: "appointment_management",
      activeIntent: "existing_appointment_reschedule",
      schedulingGoal: {
        appointmentAction: "reschedule",
        preferredWindow: "next week mornings",
      },
    });
    expect(flowDecisionForWorkflowCommand(planNextCommand(flow))).toMatchObject(
      {
        type: "call_tool",
        tool: "get_availability",
      },
    );
  });

  it("honors semantic negation instead of treating every cancel mention as cancellation", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
      appointments: [appointment(12345)],
    });

    const update = applyTurnUnderstandingFromTranscript(
      flow,
      "This is Jane. No don't cancel it, I just need to know what time it is.",
      {
        goal: "manage_existing_appointment",
        appointmentAction: "confirm",
        patient: {
          patientMentioned: "caller",
          relationshipToCaller: "self",
        },
        scheduling: {},
        interruption: "correction",
        confidence: 0.86,
        evidence: ["don't cancel", "what time"],
      },
    );

    expect(flow.activeIntent).toBe("existing_appointment_confirm");
    expect(update.inferred.activeIntent).toBe("existing_appointment_confirm");
    expect(flowDecisionForWorkflowCommand(planNextCommand(flow))).toMatchObject(
      {
        type: "say",
      },
    );
  });

  it("switches from pre-call caller state to a child patient and invalidates stale side effects", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "caller-patient",
      patientName: "Parent Caller",
    });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      date: "2026-06-01",
      officeKey: "spring-hill",
      routing: "all_three",
      visitType: "medical",
    });
    recordAvailabilityCachedSlots(flow, [{ slotId: "caller-slot" }]);
    createPendingBookingAction(flow, {
      appointmentTypeId: 1007,
      createdTurnId: "turn-1",
      officeKey: "spring-hill",
      routing: "all_three",
      slotHash: "caller-slot",
      spokenSummary: "Caller slot",
      confirmed: true,
    });

    applyTurnUnderstandingFromTranscript(
      flow,
      "I need to schedule my daughter Emily for a glaucoma follow up.",
      {
        goal: "schedule",
        appointmentAction: null,
        patient: {
          patientMentioned: "someone_else",
          relationshipToCaller: "child",
          firstName: "Emily",
        },
        scheduling: {
          visitReason: "glaucoma follow up",
          visitType: "medical",
        },
        interruption: "none",
        confidence: 0.91,
        evidence: ["my daughter Emily", "glaucoma follow up"],
      },
    );

    expect(flow.activePatientRef).not.toBe("caller");
    expect(flow.patientStatus).toBe("candidate");
    expect(flow.activeIntent).toBe("new_appointment");
    expect(flow.availabilitySearches[0]).toMatchObject({
      status: "invalidated",
      lastInvalidationReason: "patient_changed",
    });
    expect(flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      invalidated: true,
      invalidationReason: "patient_changed",
    });
  });

  it("does not write low-confidence state-update facts into state", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });

    applyTurnUnderstandingFromTranscript(flow, "maybe next week, I guess", {
      goal: "schedule",
      appointmentAction: null,
      patient: {
        patientMentioned: "someone_else",
        relationshipToCaller: "child",
        firstName: "Emily",
      },
      scheduling: {
        visitReason: "glaucoma follow up",
        visitType: "medical",
        preferredWindow: "next week",
      },
      interruption: "none",
      confidence: 0.32,
      evidence: ["maybe"],
    });

    expect(flow).toMatchObject({
      activeIntent: null,
      activeFlow: "intro",
      activePatientRef: "caller",
      patientStatus: "matched",
      visitType: undefined,
    });
    expect(flow.schedulingGoal).toBeUndefined();
    expect(flow.patients.caller.firstName?.value).toBe("Jane");
  });

  it("parses main-agent state-update tool input into the reducer schema", () => {
    const parsed = parseTurnUnderstanding({
      goal: "schedule",
      appointmentAction: null,
      patient: {
        patientMentioned: "caller",
        relationshipToCaller: "self",
      },
      scheduling: {
        visitReason: "routine exam",
        visitType: "routine_vision",
      },
      insurance: {
        plan: "VSP",
        coverageType: "routine_vision",
      },
      interruption: "none",
      confidence: 0.89,
      evidence: ["routine exam", "VSP"],
    });

    expect(parsed).toMatchObject({
      goal: "schedule",
      scheduling: {
        visitReason: "routine exam",
        visitType: "routine_vision",
      },
      insurance: {
        plan: "VSP",
        coverageType: "routine_vision",
      },
    } satisfies Partial<TurnUnderstanding>);
  });

  it("infers a booking confirmation from an affirmative reply", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });
    flow.activeFlow = "scheduling";
    flow.activeIntent = "new_appointment";
    flow.step = "confirm_booking";
    flow.schedulingGoal = {
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "double vision",
      selectedSlotId: "B",
      updatedAt: Date.now(),
    };

    expect(inferObviousTurnUnderstanding(flow, "yes that works")).toMatchObject(
      {
        goal: "schedule",
        scheduling: {
          selectedSlotId: "B",
          bookingConfirmed: true,
        },
      },
    );
  });

  it("infers cancel confirmation from a planner confirmation state", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
      appointments: [appointment(12345)],
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.activeIntent = "existing_appointment_cancel";
    flow.activeFlow = "appointment_management";
    const command = planNextCommand(flow);
    flow.lastWorkflowCommand = {
      ...command,
      confirmationType: "cancel",
      statePatch: undefined,
    };

    expect(inferObviousTurnUnderstanding(flow, "correct")).toMatchObject({
      goal: "manage_existing_appointment",
      appointmentAction: "cancel",
      confirmation: {
        cancelConfirmed: true,
      },
    });
  });
});

function appointment(id: number): CallerAppointment {
  return {
    id,
    date: "2026-06-01",
    time: "9:00 AM",
    provider: "Dr. Bach",
    type: "Follow-up",
    facility: "Spring Hill",
    confirmed: true,
  };
}
