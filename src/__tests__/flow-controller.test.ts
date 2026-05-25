import { describe, expect, it } from "vitest";
import {
  applyTurnUnderstandingFromTranscript,
  advanceFlowForTurn,
  classifyVisitType,
  compileFlowContextPacket,
  compileTurnStatePacket,
  completeCurrentTaskAndResume,
  createInitialFlowState,
  createPendingBookingAction,
  createPendingSideEffectAction,
  createFlowShadowPrediction,
  hasActivePatientIdentityChanged,
  hashToolArgs,
  invalidateAvailabilitySearches,
  invalidatePendingActionsForStateChange,
  observeFlowToolExecution,
  applyPlannerPatch,
  flowDecisionForWorkflowCommand,
  planNextCommand,
  prepareSchedulingPath,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  recordBookingAttempt,
  recordBookingResult,
  recordPatientVerificationAttempt,
  recordVerifiedPatient,
  resumePatientTask,
  startPatientTask,
  snapshotActivePatientIdentity,
  turnUnderstandingToInferredIntent,
  type TurnUnderstanding,
} from "../flow/index.js";

describe("flow state and context packet", () => {
  it("initializes matched patient state from phone lookup without treating it as verified", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      routing: "all_three",
    });

    expect(flow).toMatchObject({
      activeIntent: null,
      activeFlow: "intro",
      step: "understand_intent",
      patientStatus: "matched",
      activePatientRef: "caller",
      officeKey: "spring-hill",
      routing: "all_three",
      patients: {
        caller: {
          status: "matched",
          patientId: "patient-1",
        },
      },
      pendingActions: [],
      availabilitySearches: [],
    });
  });

  it("compiles a small state packet with allowed and blocked actions", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.activeFlow = "insurance";
    flow.step = "check_insurance";
    flow.visitType = "routine_vision";
    flow.coverageType = "routine_vision";
    flow.requiredSlots = ["insurancePlan"];

    const packet = compileFlowContextPacket(flow);

    expect(packet).toContain("<flow_state>");
    expect(packet).toContain("activeFlow: insurance");
    expect(packet).toContain("activeIntent: unknown");
    expect(packet).toContain("step: check_insurance");
    expect(packet).toContain("activePatient: caller");
    expect(packet).toContain("availabilitySearches: 0");
    expect(packet).toContain("missingSlots: insurancePlan");
    expect(packet).toContain("allowedActions: ask_insurance_plan");
    expect(packet).toContain("prepareSchedulingPath");
    expect(packet).toContain("blockedActions: add_patient");
    expect(packet).toContain("<current_objective>");
  });

  it("compiles compact turn state for model-visible dynamic context", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
    });
    flow.activeIntent = "existing_appointment_confirm";
    flow.activeFlow = "appointment_management";
    flow.step = "verify_patient";

    const packet = compileTurnStatePacket(flow);

    expect(packet).toContain("<turn_state>");
    expect(packet).toContain("intent: existing_appointment_confirm");
    expect(packet).toContain("activePatient: caller");
    expect(packet).toContain("patientStatus: matched_not_verified");
    expect(packet).toContain("task: appointment_management");
    expect(packet).toContain("step: verify_patient");
    expect(packet).toContain("nextAction: ask_patient_name");
    expect(packet).toContain("blockedActions: add_patient");
    expect(packet).toContain("<context_capsules>");
    expect(packet).toContain("objective: verify patient");
    expect(packet).not.toContain("patient-1");
  });

  it("injects loaded appointment and pending confirmation capsules", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
      appointments: [
        {
          id: 12345,
          date: "2026-06-01",
          time: "9:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });
    flow.activeFlow = "appointment_management";
    flow.step = "confirm_cancel";
    flow.pendingConfirmation = {
      type: "cancel",
      payload: { appointmentId: 12345 },
    };
    createPendingSideEffectAction(flow, {
      type: "cancel_appt",
      argsHash: hashToolArgs({ appointmentId: 12345 }),
      spokenSummary: "Cancel June first at 9 AM with Dr. Bach",
      appointmentId: 12345,
      confirmed: false,
      createdTurnId: "turn-1",
    });

    const packet = compileTurnStatePacket(flow);

    expect(packet).toContain("<context_capsules>");
    expect(packet).toContain("step: read back exact loaded appointment");
    expect(packet).toContain("appointments: loaded=1");
    expect(packet).toContain("pendingConfirmation=cancel");
    expect(packet).toContain("pendingActions=cancel_appt:needs_confirmation");
    expect(packet).not.toContain("12345");
    expect(packet).not.toContain("patient-1");
  });

  it("maps structured turn understanding to appointment and scheduling intents", () => {
    expect(
      turnUnderstandingToInferredIntent(
        appointmentManagementTurn("reschedule"),
      ),
    ).toMatchObject({
      activeIntent: "existing_appointment_reschedule",
    });
    expect(
      turnUnderstandingToInferredIntent(appointmentManagementTurn("confirm")),
    ).toMatchObject({
      activeIntent: "existing_appointment_confirm",
    });
    expect(
      turnUnderstandingToInferredIntent(
        scheduleTurn({
          visitReason: "glaucoma follow up",
          visitType: "medical",
        }),
      ),
    ).toMatchObject({
      activeIntent: "new_appointment",
      coverageType: "medical",
    });
  });

  it("writes active intent without clearing it on ambiguous backchannels", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const first = applyTurnUnderstandingFromTranscript(
      flow,
      "do you take VSP for routine vision",
      insuranceTurn({
        plan: "VSP",
        coverageType: "routine_vision",
      }),
    );
    const backchannel = applyTurnUnderstandingFromTranscript(
      flow,
      "yes",
      backchannelTurn(),
    );

    expect(first).toMatchObject({
      changed: true,
      inferred: {
        activeIntent: "insurance_question",
        coverageType: "routine_vision",
      },
    });
    expect(flow).toMatchObject({
      activeIntent: "insurance_question",
      activeFlow: "insurance",
      step: "check_insurance",
      requiredSlots: ["insurancePlan"],
    });
    expect(backchannel).toMatchObject({
      changed: false,
      inferred: { activeIntent: "unclear" },
    });
    expect(flow.activeIntent).toBe("insurance_question");
  });

  it("does not resolve meta state changes for low-confidence unclear turns", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.activeIntent = "insurance_question";
    flow.activeFlow = "insurance";
    flow.step = "check_insurance";
    flow.visitType = "routine_vision";
    flow.coverageType = "routine_vision";
    flow.routing = "optical_only";

    const before = {
      activeIntent: flow.activeIntent,
      activeFlow: flow.activeFlow,
      step: flow.step,
      visitType: flow.visitType,
      coverageType: flow.coverageType,
      routing: flow.routing,
    };
    const result = advanceFlowForTurn({
      flow,
      transcript: "uh, maybe, I'm not sure",
      understanding: {
        goal: "unclear",
        appointmentAction: null,
        interruption: "none",
        confidence: 0.32,
        evidence: ["not sure"],
      },
    });

    expect(result.decision).toMatchObject({
      type: "ask",
      slot: "clarification",
    });
    expect({
      activeIntent: flow.activeIntent,
      activeFlow: flow.activeFlow,
      step: flow.step,
      visitType: flow.visitType,
      coverageType: flow.coverageType,
      routing: flow.routing,
    }).toEqual(before);
  });

  it("keeps new-patient registration status aligned while collecting identity facts", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    advanceFlowForTurn({
      flow,
      transcript: "I am a new patient and need a routine eye exam",
      understanding: {
        goal: "register_new_patient",
        appointmentAction: null,
        patient: {
          patientMentioned: "caller",
          relationshipToCaller: "self",
        },
        scheduling: {
          visitReason: "routine eye exam",
          visitType: "routine_vision",
        },
        interruption: "none",
        confidence: 0.93,
        evidence: ["new patient", "routine eye exam"],
      },
    });

    expect(flow.patientStatus).toBe("new");
    expect(flow.patients.caller.status).toBe("new");

    advanceFlowForTurn({
      flow,
      transcript: "my first name is Maria",
      understanding: {
        goal: "register_new_patient",
        appointmentAction: null,
        patient: {
          patientMentioned: "caller",
          relationshipToCaller: "self",
          firstName: "Maria",
        },
        interruption: "none",
        confidence: 0.9,
        evidence: ["first name is Maria"],
      },
    });

    expect(flow.patientStatus).toBe("new");
    expect(flow.patients.caller).toMatchObject({
      status: "new",
      firstName: { value: "Maria" },
    });
    expect(flow.patientStatus).not.toBe("candidate");
  });

  it("records patient verification attempts into canonical patient state", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const patient = recordPatientVerificationAttempt(flow, {
      firstName: "Jane",
      lastName: "Smith",
      dob: "01/02/1980",
    });

    expect(patient).toMatchObject({
      ref: "caller",
      status: "candidate",
      verificationAttempts: 1,
      firstName: {
        value: "Jane",
        source: "caller_spoken",
      },
      lastName: {
        value: "Smith",
        source: "caller_spoken",
      },
      dob: {
        value: "01/02/1980",
      },
    });
    expect(patient.lastVerifiedArgsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(flow.patientStatus).toBe("candidate");
    expect(flow.step).toBe("verify_patient");
  });

  it("switches to a separate candidate when verification facts conflict with the active patient", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });
    const before = snapshotActivePatientIdentity(flow);

    const patient = recordPatientVerificationAttempt(flow, {
      firstName: "Emily",
      lastName: "Doe",
      dob: "02/03/2012",
      source: "caller_spelled",
    });

    expect(flow.activePatientRef).toMatch(/^candidate:/);
    expect(hasActivePatientIdentityChanged(flow, before)).toBe(true);
    expect(patient).toMatchObject({
      ref: flow.activePatientRef,
      status: "candidate",
      firstName: {
        value: "Emily",
        source: "caller_spelled",
        confirmed: true,
      },
      lastName: {
        value: "Doe",
        source: "caller_spelled",
        confirmed: true,
      },
      spellingConfirmed: true,
    });
    expect(flow.patients.caller).toMatchObject({
      patientId: "patient-1",
    });
  });

  it("tracks relationship to caller on patient candidates", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });

    const patient = recordPatientVerificationAttempt(flow, {
      firstName: "Emily",
      lastName: "Doe",
      dob: "02/03/2012",
      relationshipToCaller: "child",
    });

    expect(flow.activePatientRef).toMatch(/^candidate:/);
    expect(patient).toMatchObject({
      relationshipToCaller: "child",
      firstName: { value: "Emily" },
    });
    expect(flow.patients.caller).toMatchObject({
      relationshipToCaller: "self",
    });
  });

  it("suspends and resumes patient-scoped tasks without mixing patients", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });

    const scheduleTask = startPatientTask(flow, {
      kind: "schedule",
      step: "get_availability",
      patientRef: "caller",
      createdAt: 100,
    });
    flow.patients["patient:child"] = {
      ...flow.patients.caller,
      ref: "patient:child",
      relationshipToCaller: "child",
      patientId: "patient-2",
      appointments: [],
      activeAppointmentTaskIds: [],
    };
    const childTask = startPatientTask(flow, {
      kind: "appointment_management",
      step: "confirm_cancel",
      patientRef: "patient:child",
      createdAt: 200,
    });

    expect(flow.currentTask).toMatchObject({
      id: childTask.id,
      kind: "appointment_management",
      patientRef: "patient:child",
    });
    expect(flow.taskStack).toEqual([
      expect.objectContaining({ id: scheduleTask.id, patientRef: "caller" }),
    ]);
    expect(flow.patients.caller.activeSchedulingTaskId).toBe(scheduleTask.id);
    expect(flow.patients["patient:child"].activeAppointmentTaskIds).toContain(
      childTask.id,
    );

    const resumed = resumePatientTask(flow, { patientRef: "caller" });

    expect(resumed).toMatchObject({
      id: scheduleTask.id,
      patientRef: "caller",
      step: "get_availability",
    });
    expect(flow.activePatientRef).toBe("caller");
    expect(flow.currentTask?.id).toBe(scheduleTask.id);
    expect(flow.taskStack).toEqual([
      expect.objectContaining({
        id: childTask.id,
        patientRef: "patient:child",
      }),
    ]);
  });

  it("returns from a quick-question interruption to the suspended task", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });

    applyTurnUnderstandingFromTranscript(
      flow,
      "I need to schedule a glaucoma visit",
      scheduleTurn({ visitReason: "glaucoma visit", visitType: "medical" }),
    );
    const scheduleTask = flow.currentTask!;
    applyTurnUnderstandingFromTranscript(
      flow,
      "what are your hours",
      faqTurn("hours"),
    );

    expect(flow.currentTask).toMatchObject({
      kind: "faq",
      returnTo: scheduleTask.id,
    });
    expect(flow.taskStack).toEqual([
      expect.objectContaining({
        id: scheduleTask.id,
        kind: "schedule",
        step: "verify_patient",
      }),
    ]);

    const resumed = completeCurrentTaskAndResume(flow);

    expect(resumed).toMatchObject({
      id: scheduleTask.id,
      kind: "schedule",
      step: "verify_patient",
    });
    expect(flow.currentTask?.id).toBe(scheduleTask.id);
    expect(flow.activeFlow).toBe("scheduling");
  });

  it("invalidates patient-bound availability and pending actions after an active patient switch", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });
    recordAvailabilityCachedSlots(flow, [{ slotId: "A" }]);
    createPendingBookingAction(flow, {
      slotHash: "A",
      appointmentTypeId: 1007,
      officeKey: "spring-hill",
      routing: "all_three",
      spokenSummary: "2026-06-01 9:00 with Dr. Bach",
      confirmed: true,
      createdTurnId: "test-create-booking-action",
      confirmationTurnId: "test-confirm-booking",
    });
    createPendingSideEffectAction(flow, {
      type: "update_insurance",
      argsHash: hashToolArgs({
        insurance: "Aetna",
        subscriberName: "Jane Doe",
        subscriberNum: "ABC123",
      }),
      spokenSummary: "confirmed insurance update",
      confirmed: true,
      createdTurnId: "test-create-insurance-action",
      confirmationTurnId: "test-confirm-insurance",
    });

    recordPatientVerificationAttempt(flow, {
      firstName: "Emily",
      lastName: "Doe",
      dob: "02/03/2012",
    });
    invalidateAvailabilitySearches(flow, "patient_changed");
    invalidatePendingActionsForStateChange(flow, "patient_changed");

    expect(flow.activePatientRef).toMatch(/^candidate:/);
    expect(flow.availabilitySearches[0]).toMatchObject({
      status: "invalidated",
      lastInvalidationReason: "patient_changed",
    });
    expect(flow.pendingActions).toEqual([
      expect.objectContaining({
        type: "book_appt",
        invalidated: true,
        slotInvalidated: true,
        invalidationReason: "patient_changed",
      }),
      expect.objectContaining({
        type: "update_insurance",
        invalidated: true,
        invalidationReason: "patient_changed",
      }),
    ]);
  });

  it("hydrates a verified candidate without overwriting the original patient context", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
    });
    recordPatientVerificationAttempt(flow, {
      firstName: "Emily",
      lastName: "Doe",
      dob: "02/03/2012",
    });
    const candidateRef = flow.activePatientRef!;

    const result = recordVerifiedPatient(flow, {
      patientId: "patient-2",
      patientName: "Emily Doe",
      dob: "02/03/2012",
      appointments: [
        {
          id: 456,
          date: "2026-06-02",
          time: "10:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });

    expect(result).toMatchObject({
      activePatientRef: candidateRef,
      switchedPatient: false,
      patient: {
        patientId: "patient-2",
        status: "verified",
        appointments: [expect.objectContaining({ id: 456 })],
      },
    });
    expect(flow.patients.caller).toMatchObject({
      patientId: "patient-1",
    });
  });

  it("keeps appointment lookup active after verifying an appointment-management patient", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
    });
    flow.activeFlow = "appointment_management";
    flow.activeIntent = "existing_appointment_confirm";
    flow.step = "verify_patient";
    startPatientTask(flow, {
      kind: "appointment_management",
      step: "verify_patient",
      patientRef: "caller",
      createdAt: 1,
    });
    recordPatientVerificationAttempt(flow, {
      firstName: "Tree",
      phone: "+19546097250",
      usePhone: true,
      relationshipToCaller: "self",
      source: "caller_spelled",
    });

    recordVerifiedPatient(flow, {
      patientId: "6050016",
      patientName: "TEST,TREE",
      dob: "01/01/1987",
      phone: "(195) 460-97250",
      appointments: [],
    });

    expect(flow).toMatchObject({
      activeFlow: "appointment_management",
      activeIntent: "existing_appointment_confirm",
      patientStatus: "verified",
      step: "answer",
      currentTask: {
        kind: "appointment_management",
        step: "answer",
      },
    });
    expect(flowDecisionForWorkflowCommand(planNextCommand(flow))).toMatchObject(
      {
        type: "call_tool",
        tool: "confirm_appt",
      },
    );
  });

  it("records availability search signatures and budget state", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";

    const first = recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
      maxSearches: 2,
    });
    const duplicate = recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
      maxSearches: 2,
    });
    const secondDate = recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-02",
      maxSearches: 2,
    });

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(secondDate.exhausted).toBe(true);
    expect(flow.availabilitySearches[0]).toMatchObject({
      exactSearchCount: 2,
      duplicateSearchCount: 1,
      status: "exhausted",
      failureReasons: ["duplicate_search", "budget_exhausted"],
    });
  });

  it("hydrates cached availability slots on the active search", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });

    const search = recordAvailabilityCachedSlots(flow, [
      {
        slotId: "A",
        datetime: "2026-06-01T09:00",
        columnId: 12,
        profileId: 34,
        duration: 15,
      },
    ]);

    expect(search).toMatchObject({
      status: "satisfied",
      cachedSlots: [
        {
          slotHash: "A",
          startDatetime: "2026-06-01T09:00",
          columnId: 12,
          profileId: 34,
          duration: 15,
        },
      ],
    });
  });

  it("dedupes repeated availability searches after slots have been cached", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";

    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });
    recordAvailabilityCachedSlots(flow, [{ slotId: "A" }]);

    const duplicate = recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });

    expect(duplicate).toMatchObject({
      duplicate: true,
      search: {
        id: "availability_1",
        status: "satisfied",
        exactSearchCount: 1,
        duplicateSearchCount: 1,
        failureReasons: ["duplicate_search"],
      },
    });
    expect(flow.availabilitySearches).toHaveLength(1);
  });

  it("clears satisfied availability status when a follow-up search returns no slots", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";

    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });
    recordAvailabilityCachedSlots(flow, [{ slotId: "A" }]);
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-02",
    });

    const search = recordAvailabilityCachedSlots(flow, []);

    expect(search).toMatchObject({
      status: "active",
      cachedSlots: [],
      failureReasons: ["no_slots"],
      exactSearchCount: 2,
    });
  });

  it("does not create a confirmed booking action while recording an attempt", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
    });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });
    recordAvailabilityCachedSlots(flow, [{ slotId: "A" }]);

    const attempt = recordBookingAttempt(flow, {
      slotHash: "A",
      appointmentTypeId: 1007,
      officeKey: "spring-hill",
      routing: "all_three",
      spokenSummary: "2026-06-01 9:00 with Dr. Bach",
    });

    expect(attempt).toMatchObject({
      availabilitySearch: { id: "availability_1" },
    });
    expect(attempt.action).toBeUndefined();
    expect(flow.pendingActions).toHaveLength(0);
  });

  it("records no-slot availability results without losing the search budget", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });

    const search = recordAvailabilityCachedSlots(flow, []);

    expect(search).toMatchObject({
      status: "active",
      cachedSlots: [],
      failureReasons: ["no_slots"],
      exactSearchCount: 1,
    });
  });

  it("treats partial booking responses with an appointment ID as booked", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
    });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });
    recordAvailabilityCachedSlots(flow, [{ slotId: "A" }]);
    createPendingBookingAction(flow, {
      slotHash: "A",
      appointmentTypeId: 1007,
      officeKey: "spring-hill",
      routing: "all_three",
      spokenSummary: "2026-06-01 9:00 with Dr. Bach",
      confirmed: true,
      createdTurnId: "test-create-booking-action",
      confirmationTurnId: "test-confirm-booking",
    });

    const attempt = recordBookingAttempt(flow, {
      slotHash: "A",
      appointmentTypeId: 1007,
      officeKey: "spring-hill",
      routing: "all_three",
      spokenSummary: "2026-06-01 9:00 with Dr. Bach",
    });
    const result = recordBookingResult(flow, attempt.action!.id, {
      status: "partial",
      appointmentId: 12345,
      noteStatus: "failed",
    });

    expect(result).toMatchObject({
      consumed: true,
      action: {
        type: "book_appt",
        consumed: true,
      },
      availabilitySearch: {
        status: "invalidated",
        lastInvalidationReason: "booking_completed",
      },
    });
  });

  it("records booking attempts and rejects stale slots in report-only state", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
    });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });
    recordAvailabilityCachedSlots(flow, [
      {
        slotId: "A",
        datetime: "2026-06-01T09:00",
        columnId: 12,
        profileId: 34,
        duration: 15,
      },
      {
        slotId: "B",
        datetime: "2026-06-01T10:00",
        columnId: 12,
        profileId: 34,
        duration: 15,
      },
    ]);
    createPendingBookingAction(flow, {
      slotHash: "A",
      appointmentTypeId: 1007,
      officeKey: "spring-hill",
      routing: "all_three",
      spokenSummary: "2026-06-01 9:00 with Dr. Bach",
      confirmed: true,
      createdTurnId: "test-create-booking-action",
      confirmationTurnId: "test-confirm-booking",
    });

    const attempt = recordBookingAttempt(flow, {
      slotHash: "A",
      appointmentTypeId: 1007,
      officeKey: "spring-hill",
      routing: "all_three",
      spokenSummary: "2026-06-01 9:00 with Dr. Bach",
    });
    expect(attempt.action).toBeDefined();
    const result = recordBookingResult(flow, attempt.action!.id, {
      status: "error",
      outcome: "slot_unavailable",
      message: "Slot is no longer available.",
    });

    expect(attempt).toMatchObject({
      availabilitySearch: { id: "availability_1" },
      action: {
        type: "book_appt",
        patientRef: "caller",
        slotHash: "A",
        appointmentTypeId: 1007,
        availabilitySearchId: "availability_1",
        bookingAttemptCount: 1,
      },
    });
    expect(result).toMatchObject({
      consumed: false,
      errorClass: "slot_unavailable",
      action: {
        slotInvalidated: true,
        lastBookingErrorClass: "slot_unavailable",
      },
    });
    expect(flow.availabilitySearches[0]).toMatchObject({
      status: "satisfied",
      rejectedSlotHashes: ["A"],
      failureReasons: ["slot_unavailable"],
    });
  });

  it("invalidates the availability lane after invalid appointment type booking errors", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
    });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });
    recordAvailabilityCachedSlots(flow, [{ slotId: "A" }]);
    createPendingBookingAction(flow, {
      slotHash: "A",
      appointmentTypeId: 1007,
      officeKey: "spring-hill",
      routing: "all_three",
      spokenSummary: "2026-06-01 9:00 with Dr. Bach",
      confirmed: true,
      createdTurnId: "test-create-booking-action",
      confirmationTurnId: "test-confirm-booking",
    });

    const attempt = recordBookingAttempt(flow, {
      slotHash: "A",
      appointmentTypeId: 1007,
      officeKey: "spring-hill",
      routing: "all_three",
      spokenSummary: "2026-06-01 9:00 with Dr. Bach",
    });
    expect(attempt.action).toBeDefined();
    recordBookingResult(flow, attempt.action!.id, {
      status: "error",
      outcome: "invalid_appointment_type",
      message: "Invalid appointment type for this slot.",
    });

    expect(flow.availabilitySearches[0]).toMatchObject({
      status: "invalidated",
      lastInvalidationReason: "appointment_type_invalid",
      failureReasons: ["invalid_appointment_type"],
    });
    expect(flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      consumed: false,
      slotInvalidated: true,
      lastBookingErrorClass: "invalid_appointment_type",
    });
  });
});

