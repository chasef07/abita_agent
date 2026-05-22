import { describe, expect, it } from "vitest";
import {
  applyTurnUnderstandingFromTranscript,
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
  nextFlowDecision,
  observeFlowToolExecution,
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

describe("nextFlowDecision", () => {
  it("asks for visit type before answering a bare insurance question", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const decision = nextFlowDecision({
      state: flow,
      event: {
        type: "caller_intent",
        intent: "insurance_question",
        insurancePlan: "Care Plus",
      },
    });

    expect(decision).toMatchObject({
      type: "ask",
      slot: "visitReason",
    });
  });

  it("distinguishes appointment lookup, cancellation, and reschedule decisions", () => {
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

    expect(
      nextFlowDecision({
        state: flow,
        event: {
          type: "caller_intent",
          intent: "existing_appointment_confirm",
        },
      }),
    ).toMatchObject({
      type: "call_tool",
      tool: "confirm_appt",
    });
    expect(
      nextFlowDecision({
        state: flow,
        event: {
          type: "caller_intent",
          intent: "existing_appointment_cancel",
        },
      }),
    ).toMatchObject({
      type: "confirm",
      confirmation: { type: "cancel" },
    });
    expect(
      nextFlowDecision({
        state: flow,
        event: {
          type: "caller_intent",
          intent: "existing_appointment_reschedule",
        },
      }),
    ).toMatchObject({
      type: "ask",
      slot: "preferredDate",
    });
  });

  it("requires confirmation before office routing", () => {
    const flow = createInitialFlowState({ officeKey: "crystal-river" });
    const outcome = prepareSchedulingPath({
      officeKey: "crystal-river",
      patientStatus: "unknown",
      visitReason: "routine eye exam",
    });

    const decision = nextFlowDecision({
      state: flow,
      event: {
        type: "tool_outcome",
        toolName: "prepareSchedulingPath",
        outcome,
      },
    });

    expect(decision).toMatchObject({
      type: "confirm",
      confirmation: { type: "route_office" },
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

  it("marks internal meta-tool predictions as not applicable for live tool comparison", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const prediction = createFlowShadowPrediction(
      flow,
      scheduleTurn({ visitReason: "glaucoma follow up", visitType: "medical" }),
    );
    const observation = observeFlowToolExecution(prediction, "verify_patient");

    expect(prediction.expectedDecision).toMatchObject({
      type: "call_meta_tool",
      tool: "prepareSchedulingPath",
    });
    expect(observation.match).toBe("not_applicable");
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
}: {
  visitReason?: string;
  visitType?: "medical" | "routine_vision" | "optical_shop" | "urgent";
  preferredWindow?: string;
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
