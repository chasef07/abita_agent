import { describe, expect, it } from "vitest";
import {
  callerTurnMeaningEvent,
  activeWorkflowCommandForState,
  reduceTurnUnderstandingFromTranscript,
  createInitialFlowState,
  createPendingBookingAction,
  createPendingSideEffectAction,
  hashToolArgs,
  inferObviousTurnUnderstanding,
  nextFlowEventId,
  planNextCommand,
  parseTurnUnderstanding,
  reduceFlowEvent,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  type CallFlowState,
  type CallerAppointment,
  type TurnUnderstanding,
  type WorkflowCommand,
} from "../flow/index.js";
import { flowDecisionForWorkflowCommand } from "./flow-decision-test-helper.js";

function applyPlannerCommand(
  flow: CallFlowState,
  command: WorkflowCommand = planNextCommand(flow),
): void {
  reduceFlowEvent(flow, {
    id: nextFlowEventId("test_planner_command"),
    type: "planner_command_applied",
    source: "planner",
    createdAt: Date.now(),
    command,
  });
}

describe("turn understanding reducer", () => {
  it("records verified patient facts through reducer events", () => {
    const flow = createInitialFlowState({
      officeKey: "hollywood",
      callerPhone: "+19548223950",
    });

    const result = reduceFlowEvent(flow, {
      id: nextFlowEventId("test_patient_recorded"),
      type: "patient_recorded",
      source: "tool_result",
      createdAt: Date.now(),
      patientId: "17553422",
      patientName: "QUEVEDO MAZA,CARLOS",
      dob: "10/13/1949",
      appointments: [appointment(20756135)],
      appointmentsStatus: "found",
    });

    expect(result.patientChange).toMatchObject({
      activePatientRef: "caller",
      switchedPatient: false,
    });
    expect(flow.patientStatus).toBe("verified");
    expect(flow.patients.caller).toMatchObject({
      patientId: "17553422",
      appointmentsStatus: "found",
    });
    expect(flow.transitionLog?.at(-1)).toMatchObject({
      eventType: "patient_recorded",
      source: "tool_result",
    });
  });

  it("logs planner command details and clears stale commands on reducer-owned state changes", () => {
    const flow = createInitialFlowState({
      officeKey: "hollywood",
      callerPhone: "+19548223950",
    });
    const command = planNextCommand(flow);

    const planned = reduceFlowEvent(flow, {
      id: nextFlowEventId("test_planner_command"),
      type: "planner_command_applied",
      source: "planner",
      createdAt: Date.now(),
      command,
    });

    expect(activeWorkflowCommandForState(flow)).toBe(command);
    expect(planned.transition.after).toMatchObject({
      lastCommandTaskId: command.taskId,
      lastCommandTaskKind: command.taskKind,
      lastCommandPhase: command.phase,
      lastCommandAction: command.nextAction,
    });
    expect(planned.transition.changed).toEqual(
      expect.arrayContaining([
        "lastCommandTaskId",
        "lastCommandPhase",
        "lastCommandAction",
      ]),
    );

    const stepped = reduceFlowEvent(flow, {
      id: nextFlowEventId("test_step_update"),
      type: "workflow_step_updated",
      source: "system",
      createdAt: Date.now(),
      activeFlow: "quick_question",
      step: "answer",
    });

    expect(activeWorkflowCommandForState(flow)).toBeUndefined();
    expect(stepped.transition.before).toMatchObject({
      lastCommandTaskId: command.taskId,
      lastCommandPhase: command.phase,
    });
    expect(stepped.transition.after).toMatchObject({
      lastCommandTaskId: undefined,
      lastCommandPhase: undefined,
    });
    expect(stepped.transition.changed).toEqual(
      expect.arrayContaining([
        "lastCommandTaskId",
        "lastCommandPhase",
        "lastCommandAction",
      ]),
    );
  });

  it("keeps cached planner commands when pre-call observation is a no-op", () => {
    const flow = createInitialFlowState({
      officeKey: "hollywood",
      callerPhone: "+19548223950",
    });
    const command = planNextCommand(flow);
    applyPlannerCommand(flow, command);

    reduceFlowEvent(flow, {
      id: nextFlowEventId("test_pre_call_noop"),
      type: "pre_call_identity_observed",
      source: "deterministic_understanding",
      createdAt: Date.now(),
      transcript: "I need an appointment",
    });

    expect(activeWorkflowCommandForState(flow)).toBe(command);
  });

  it("consumes side effects from reducer tool-success events", () => {
    const flow = createInitialFlowState({
      officeKey: "hollywood",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });
    createPendingSideEffectAction(flow, {
      type: "transfer_call",
      argsHash: hashToolArgs({}),
      spokenSummary: "Transfer the caller to the office.",
      patientRef: "caller",
      confirmed: true,
      createdTurnId: "caller-confirmed-transfer",
      confirmationTurnId: "caller-confirmed-transfer",
    });

    reduceFlowEvent(flow, {
      id: nextFlowEventId("test_tool_succeeded"),
      type: "tool_succeeded",
      source: "tool_result",
      createdAt: Date.now(),
      toolName: "transfer_call",
      outputClass: "transfer_started",
      argsHash: hashToolArgs({}),
      patientRef: "caller",
      facts: {},
    });

    expect(flow.pendingActions[0]).toMatchObject({
      type: "transfer_call",
      confirmed: true,
      consumed: true,
    });
    expect(flow.transitionLog?.at(-1)).toMatchObject({
      eventType: "tool_succeeded",
      changed: expect.arrayContaining(["pendingActionState"]),
    });
  });

  it("clears route confirmation after a successful route tool event", () => {
    const flow = createInitialFlowState({
      officeKey: "crystal-river",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });
    const argsHash = hashToolArgs({});
    flow.pendingConfirmation = {
      type: "route_office",
      payload: { officeKey: "spring-hill" },
    };
    flow.coverageType = "routine_vision";
    createPendingSideEffectAction(flow, {
      type: "route_office",
      argsHash,
      spokenSummary: "Route the caller to Spring Hill.",
      patientRef: "caller",
      confirmed: true,
      createdTurnId: "caller-confirmed-route",
      confirmationTurnId: "caller-confirmed-route",
    });

    reduceFlowEvent(flow, {
      id: nextFlowEventId("test_route_succeeded"),
      type: "tool_succeeded",
      source: "tool_result",
      createdAt: Date.now(),
      toolName: "route_to_spring_hill",
      outputClass: "office_routed",
      argsHash,
      patientRef: "caller",
      facts: { officeKey: "spring-hill" },
    });

    expect(flow.pendingConfirmation).toBeUndefined();
    expect(flow.officeKey).toBe("spring-hill");
    expect(flow.visitType).toBe("routine_vision");
    expect(flow.routing).toBe("optical_only");
    expect(flow.pendingActions[0]).toMatchObject({
      type: "route_office",
      consumed: true,
    });
  });

  it("clears stale active commands until the next planner command is applied", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.activeIntent = "new_patient_registration";
    flow.activeFlow = "new_patient";
    flow.patientStatus = "new";
    flow.step = "collect_registration";
    flow.visitType = "medical";
    flow.coverageType = "medical";
    flow.currentTask = {
      id: "task_schedule_caller",
      kind: "schedule",
      patientRef: "caller",
      step: "collect_registration",
      createdAt: Date.now(),
    };
    flow.schedulingGoal = {
      status: "collecting",
      patientRef: "caller",
      appointmentAction: "schedule",
      visitReason: "eye pain",
      visitType: "medical",
      preferredWindow: "tomorrow",
      updatedAt: Date.now(),
    };

    const staleCommand = planNextCommand(flow);
    reduceFlowEvent(flow, {
      id: nextFlowEventId("test_planner_command"),
      type: "planner_command_applied",
      source: "planner",
      createdAt: Date.now(),
      command: staleCommand,
    });
    expect(activeWorkflowCommandForState(flow)?.phase).toBe(staleCommand.phase);

    reduceFlowEvent(flow, {
      id: nextFlowEventId("test_patient_payload"),
      type: "patient_payload_applied",
      source: "tool_result",
      createdAt: Date.now(),
      patientStatus: "created",
      officeKey: "spring-hill",
    });

    expect(activeWorkflowCommandForState(flow)).toBeUndefined();
    applyPlannerCommand(flow);

    expect(activeWorkflowCommandForState(flow)).toMatchObject({
      phase: "searching_availability",
      nextAction: "call_tool",
      tool: "get_availability",
    });
  });

  it("invalidates a confirmed pending booking when the caller rejects the slot", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });
    flow.activeIntent = "new_appointment";
    flow.activeFlow = "scheduling";
    flow.patientStatus = "verified";
    flow.step = "confirm_booking";
    flow.visitType = "medical";
    flow.coverageType = "medical";
    flow.routing = "all_three";
    flow.schedulingGoal = {
      status: "confirming_booking",
      patientRef: "caller",
      appointmentAction: "schedule",
      visitReason: "eye pain",
      selectedSlotId: "A",
      updatedAt: Date.now(),
    };
    recordAvailabilitySearch(flow, {
      patientRef: "caller",
      officeKey: "spring-hill",
      visitType: "medical",
      coverageType: "medical",
      routing: "all_three",
      date: "2026-06-02",
    });
    recordAvailabilityCachedSlots(flow, [
      { slotId: "A", datetime: "2026-06-02T09:00" },
    ]);

    reduceFlowEvent(
      flow,
      callerTurnMeaningEvent({
        transcript: "yes",
        flow,
        source: "deterministic_understanding",
        understanding: bookingConfirmationTurn(true),
      }),
    );
    expect(flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      confirmed: true,
    });
    expect(flow.pendingActions[0]).not.toMatchObject({ invalidated: true });

    reduceFlowEvent(
      flow,
      callerTurnMeaningEvent({
        transcript: "actually no",
        flow,
        source: "deterministic_understanding",
        understanding: bookingConfirmationTurn(false),
      }),
    );

    expect(flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      confirmed: true,
      invalidated: true,
      invalidationReason: "caller_rejected",
      slotInvalidated: true,
    });
    expect(flow.availabilitySearches[0].rejectedSlotHashes).toContain("A");
  });

  it("captures reschedule intent and preferred window as structured state", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
      appointments: [appointment(12345)],
    });

    const update = reduceTurnUnderstandingFromTranscript(
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

  it("treats appointment changes as existing appointment reschedule", () => {
    const flow = createInitialFlowState({
      officeKey: "hollywood",
      callerPhone: "+19548223950",
    });

    const understanding = inferObviousTurnUnderstanding(
      flow,
      "Appointment changes.",
    );

    expect(understanding).toMatchObject({
      goal: "manage_existing_appointment",
      appointmentAction: "reschedule",
    });

    const update = reduceTurnUnderstandingFromTranscript(
      flow,
      "Appointment changes.",
      understanding!,
    );

    expect(update.inferred.activeIntent).toBe(
      "existing_appointment_reschedule",
    );
    expect(flow).toMatchObject({
      activeFlow: "appointment_management",
      activeIntent: "existing_appointment_reschedule",
      step: "verify_patient",
    });
  });

  it("prioritizes human transfer requests over generic appointment scheduling", () => {
    const flow = createInitialFlowState({
      officeKey: "hollywood",
      patientId: "patient-1",
      patientName: "Carlos Quevedo",
    });

    expect(
      inferObviousTurnUnderstanding(
        flow,
        "Can I talk to somebody to make the appointment?",
      ),
    ).toMatchObject({
      goal: "transfer_request",
      interruption: "transfer_request",
    });
  });

  it("recognizes Spanish real-person office requests as transfer intent", () => {
    const flow = createInitialFlowState({
      officeKey: "sweetwater",
      callerPhone: "+17862314846",
    });

    expect(
      inferObviousTurnUnderstanding(
        flow,
        "No te entiendo. Necesito una oficina, un oficinista, alguien real.",
      ),
    ).toMatchObject({
      goal: "transfer_request",
      interruption: "transfer_request",
    });
  });

  it("treats an affirmative answer as transfer confirmation when a transfer is pending", () => {
    const flow = createInitialFlowState({
      officeKey: "sweetwater",
      callerPhone: "+17862314846",
    });
    flow.pendingConfirmation = {
      type: "transfer",
      payload: { reason: "caller requested a human at the office" },
    };

    expect(inferObviousTurnUnderstanding(flow, "Okay.")).toMatchObject({
      goal: "transfer_request",
      confirmation: { transferConfirmed: true },
    });
  });

  it("does not treat someone-else or in-person scheduling as transfer", () => {
    const flow = createInitialFlowState({
      officeKey: "hollywood",
      callerPhone: "+19548223950",
    });

    expect(
      inferObviousTurnUnderstanding(
        flow,
        "I need an appointment for someone else",
      ),
    ).toMatchObject({
      goal: "schedule",
    });
    expect(
      inferObviousTurnUnderstanding(flow, "I need an in-person appointment"),
    ).toMatchObject({
      goal: "schedule",
    });
  });

  it("keeps insurance change wording in the insurance flow", () => {
    const flow = createInitialFlowState({
      officeKey: "hollywood",
      callerPhone: "+19548223950",
    });

    expect(
      inferObviousTurnUnderstanding(flow, "I need to change my insurance"),
    ).toMatchObject({
      goal: "insurance_question",
    });
    expect(
      inferObviousTurnUnderstanding(flow, "my coverage changed"),
    ).toMatchObject({
      goal: "insurance_question",
    });
  });

  it("honors semantic negation instead of treating every cancel mention as cancellation", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
      appointments: [appointment(12345)],
    });

    const update = reduceTurnUnderstandingFromTranscript(
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

    reduceTurnUnderstandingFromTranscript(
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

    reduceTurnUnderstandingFromTranscript(flow, "maybe next week, I guess", {
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

  it("infers no referring doctor without overwriting the visit reason", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.activeFlow = "scheduling";
    flow.activeIntent = "new_appointment";
    flow.step = "confirm_booking";
    flow.schedulingGoal = {
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "post-op visit",
      selectedSlotId: "B",
      bookingConfirmed: true,
      updatedAt: Date.now(),
    };
    applyPlannerCommand(flow);

    expect(
      inferObviousTurnUnderstanding(flow, "I don't have one."),
    ).toMatchObject({
      goal: "schedule",
      scheduling: {
        note: {
          referringDoctor: "none",
        },
      },
    });
    expect(
      inferObviousTurnUnderstanding(flow, "I don't have one.")?.scheduling,
    ).not.toMatchObject({
      visitReason: "I don't have one.",
    });
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
    applyPlannerCommand(flow);

    expect(inferObviousTurnUnderstanding(flow, "correct")).toMatchObject({
      goal: "manage_existing_appointment",
      appointmentAction: "cancel",
      confirmation: {
        cancelConfirmed: true,
      },
    });
  });

  it("creates a reducer-owned cancel action from explicit confirmation", () => {
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
    applyPlannerCommand(flow);

    const understanding = inferObviousTurnUnderstanding(flow, "yes");
    expect(understanding).toMatchObject({
      confirmation: { cancelConfirmed: true },
    });

    reduceFlowEvent(
      flow,
      callerTurnMeaningEvent({
        transcript: "yes",
        understanding: understanding!,
        flow,
      }),
    );

    expect(flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "cancel_appt",
        appointmentId: 12345,
        argsHash: hashToolArgs({ appointmentId: 12345 }),
        confirmed: true,
        consumed: false,
      }),
    );
  });

  it("confirms a tool-requested cancellation with natural caller wording", () => {
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
    const argsHash = hashToolArgs({ appointmentId: 12345 });
    reduceFlowEvent(flow, {
      id: nextFlowEventId("test_cancel_confirmation_request"),
      type: "side_effect_confirmation_requested",
      source: "tool_result",
      createdAt: Date.now(),
      toolName: "cancel_appt",
      argsHash,
      patientRef: "caller",
      appointmentId: 12345,
      spokenSummary: "Cancel June first at 9 AM with Doctor Bach.",
      toolCallId: "tool-cancel-1",
    });

    expect(inferObviousTurnUnderstanding(flow, "Yes, correct.")).toMatchObject({
      confirmation: { cancelConfirmed: true },
    });

    const understanding = inferObviousTurnUnderstanding(
      flow,
      "Yes, I want to cancel.",
    );
    reduceFlowEvent(
      flow,
      callerTurnMeaningEvent({
        transcript: "Yes, I want to cancel.",
        understanding: understanding!,
        flow,
      }),
    );

    expect(flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "cancel_appt",
        appointmentId: 12345,
        argsHash,
        confirmed: true,
        consumed: false,
      }),
    );
  });

  it("confirms a pending registration action from reducer state", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      callerPhone: "+15551234567",
    });
    const argsHash = hashToolArgs({
      firstName: "Jane",
      lastName: "Doe",
    });
    reduceFlowEvent(flow, {
      id: nextFlowEventId("test_registration_request"),
      type: "side_effect_confirmation_requested",
      source: "tool_result",
      createdAt: Date.now(),
      toolName: "add_patient",
      argsHash,
      spokenSummary: "Create the confirmed patient registration.",
      patientRef: "caller",
      requiredFieldsComplete: true,
      toolCallId: "tool-add-patient-1",
    });

    expect(flow.pendingConfirmation).toMatchObject({
      type: "registration",
    });
    expect(flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "add_patient",
        argsHash,
        confirmed: false,
      }),
    );

    const understanding = inferObviousTurnUnderstanding(flow, "yes");
    expect(understanding).toMatchObject({
      confirmation: { registrationConfirmed: true },
    });

    reduceFlowEvent(
      flow,
      callerTurnMeaningEvent({
        transcript: "yes",
        understanding: understanding!,
        flow,
      }),
    );

    expect(flow.pendingConfirmation).toBeUndefined();
    expect(flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "add_patient",
        argsHash,
        confirmed: true,
        consumed: false,
      }),
    );
  });

  it("treats 'I confirm' as booking confirmation in a scheduling flow", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });
    flow.activeIntent = "new_appointment";
    flow.activeFlow = "scheduling";
    flow.patientStatus = "verified";
    flow.step = "confirm_booking";
    flow.visitType = "medical";
    flow.coverageType = "medical";
    flow.routing = "all_three";
    flow.schedulingGoal = {
      status: "confirming_booking",
      patientRef: "caller",
      appointmentAction: "schedule",
      visitReason: "retina check",
      selectedSlotId: "G",
      updatedAt: Date.now(),
    };

    const understanding = inferObviousTurnUnderstanding(flow, "I confirm—");

    expect(understanding).toMatchObject({
      goal: "schedule",
      scheduling: {
        selectedSlotId: "G",
        bookingConfirmed: true,
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

function bookingConfirmationTurn(bookingConfirmed: boolean): TurnUnderstanding {
  return {
    goal: "schedule",
    appointmentAction: null,
    scheduling: {
      selectedSlotId: "A",
      bookingConfirmed,
    },
    interruption: "none",
    confidence: 0.95,
    evidence: [bookingConfirmed ? "yes" : "no"],
  };
}