describe("prepareSchedulingPath", () => {
  it("asks for visit type before checking insurance or scheduling", () => {
    const outcome = prepareSchedulingPath({
      officeKey: "spring-hill",
      patientStatus: "unknown",
    });

    expect(outcome).toMatchObject({
      outcome: "needs_clarification",
      nextStep: "triage_visit_type",
      statePatch: {
        activeFlow: "intent",
        step: "triage_visit_type",
        requiredSlots: ["visitReason"],
      },
    });
  });

  it("routes Crystal River routine vision to Spring Hill before scheduling", () => {
    const outcome = prepareSchedulingPath({
      officeKey: "crystal-river",
      patientStatus: "unknown",
      visitReason: "routine eye exam for glasses",
    });

    expect(outcome).toMatchObject({
      outcome: "route_required",
      nextStep: "route_office",
      facts: {
        visitType: "routine_vision",
        coverageType: "routine_vision",
        allowedOffice: "spring-hill",
        routing: "optical_only",
      },
    });
  });

  it("transfers optical shop tasks instead of scheduling them", () => {
    const outcome = prepareSchedulingPath({
      officeKey: "spring-hill",
      patientStatus: "verified",
      visitReason: "I need to pick up my glasses",
    });

    expect(outcome.outcome).toBe("transfer_required");
    expect(outcome.nextStep).toBe("handoff");
  });

  it("routes Crystal River medical plans accepted at Spring Hill", () => {
    const outcome = prepareSchedulingPath({
      officeKey: "crystal-river",
      patientStatus: "verified",
      visitReason: "glaucoma follow up",
      insurancePlan: "Humana PPO",
      coverageType: "medical",
    });

    expect(outcome).toMatchObject({
      outcome: "route_required",
      nextStep: "route_office",
      facts: {
        allowedOffice: "spring-hill",
        canonicalPlan: "Humana PPO",
        acceptedAtAlternateOffice: "spring-hill",
      },
    });
  });

  it("accepts Spring Hill routine vision insurance and moves to registration for a new patient", () => {
    const outcome = prepareSchedulingPath({
      officeKey: "spring-hill",
      patientStatus: "new",
      visitReason: "annual eye exam",
      insurancePlan: "VSP",
    });

    expect(outcome).toMatchObject({
      outcome: "success",
      nextStep: "collect_registration",
      facts: {
        visitType: "routine_vision",
        coverageType: "routine_vision",
        routing: "optical_only",
        canonicalPlan: "VSP",
      },
    });
  });

  it("classifies urgent symptoms before routine scheduling", () => {
    expect(classifyVisitType("sudden vision loss and severe eye pain")).toBe(
      "urgent",
    );
  });

  it("does not classify a bare insurance question as medical", () => {
    expect(classifyVisitType("do you take Care Plus")).toBeNull();
  });

  it("recognizes Spanish routine vision phrases", () => {
    expect(classifyVisitType("necesito un examen de la vista")).toBe(
      "routine_vision",
    );
  });
});

describe("task-plan command planner", () => {
  it("asks for visit type before answering a bare insurance question", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.activeIntent = "insurance_question";
    flow.activeFlow = "insurance";
    flow.step = "triage_visit_type";
    flow.requiredSlots = ["visitReason"];

    const decision = flowDecisionForWorkflowCommand(planNextCommand(flow));

    expect(decision).toMatchObject({
      type: "ask",
      slot: "visitReason",
    });
  });

  it("distinguishes appointment lookup, cancellation, and reschedule commands", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
      appointments: [
        {
          id: 123,
          date: "2026-06-01",
          time: "9:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";

    flow.activeIntent = "existing_appointment_confirm";
    expect(flowDecisionForWorkflowCommand(planNextCommand(flow))).toMatchObject(
      {
        type: "say",
      },
    );
    flow.activeIntent = "existing_appointment_cancel";
    expect(flowDecisionForWorkflowCommand(planNextCommand(flow))).toMatchObject(
      {
        type: "confirm",
        confirmation: { type: "cancel" },
      },
    );
    flow.activeIntent = "existing_appointment_reschedule";
    expect(flowDecisionForWorkflowCommand(planNextCommand(flow))).toMatchObject(
      {
        type: "ask",
        slot: "preferredDate",
      },
    );
  });

  it("requires patient verification before appointment management decisions", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
      appointments: [
        {
          id: 123,
          date: "2026-06-01",
          time: "9:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });
    flow.activeIntent = "existing_appointment_cancel";

    expect(flowDecisionForWorkflowCommand(planNextCommand(flow))).toMatchObject(
      {
        type: "ask",
        slot: "patientIdentity",
      },
    );
  });

  it("requires confirmation before office routing", () => {
    const flow = createInitialFlowState({ officeKey: "crystal-river" });
    flow.activeIntent = "new_appointment";
    flow.activeFlow = "scheduling";
    flow.schedulingGoal = {
      patientRef: "caller",
      status: "collecting",
      appointmentAction: "schedule",
      visitReason: "routine eye exam",
      visitType: "routine_vision",
      updatedAt: Date.now(),
    };

    const decision = flowDecisionForWorkflowCommand(planNextCommand(flow));

    expect(decision).toMatchObject({
      type: "confirm",
      confirmation: { type: "route_office" },
    });
  });
});

describe("deterministic turn router", () => {
  it("resolves scheduling meta-decisions into a concrete next action", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const turn = advanceFlowForTurn({
      flow,
      transcript: "I need a glaucoma follow up",
      understanding: scheduleTurn({
        visitReason: "glaucoma follow up",
        visitType: "medical",
      }),
    });

    expect(turn.resolvedMetaDecision).toMatchObject({
      tool: "prepareSchedulingPath",
      outcome: { outcome: "needs_clarification" },
    });
    expect(turn.decision).toMatchObject({
      type: "ask",
      slot: "patientIdentity",
    });
    expect(turn.instruction).toContain("patient");
    expect(flow).toMatchObject({
      activeFlow: "scheduling",
      step: "verify_patient",
      visitType: "medical",
      coverageType: "medical",
    });
  });

  it("uses pre-call first-name confirmation to skip verification and ask for date", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });

    const turn = advanceFlowForTurn({
      flow,
      transcript: "This is Jane, I need a glaucoma follow up",
      understanding: scheduleTurn({
        visitReason: "glaucoma follow up",
        visitType: "medical",
      }),
    });

    expect(turn.decision).toMatchObject({
      type: "ask",
      slot: "preferredDate",
    });
    expect(flow).toMatchObject({
      patientStatus: "verified",
      step: "get_availability",
    });
  });

  it("advances a stale triage scheduling step once visit context arrives", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.activeIntent = "new_appointment";
    flow.activeFlow = "scheduling";
    flow.step = "triage_visit_type";
    flow.requiredSlots = ["visitReason"];
    startPatientTask(flow, { kind: "schedule", step: "triage_visit_type" });

    const turn = advanceFlowForTurn({
      flow,
      transcript: "it's blurry",
      understanding: scheduleTurn({
        visitReason: "blurry vision",
        visitType: "medical",
      }),
    });

    expect(turn.decision).toMatchObject({
      type: "ask",
      slot: "preferredDate",
    });
    expect(flow).toMatchObject({
      activeFlow: "scheduling",
      step: "get_availability",
      visitType: "medical",
      coverageType: "medical",
      requiredSlots: [],
      currentTask: {
        kind: "schedule",
        step: "get_availability",
      },
    });
  });

  it("preserves booking confirmation steps instead of re-running path setup", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });
    flow.activeIntent = "new_appointment";
    flow.activeFlow = "scheduling";
    flow.step = "confirm_booking";
    flow.visitType = "medical";
    flow.coverageType = "medical";
    flow.schedulingGoal = {
      patientRef: "caller",
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "glaucoma follow up",
      selectedSlotId: "slot-1",
      updatedAt: Date.now(),
    };

    const turn = advanceFlowForTurn({
      flow,
      transcript: "yes that time works",
      understanding: scheduleTurn({ bookingConfirmed: true }),
    });

    expect(turn.resolvedMetaDecision).toBeUndefined();
    expect(turn.decision).toMatchObject({
      type: "call_tool",
      tool: "book_appt",
      args: { slotId: "slot-1", appointmentKind: "medical" },
    });
    expect(turn.turnState).toContain("nextAction: book_appt");
    expect(flow).toMatchObject({
      activeFlow: "scheduling",
      step: "confirm_booking",
      schedulingGoal: {
        status: "confirming_booking",
        bookingConfirmed: true,
        selectedSlotId: "slot-1",
      },
    });
  });

  it("honors booking confirmation even if availability left the flow step stale", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.activeIntent = "new_appointment";
    flow.activeFlow = "scheduling";
    flow.step = "get_availability";
    flow.visitType = "medical";
    flow.coverageType = "medical";
    flow.schedulingGoal = {
      patientRef: "caller",
      status: "ready_for_availability",
      appointmentAction: "schedule",
      visitReason: "glaucoma follow up",
      preferredWindow: "Monday morning",
      selectedSlotId: "slot-1",
      updatedAt: Date.now(),
    };

    const turn = advanceFlowForTurn({
      flow,
      transcript: "yes that time works",
      understanding: scheduleTurn({ bookingConfirmed: true }),
    });

    expect(turn.decision).toMatchObject({
      type: "call_tool",
      tool: "book_appt",
      args: { slotId: "slot-1", appointmentKind: "medical" },
    });
    expect(turn.decision).not.toMatchObject({
      type: "call_tool",
      tool: "get_availability",
    });
  });

  it("uses the task-plan frontier to search replacement availability for reschedule", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Tree",
      dob: "1987-01-01",
      appointments: [
        {
          id: 12345,
          date: "2026-06-01",
          time: "8:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";

    const turn = advanceFlowForTurn({
      flow,
      transcript: "Move my Dr. Bach appointment to Monday at 1 PM",
      understanding: {
        goal: "manage_existing_appointment",
        appointmentAction: "reschedule",
        patient: {
          patientMentioned: "caller",
          relationshipToCaller: "self",
        },
        scheduling: {
          preferredWindow: "Monday at 1 PM",
        },
        interruption: "none",
        confidence: 0.94,
        evidence: ["Dr. Bach", "Monday at 1 PM"],
      },
    });

    expect(turn.workflowCommand).toMatchObject({
      taskKind: "appointment_reschedule",
      phase: "searching_replacement",
      nextAction: "call_tool",
      tool: "get_availability",
      allowedTools: ["get_availability"],
      missingFacts: [
        expect.objectContaining({ key: "replacementAvailability" }),
      ],
    });
    expect(turn.decision).toMatchObject({
      type: "call_tool",
      tool: "get_availability",
    });
    expect(turn.turnState).toContain("phase: searching_replacement");
    expect(turn.turnState).toContain("allowedTools: get_availability");
    expect(flow).toMatchObject({
      step: "get_availability",
      visitType: "medical",
      lastWorkflowCommand: {
        tool: "get_availability",
      },
    });
  });

  it("closes appointment-confirm plans after appointment details are loaded", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Tree",
      dob: "1987-01-01",
      appointments: [
        {
          id: 12345,
          date: "2026-06-01",
          time: "8:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.activeIntent = "existing_appointment_confirm";
    flow.activeFlow = "appointment_management";
    startPatientTask(flow, {
      kind: "appointment_management",
      step: "answer",
    });

    const command = planNextCommand(flow);
    applyPlannerPatch(flow, command);

    expect(command).toMatchObject({
      taskKind: "appointment_confirm",
      phase: "complete",
      nextAction: "respond",
      allowedTools: [],
      missingFacts: [],
    });
  });

  it("asks which old appointment to move when target selection is ambiguous", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Tree",
      dob: "1987-01-01",
      appointments: [
        {
          id: 111,
          date: "2026-06-01",
          time: "8:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
        {
          id: 222,
          date: "2026-06-08",
          time: "8:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";

    const turn = advanceFlowForTurn({
      flow,
      transcript: "Move my Dr. Bach appointment to Monday at 1 PM",
      understanding: {
        goal: "manage_existing_appointment",
        appointmentAction: "reschedule",
        patient: {
          patientMentioned: "caller",
          relationshipToCaller: "self",
        },
        scheduling: {
          preferredWindow: "Monday at 1 PM",
        },
        interruption: "none",
        confidence: 0.94,
        evidence: ["Dr. Bach", "Monday at 1 PM"],
      },
    });

    expect(turn.workflowCommand).toMatchObject({
      phase: "selecting_old_appointment",
      nextAction: "ask",
      slot: "oldAppointment",
      allowedTools: [],
      missingFacts: [expect.objectContaining({ key: "oldAppointment" })],
    });
  });

  it("plans a confirmed reschedule as replacement booking then old cancellation", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Tree",
      dob: "1987-01-01",
      appointments: [
        {
          id: 12345,
          date: "2026-06-01",
          time: "8:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.activeIntent = "existing_appointment_reschedule";
    flow.activeFlow = "appointment_management";
    startPatientTask(flow, {
      kind: "appointment_management",
      step: "confirm_booking",
    });
    flow.schedulingGoal = {
      patientRef: "caller",
      status: "confirming_booking",
      appointmentAction: "reschedule",
      preferredWindow: "Monday at 1 PM",
      selectedSlotId: "A",
      bookingConfirmed: true,
      noteDraft: {
        appointmentReason: "pressure follow-up",
        referringDoctor: "none",
      },
      evidence: ["Dr. Bach", "Monday at 1 PM"],
      updatedAt: Date.now(),
    };
    recordAvailabilitySearch(flow, {
      patientRef: "caller",
      officeKey: "spring-hill",
      visitType: "medical",
      coverageType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });
    recordAvailabilityCachedSlots(flow, [{ slotId: "A" }]);

    const command = planNextCommand(flow);
    applyPlannerPatch(flow, command);

    expect(command).toMatchObject({
      phase: "booking_replacement",
      nextAction: "call_tool",
      tool: "book_appt",
      allowedTools: ["book_appt"],
      args: {
        slotId: "A",
        appointmentKind: "medical",
        appointmentReason: "pressure follow-up",
        referringDoctor: "none",
      },
    });
    expect(command.allowedTools).not.toContain("add_patient_note");
    expect(command.allowedTools).not.toContain("cancel_appt");
    expect(command.allowedTools).not.toContain("reschedule_appt");

    const activePlan = flow.taskPlans?.[flow.activeTaskPlanId!];
    expect(activePlan?.kind).toBe("appointment_reschedule");
    if (activePlan?.kind !== "appointment_reschedule") {
      throw new Error("expected appointment reschedule plan");
    }
    flow.taskPlans![activePlan.id] = {
      ...activePlan,
      phase: "cancelling_old_appointment",
      replacementBookedAppointmentId: 67890,
      updatedAt: Date.now(),
    };

    const cancelCommand = planNextCommand(flow);

    expect(cancelCommand).toMatchObject({
      phase: "cancelling_old_appointment",
      nextAction: "call_tool",
      tool: "cancel_appt",
      allowedTools: ["cancel_appt"],
      args: { appointmentId: 12345 },
    });
    expect(cancelCommand.allowedTools).not.toContain("book_appt");
    expect(cancelCommand.allowedTools).not.toContain("reschedule_appt");
  });

  it("does not clear the selected slot when confirmation repeats known visit facts", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.activeIntent = "new_appointment";
    flow.activeFlow = "scheduling";
    flow.step = "get_availability";
    flow.visitType = "medical";
    flow.coverageType = "medical";
    flow.schedulingGoal = {
      patientRef: "caller",
      status: "ready_for_availability",
      appointmentAction: "schedule",
      visitReason: "double vision",
      visitType: "medical",
      preferredWindow: "tomorrow",
      selectedSlotId: "C",
      updatedAt: Date.now(),
    };

    const turn = advanceFlowForTurn({
      flow,
      transcript: "Yes, book it.",
      understanding: scheduleTurn({
        visitReason: "double vision",
        visitType: "medical",
        preferredWindow: "tomorrow",
        selectedSlotId: "C",
        bookingConfirmed: true,
      }),
    });

    expect(turn.update.pathFactsChanged).toBe(false);
    expect(turn.decision).toMatchObject({
      type: "call_tool",
      tool: "book_appt",
      args: { slotId: "C", appointmentKind: "medical" },
    });
    expect(turn.instruction).toBe(
      "Call book_appt next using the current turn_state and caller-provided details.",
    );
    expect(turn.turnState).toContain("nextAction: book_appt");
    expect(turn.turnState).not.toContain("nextAction: ask_preferred_date");
    expect(flow.schedulingGoal).toMatchObject({
      bookingConfirmed: true,
      selectedSlotId: "C",
    });
  });

  it("does not confirm stale slots when confirmation includes new scheduling facts", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.activeIntent = "new_appointment";
    flow.activeFlow = "scheduling";
    flow.step = "confirm_booking";
    flow.visitType = "routine_vision";
    flow.coverageType = "routine_vision";
    flow.schedulingGoal = {
      patientRef: "caller",
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "annual eye exam",
      preferredWindow: "Monday morning",
      selectedSlotId: "routine-slot-1",
      updatedAt: Date.now(),
    };

    const turn = advanceFlowForTurn({
      flow,
      transcript: "yes, but actually this is for a glaucoma follow up",
      understanding: scheduleTurn({
        visitReason: "glaucoma follow up",
        visitType: "medical",
        bookingConfirmed: true,
      }),
    });

    expect(turn.update.pathFactsChanged).toBe(true);
    expect(turn.resolvedMetaDecision).toMatchObject({
      outcome: {
        outcome: "success",
        nextStep: "get_availability",
        facts: {
          visitType: "medical",
          coverageType: "medical",
        },
      },
    });
    expect(turn.decision).toMatchObject({
      type: "ask",
      slot: "preferredDate",
    });
    expect(turn.decision).not.toMatchObject({
      type: "call_tool",
      tool: "book_appt",
    });
    expect(flow.schedulingGoal?.selectedSlotId).toBeUndefined();
    expect(flow.schedulingGoal?.bookingConfirmed).toBeUndefined();
  });

  it("moves rejected booking confirmations back to availability", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.activeIntent = "new_appointment";
    flow.activeFlow = "scheduling";
    flow.step = "confirm_booking";
    flow.visitType = "medical";
    flow.coverageType = "medical";
    flow.schedulingGoal = {
      patientRef: "caller",
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "glaucoma follow up",
      preferredWindow: "Monday morning",
      selectedSlotId: "slot-1",
      updatedAt: Date.now(),
    };

    const turn = advanceFlowForTurn({
      flow,
      transcript: "No, can we do Tuesday instead?",
      understanding: scheduleTurn({
        preferredWindow: "Tuesday",
        bookingConfirmed: false,
      }),
    });

    expect(turn.decision).toMatchObject({
      type: "call_tool",
      tool: "get_availability",
    });
    expect(turn.turnState).toContain("nextAction: get_availability");
    expect(flow).toMatchObject({
      activeFlow: "scheduling",
      step: "get_availability",
      schedulingGoal: {
        status: "ready_for_availability",
        preferredWindow: "Tuesday",
        bookingConfirmed: false,
      },
    });
    expect(flow.schedulingGoal?.selectedSlotId).toBeUndefined();
  });

  it("does not skip Crystal River routine-vision routing when the caller gives a date", () => {
    const flow = createInitialFlowState({
      officeKey: "crystal-river",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";

    const turn = advanceFlowForTurn({
      flow,
      transcript: "I need a routine eye exam next Tuesday",
      understanding: scheduleTurn({
        visitReason: "routine eye exam",
        visitType: "routine_vision",
        preferredWindow: "next Tuesday",
      }),
    });

    expect(turn.decision).toMatchObject({
      type: "confirm",
      confirmation: { type: "route_office" },
    });
    expect(turn.decision).not.toMatchObject({
      type: "call_tool",
      tool: "get_availability",
    });
    expect(flow).toMatchObject({
      activeFlow: "routing",
      step: "route_office",
      officeKey: "crystal-river",
    });
  });

  it("does not reuse medical insurance for routine-vision scheduling", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.patients.caller.insurance = {
      canonicalPlan: "Aetna",
      coverageType: "medical",
    };

    const turn = advanceFlowForTurn({
      flow,
      transcript: "I need a routine eye exam",
      understanding: scheduleTurn({
        visitReason: "routine eye exam",
        visitType: "routine_vision",
      }),
    });

    expect(turn.resolvedMetaDecision).toMatchObject({
      outcome: {
        outcome: "needs_clarification",
        nextStep: "check_insurance",
      },
    });
    expect(turn.decision).toMatchObject({
      type: "ask",
      slot: "insurancePlan",
    });
    expect(flow).toMatchObject({
      activeFlow: "scheduling",
      step: "check_insurance",
      coverageType: "routine_vision",
      visitType: "routine_vision",
    });
  });

  it("derives fresh coverage from a new visit reason instead of stale state", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.activeIntent = "new_appointment";
    flow.activeFlow = "scheduling";
    flow.step = "get_availability";
    flow.visitType = "routine_vision";
    flow.coverageType = "routine_vision";
    flow.patients.caller.insurance = {
      canonicalPlan: "VSP",
      coverageType: "routine_vision",
    };

    const turn = advanceFlowForTurn({
      flow,
      transcript: "Actually, this is for a glaucoma follow up",
      understanding: scheduleTurn({
        visitReason: "glaucoma follow up",
      }),
    });

    expect(turn.resolvedMetaDecision).toMatchObject({
      outcome: {
        outcome: "success",
        nextStep: "get_availability",
        facts: {
          visitType: "medical",
          coverageType: "medical",
        },
      },
    });
    expect(turn.resolvedMetaDecision?.outcome.facts).not.toHaveProperty(
      "canonicalPlan",
    );
    expect(turn.decision).toMatchObject({
      type: "ask",
      slot: "preferredDate",
    });
    expect(flow).toMatchObject({
      activeFlow: "scheduling",
      step: "get_availability",
      coverageType: "medical",
      visitType: "medical",
    });
  });

  it("preserves existing completed step markers when resolving meta patches", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.completedSteps = ["transfer_pushback_offered"];

    const turn = advanceFlowForTurn({
      flow,
      transcript: "I need an annual eye exam with VSP",
      understanding: {
        ...scheduleTurn({
          visitReason: "annual eye exam",
          visitType: "routine_vision",
        }),
        insurance: {
          plan: "VSP",
          coverageType: "routine_vision",
        },
      },
    });

    expect(turn.resolvedMetaDecision).toMatchObject({
      outcome: {
        outcome: "success",
        nextStep: "get_availability",
      },
    });
    expect(flow.completedSteps).toEqual(
      expect.arrayContaining([
        "transfer_pushback_offered",
        "triage_visit_type",
        "check_insurance",
      ]),
    );
  });

  it("routes Crystal River routine vision through confirmation before tools", () => {
    const flow = createInitialFlowState({ officeKey: "crystal-river" });

    const turn = advanceFlowForTurn({
      flow,
      transcript: "I need a routine eye exam",
      understanding: scheduleTurn({
        visitReason: "routine eye exam",
        visitType: "routine_vision",
      }),
    });

    expect(turn.decision).toMatchObject({
      type: "confirm",
      confirmation: { type: "route_office" },
    });
    expect(flow).toMatchObject({
      activeFlow: "routing",
      step: "route_office",
      visitType: "routine_vision",
      coverageType: "routine_vision",
      routing: "optical_only",
    });
  });
});

describe("flow shadow observer", () => {
  it("predicts no tool call for a bare insurance question before visit type is known", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const prediction = createFlowShadowPrediction(
      flow,
      insuranceTurn({ plan: "Care Plus" }),
      123,
    );
    const observation = observeFlowToolExecution(prediction, "check_insurance");

    expect(prediction.expectedDecision).toMatchObject({
      type: "ask",
      slot: "visitReason",
    });
    expect(prediction.contextPacket).toContain("<flow_state>");
    expect(JSON.stringify(prediction)).not.toContain("Care Plus");
    expect(observation).toMatchObject({
      match: "mismatch",
      toolName: "check_insurance",
      mismatchReason: "expected ask, got tool check_insurance",
    });
  });

  it("compares planner predictions against live tool attempts", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const prediction = createFlowShadowPrediction(
      flow,
      scheduleTurn({ visitReason: "glaucoma follow up", visitType: "medical" }),
    );
    const observation = observeFlowToolExecution(prediction, "verify_patient");

    expect(prediction.expectedDecision).toMatchObject({
      type: "ask",
      slot: "patientIdentity",
    });
    expect(observation).toMatchObject({
      match: "mismatch",
      mismatchReason: "expected ask, got tool verify_patient",
    });
  });
});

function appointmentManagementTurn(
  appointmentAction: "confirm" | "cancel" | "reschedule",
): TurnUnderstanding {
  return {
    goal: "manage_existing_appointment",
    appointmentAction,
    patient: {
      patientMentioned: "caller",
      relationshipToCaller: "self",
    },
    scheduling: {},
    interruption: "none",
    confidence: 0.92,
    evidence: [`${appointmentAction} appointment`],
  };
}

function scheduleTurn({
  visitReason,
  visitType,
  preferredWindow,
  selectedSlotId,
  bookingConfirmed,
}: {
  visitReason?: string;
  visitType?: "medical" | "routine_vision" | "optical_shop" | "urgent";
  preferredWindow?: string;
  selectedSlotId?: string;
  bookingConfirmed?: boolean;
} = {}): TurnUnderstanding {
  return {
    goal: "schedule",
    appointmentAction: null,
    patient: {
      patientMentioned: "caller",
      relationshipToCaller: "self",
    },
    scheduling: {
      visitReason,
      visitType,
      preferredWindow,
      selectedSlotId,
      bookingConfirmed,
    },
    interruption: "none",
    confidence: 0.91,
    evidence: [visitReason ?? "schedule appointment"],
  };
}

function insuranceTurn({
  plan,
  coverageType,
}: {
  plan?: string;
  coverageType?: "medical" | "routine_vision";
}): TurnUnderstanding {
  return {
    goal: "insurance_question",
    appointmentAction: null,
    patient: {
      patientMentioned: "caller",
      relationshipToCaller: "self",
    },
    scheduling: {},
    insurance: {
      plan,
      coverageType,
    },
    interruption: "none",
    confidence: 0.88,
    evidence: [plan ?? "insurance"],
  };
}

function faqTurn(topic: string): TurnUnderstanding {
  return {
    goal: "faq",
    appointmentAction: null,
    scheduling: {},
    interruption: "faq",
    confidence: 0.88,
    evidence: [topic],
  };
}

function backchannelTurn(): TurnUnderstanding {
  return {
    goal: "unclear",
    appointmentAction: null,
    scheduling: {},
    interruption: "backchannel",
    confidence: 0.77,
    evidence: ["yes"],
  };
}
