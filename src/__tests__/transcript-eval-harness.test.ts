import { describe, expect, it } from "vitest";
import {
  reduceTurnUnderstandingFromTranscript,
  advanceFlowForTurn,
  compileTurnStatePacket,
  completeCurrentTaskAndResume,
  consumePendingSideEffectAction,
  createInitialFlowState,
  createPendingBookingAction,
  createPendingSideEffectAction,
  evaluateFlowToolPolicy,
  hashToolArgs,
  inferObviousTurnUnderstanding,
  planNextCommand,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  recordBookingAttempt,
  recordBookingResult,
  recordPatientVerificationAttempt,
  recordVerifiedPatient,
  type AvailabilitySearch,
  type BookingAttemptRecordInput,
  type CallFlowState,
  type CallerAppointment,
  type FlowTurnAdvanceResult,
  type FlowPolicyDecision,
  type GuardedToolName,
  type SideEffectActionType,
  type TurnUnderstanding,
  type VisitType,
} from "../flow/index.js";
import {
  flowDecisionForWorkflowCommand,
  type FlowDecision,
} from "./flow-decision-test-helper.js";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { OfficeKey } from "../offices.js";

type ToolArgs = Record<string, unknown>;

interface CallerTurnResult {
  decision: FlowDecision;
  transcript: string;
}

function decisionForTurn(turn: FlowTurnAdvanceResult): FlowDecision {
  if (turn.workflowCommand) {
    return flowDecisionForWorkflowCommand(turn.workflowCommand);
  }
  return {
    type: "ask",
    slot: turn.slot ?? "clarification",
    promptHint: turn.instruction,
  };
}

interface TranscriptHarnessInput {
  officeKey?: OfficeKey;
  patientId?: string | null;
  patientName?: string | null;
  dob?: string | null;
  callerPhone?: string | null;
  appointments?: CallerAppointment[];
  routing?: string | null;
  coverageType?: InsuranceCoverageType | null;
}

class TranscriptEvalHarness {
  readonly flow: CallFlowState;

  constructor({
    officeKey = "spring-hill",
    patientId = "patient-1",
    patientName = "Jane Doe",
    dob = "1980-01-01",
    callerPhone = "+17275551212",
    appointments = [],
    routing = "all_three",
    coverageType = null,
  }: TranscriptHarnessInput = {}) {
    this.flow = createInitialFlowState({
      officeKey,
      patientId,
      patientName,
      dob,
      callerPhone,
      appointments,
      routing,
      coverageType,
    });
  }

  hear(transcript: string, understanding: TurnUnderstanding): CallerTurnResult {
    const turn = advanceFlowForTurn({
      flow: this.flow,
      transcript,
      understanding,
    });
    return {
      transcript,
      decision: decisionForTurn(turn),
    };
  }

  apply(
    transcript: string,
    understanding: TurnUnderstanding,
  ): CallerTurnResult {
    reduceTurnUnderstandingFromTranscript(this.flow, transcript, understanding);
    return {
      transcript,
      decision: flowDecisionForWorkflowCommand(planNextCommand(this.flow)),
    };
  }

  verifyPrecallPatient(): void {
    const patient = this.activePatient();
    recordVerifiedPatient(this.flow, {
      patientId: patient?.patientId ?? "patient-1",
      patientName: patientNameFor(
        patient?.firstName?.value,
        patient?.lastName?.value,
      ),
      dob: patient?.dob?.value ?? "1980-01-01",
      appointments: patient?.appointments ?? [],
      source: "phone_lookup",
    });
  }

  startAvailability({
    date = "2026-06-01",
    visitType = "medical",
    routing = "all_three",
    slots = [{ slotId: "slot-a" }, { slotId: "slot-b" }],
    maxSearches,
  }: {
    date?: string;
    visitType?: VisitType;
    routing?: "bach_only" | "bach_licht" | "all_three" | "optical_only";
    slots?: Array<{
      slotId: string;
      datetime?: string;
      columnId?: number;
      profileId?: number;
      duration?: number;
    }>;
    maxSearches?: number;
  } = {}): AvailabilitySearch {
    this.flow.visitType = visitType;
    this.flow.routing = routing;
    const result = recordAvailabilitySearch(this.flow, {
      coverageType: this.flow.coverageType,
      date,
      maxSearches,
      officeKey: this.flow.officeKey,
      routing,
      visitType,
    });
    const search = recordAvailabilityCachedSlots(this.flow, slots);
    if (!search) throw new Error("expected availability search to exist");
    return result.search;
  }

  confirmBooking({
    appointmentTypeId = 1007,
    routing = this.flow.routing ?? "all_three",
    slotHash = "slot-a",
  }: Partial<
    Pick<
      BookingAttemptRecordInput,
      "appointmentTypeId" | "routing" | "slotHash"
    >
  > = {}) {
    return createPendingBookingAction(this.flow, {
      appointmentTypeId,
      createdTurnId: "caller-confirmed-booking",
      confirmationTurnId: "caller-confirmed-booking",
      officeKey: this.flow.officeKey,
      routing,
      slotHash,
      spokenSummary: `${slotHash} confirmed by caller`,
      confirmed: true,
    });
  }

  bookingPolicy({
    appointmentTypeId = 1007,
    routing = this.flow.routing ?? "all_three",
    slotHash = "slot-a",
  }: Partial<
    Pick<
      BookingAttemptRecordInput,
      "appointmentTypeId" | "routing" | "slotHash"
    >
  > = {}) {
    const booking = this.bookingFacts({ appointmentTypeId, routing, slotHash });
    return this.policy(
      "book_appt",
      { appointmentTypeId, slotId: slotHash },
      booking,
    );
  }

  recordBookingResult(
    result: unknown,
    {
      appointmentTypeId = 1007,
      routing = this.flow.routing ?? "all_three",
      slotHash = "slot-a",
    }: Partial<
      Pick<
        BookingAttemptRecordInput,
        "appointmentTypeId" | "routing" | "slotHash"
      >
    > = {},
  ) {
    const attempt = recordBookingAttempt(
      this.flow,
      this.bookingFacts({ appointmentTypeId, routing, slotHash }),
    );
    if (!attempt.action) throw new Error("expected pending booking action");
    return recordBookingResult(this.flow, attempt.action.id, result);
  }

  confirmSideEffect(
    type: SideEffectActionType,
    args: ToolArgs,
    spokenSummary = "Caller confirmed the side effect.",
  ) {
    return createPendingSideEffectAction(this.flow, {
      type,
      argsHash: hashToolArgs(args),
      spokenSummary,
      patientRef: this.flow.activePatientRef,
      appointmentId:
        typeof args.appointmentId === "number" ? args.appointmentId : undefined,
      confirmed: true,
      createdTurnId: "caller-confirmed-side-effect",
      confirmationTurnId: "caller-confirmed-side-effect",
    });
  }

  consumeSideEffect(type: SideEffectActionType, args: ToolArgs) {
    return consumePendingSideEffectAction(this.flow, {
      type,
      argsHash: hashToolArgs(args),
      patientRef: this.flow.activePatientRef,
      appointmentId:
        typeof args.appointmentId === "number" ? args.appointmentId : undefined,
    });
  }

  policy(
    toolName: GuardedToolName,
    args?: unknown,
    booking?: Omit<BookingAttemptRecordInput, "spokenSummary">,
  ): FlowPolicyDecision {
    return evaluateFlowToolPolicy({
      flow: this.flow,
      toolName,
      args,
      booking,
      stateFacts: this.stateFacts(),
    });
  }

  private bookingFacts({
    appointmentTypeId = 1007,
    routing = this.flow.routing ?? "all_three",
    slotHash = "slot-a",
  }: Partial<
    Pick<
      BookingAttemptRecordInput,
      "appointmentTypeId" | "routing" | "slotHash"
    >
  >): BookingAttemptRecordInput {
    return {
      appointmentTypeId,
      createdTurnId: "book-attempt",
      officeKey: this.flow.officeKey,
      patientRef: this.flow.activePatientRef,
      routing,
      slotHash,
      spokenSummary: `${slotHash} confirmed by caller`,
    };
  }

  private stateFacts() {
    const patient = this.activePatient();
    return {
      checkedInsuranceCoverageType: this.flow.coverageType ?? null,
      checkedInsurancePlan:
        patient?.insurance?.canonicalPlan ??
        patient?.insurance?.plan?.value ??
        null,
      lastAvailabilityRouting: this.flow.routing ?? null,
      officeKey: this.flow.officeKey,
      patientId: patient?.patientId ?? null,
    };
  }

  private activePatient() {
    return this.flow.patients[this.flow.activePatientRef ?? "caller"];
  }
}

describe("transcript replay eval harness", () => {
  it("replays the source call as reschedule before the transfer escalation", () => {
    const harness = new TranscriptEvalHarness({
      officeKey: "hollywood",
      patientId: null,
      patientName: null,
      dob: null,
      callerPhone: "+19548223950",
    });

    const openingUnderstanding = inferObviousTurnUnderstanding(
      harness.flow,
      "Appointment changes.",
    );
    expect(openingUnderstanding).toMatchObject({
      goal: "manage_existing_appointment",
      appointmentAction: "reschedule",
    });

    const openingTurn = harness.hear(
      "Appointment changes.",
      openingUnderstanding!,
    );

    expect(openingTurn.decision).toMatchObject({
      type: "ask",
      slot: "patientIdentity",
    });
    expect(harness.flow).toMatchObject({
      activeFlow: "appointment_management",
      activeIntent: "existing_appointment_reschedule",
      step: "verify_patient",
    });

    recordVerifiedPatient(harness.flow, {
      patientId: "17553422",
      patientName: "QUEVEDO MAZA,CARLOS",
      dob: "10/13/1949",
      appointments: [appointment(20756135)],
      appointmentsStatus: "found",
      source: "tool_result",
    });

    const nextWeekTurn = harness.hear(
      "Uh, for next week.",
      scheduleTurn({ preferredWindow: "next week" }),
    );

    expect(harness.flow.activeIntent).toBe("existing_appointment_reschedule");
    expect(harness.flow.schedulingGoal).toMatchObject({
      appointmentAction: "reschedule",
      preferredWindow: "next week",
    });
    expect(nextWeekTurn.decision).not.toMatchObject({
      type: "call_tool",
      tool: "verify_patient",
    });
  });

  it("treats pre-call appointments as loaded but still requires explicit cancel confirmation", () => {
    const harness = new TranscriptEvalHarness({
      appointments: [appointment(12345)],
    });

    const turn = harness.hear(
      "This is Jane, I need to cancel my appointment",
      appointmentManagementTurn("cancel"),
    );

    expect(turn.decision).toMatchObject({
      type: "confirm",
      confirmation: { type: "cancel" },
    });
    expect(turn.decision).not.toMatchObject({
      type: "call_tool",
      tool: "verify_patient",
      args: {},
    });

    expect(
      harness.policy("cancel_appt", { appointmentId: 12345 }),
    ).toMatchObject({
      allowed: false,
      outcome: {
        nextStep: "confirm_cancel",
        facts: { reason: "side_effect_confirmation_required" },
      },
    });

    harness.confirmSideEffect(
      "cancel_appt",
      { appointmentId: 12345 },
      "Cancel the preloaded June 1st appointment.",
    );

    expect(
      harness.policy("cancel_appt", { appointmentId: 12345 }),
    ).toMatchObject({
      allowed: true,
      observation: { reason: "allowed" },
    });
  });

  it("does not allow cancellation when confirmation exists but the appointment is not loaded", () => {
    const harness = new TranscriptEvalHarness({ appointments: [] });
    harness.verifyPrecallPatient();
    harness.hear(
      "Please cancel my appointment",
      appointmentManagementTurn("cancel"),
    );
    harness.confirmSideEffect(
      "cancel_appt",
      { appointmentId: 12345 },
      "Cancel appointment 12345.",
    );

    expect(
      harness.policy("cancel_appt", { appointmentId: 12345 }),
    ).toMatchObject({
      allowed: false,
      outcome: {
        nextStep: "confirm_cancel",
        facts: { reason: "cancel_requires_loaded_appointment" },
      },
    });
  });

  it("filters past pre-call appointments out of cancellable state", () => {
    const pastId = 11111;
    const futureId = 22222;
    const harness = new TranscriptEvalHarness({
      appointments: [
        appointment(pastId, relativeDate(-3)),
        appointment(futureId, relativeDate(3)),
      ],
    });

    expect(harness.flow.patients.caller.appointments).toEqual([
      expect.objectContaining({ id: futureId }),
    ]);

    harness.verifyPrecallPatient();
    harness.confirmSideEffect(
      "cancel_appt",
      { appointmentId: pastId },
      "Cancel the past appointment.",
    );

    expect(
      harness.policy("cancel_appt", { appointmentId: pastId }),
    ).toMatchObject({
      allowed: false,
      outcome: {
        nextStep: "confirm_cancel",
        facts: { reason: "cancel_requires_loaded_appointment" },
      },
    });
  });

  it("blocks duplicate availability searches from transcript-style loops", () => {
    const harness = new TranscriptEvalHarness();
    harness.verifyPrecallPatient();
    harness.hear(
      "I need to schedule a medical eye appointment",
      scheduleTurn({
        visitReason: "medical eye appointment",
        visitType: "medical",
      }),
    );
    harness.flow.visitType = "medical";
    harness.flow.routing = "all_three";

    recordAvailabilitySearch(harness.flow, {
      coverageType: "medical",
      date: "2026-06-01",
      officeKey: "spring-hill",
      routing: "all_three",
      visitType: "medical",
    });

    expect(
      harness.policy("get_availability", {
        date: "2026-06-01",
        routing: "all_three",
      }),
    ).toMatchObject({
      allowed: false,
      outcome: {
        nextStep: "confirm_booking",
        facts: { reason: "availability_duplicate_search_signature" },
      },
    });
  });

  it("confirms a pre-call single patient by first name without calling verify again", () => {
    const harness = new TranscriptEvalHarness({
      patientName: "Doe, Jane",
    });

    const schedulingTurn = harness.hear(
      "I need to schedule a glaucoma visit",
      scheduleTurn({ visitReason: "glaucoma visit", visitType: "medical" }),
    );
    expect(schedulingTurn.decision).toMatchObject({
      type: "ask",
      slot: "patientIdentity",
    });
    expect(harness.flow).toMatchObject({
      activeFlow: "scheduling",
      patientStatus: "matched",
      step: "verify_patient",
    });

    harness.flow.visitType = "medical";
    const identityTurn = harness.hear("Jane", patientIdentityTurn("Jane"));

    expect(harness.flow.patients.caller).toMatchObject({
      status: "verified",
      firstName: { value: "Jane", confirmed: true },
      lastName: { value: "Doe", confirmed: true },
      dob: { value: "1980-01-01", confirmed: true },
    });
    expect(harness.flow).toMatchObject({
      activeFlow: "scheduling",
      activeIntent: "new_appointment",
      patientStatus: "verified",
      step: "get_availability",
    });
    expect(identityTurn.decision).not.toMatchObject({
      type: "ask",
      slot: "patientIdentity",
    });
  });

  it("pushes back once on a human request during recoverable scheduling", () => {
    const harness = new TranscriptEvalHarness();

    harness.hear(
      "I need to schedule a glaucoma visit",
      scheduleTurn({ visitReason: "glaucoma visit", visitType: "medical" }),
    );
    const firstHumanRequest = harness.hear(
      "I need a representative",
      transferTurn("representative"),
    );

    expect(firstHumanRequest.decision).toMatchObject({
      type: "say",
    });
    expect(harness.flow.completedSteps).toContain("transfer_pushback_offered");
    expect(harness.flow.currentTask).toMatchObject({ kind: "schedule" });
    expect(harness.flow.activeFlow).toBe("scheduling");

    const secondHumanRequest = harness.hear(
      "representative please",
      transferTurn("representative"),
    );

    expect(secondHumanRequest.decision).toMatchObject({
      type: "call_tool",
      tool: "transfer_call",
      args: {},
    });
    expect(harness.flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "transfer_call",
        confirmed: true,
        consumed: false,
      }),
    );
  });

  it("allows cached availability booking without reducer-created confirmation state", () => {
    const harness = new TranscriptEvalHarness();
    harness.verifyPrecallPatient();
    harness.startAvailability();

    expect(harness.bookingPolicy()).toMatchObject({
      allowed: true,
      observation: { reason: "allowed" },
    });
  });

  it("keeps reschedule guarded by concrete prerequisites", () => {
    const harness = new TranscriptEvalHarness({
      appointments: [appointment(12345)],
    });

    const turn = harness.hear(
      "This is Jane, I need to reschedule my appointment",
      appointmentManagementTurn("reschedule"),
    );

    expect(turn.decision).toMatchObject({
      type: "ask",
      slot: "preferredDate",
    });
    expect(
      harness.policy("cancel_appt", { appointmentId: 12345 }),
    ).toMatchObject({
      allowed: false,
      outcome: {
        facts: { reason: "cancel_confirmation_not_tracked" },
      },
    });

    harness.verifyPrecallPatient();
    harness.startAvailability();
    harness.confirmBooking();
    expect(harness.bookingPolicy()).toMatchObject({
      allowed: true,
      observation: { reason: "allowed" },
    });
  });

  it("turns stale-slot booking errors into recovery state instead of blind retry", () => {
    const harness = new TranscriptEvalHarness();
    harness.verifyPrecallPatient();
    harness.startAvailability({
      slots: [{ slotId: "slot-a" }, { slotId: "slot-b" }],
    });
    harness.confirmBooking({ slotHash: "slot-a" });

    const result = harness.recordBookingResult(
      {
        outcome: "slot_unavailable",
        status: "error",
        message:
          "This time slot is no longer available. Please check availability again.",
      },
      { slotHash: "slot-a" },
    );

    expect(result).toMatchObject({
      consumed: false,
      errorClass: "slot_unavailable",
      action: { slotInvalidated: true },
    });
    expect(harness.flow.availabilitySearches[0]).toMatchObject({
      rejectedSlotHashes: ["slot-a"],
      failureReasons: ["slot_unavailable"],
      status: "satisfied",
    });
    expect(harness.bookingPolicy({ slotHash: "slot-a" })).toMatchObject({
      allowed: false,
      outcome: {
        nextStep: "get_availability",
        facts: { reason: "booking_slot_invalidated" },
      },
    });
  });

  it("invalid appointment type errors force lane recomputation before more booking", () => {
    const harness = new TranscriptEvalHarness();
    harness.verifyPrecallPatient();
    harness.startAvailability({ slots: [{ slotId: "slot-a" }] });
    harness.confirmBooking({ appointmentTypeId: 6167, slotHash: "slot-a" });

    harness.recordBookingResult(
      {
        outcome: "invalid_appointment_type",
        status: "error",
        message: "Appointment type 6167 is invalid for this routing lane.",
      },
      { appointmentTypeId: 6167, slotHash: "slot-a" },
    );

    expect(harness.flow.availabilitySearches[0]).toMatchObject({
      failureReasons: ["invalid_appointment_type"],
      lastInvalidationReason: "appointment_type_invalid",
      status: "invalidated",
    });
    expect(
      harness.bookingPolicy({ appointmentTypeId: 6167, slotHash: "slot-a" }),
    ).toMatchObject({
      allowed: false,
      outcome: {
        nextStep: "get_availability",
        facts: { reason: "booking_slot_invalidated" },
      },
    });
  });

  it("keeps a child patient booking separate from pre-call caller state", () => {
    const harness = new TranscriptEvalHarness({
      appointments: [appointment(12345)],
      patientId: "caller-patient",
      patientName: "Parent Caller",
    });

    recordPatientVerificationAttempt(harness.flow, {
      dob: "2012-02-03",
      firstName: "Emily",
      lastName: "Doe",
      relationshipToCaller: "child",
    });
    const childRef = harness.flow.activePatientRef!;
    recordVerifiedPatient(harness.flow, {
      appointments: [appointment(456, "2026-06-02")],
      dob: "2012-02-03",
      patientId: "child-patient",
      patientName: "Emily Doe",
    });
    harness.startAvailability({ slots: [{ slotId: "child-slot" }] });
    harness.confirmBooking({ slotHash: "child-slot" });

    expect(harness.flow.activePatientRef).toBe(childRef);
    expect(harness.flow.patients.caller).toMatchObject({
      patientId: "caller-patient",
      appointments: [expect.objectContaining({ id: 12345 })],
    });
    expect(harness.flow.patients[childRef]).toMatchObject({
      patientId: "child-patient",
      appointments: [expect.objectContaining({ id: 456 })],
    });
    expect(harness.bookingPolicy({ slotHash: "child-slot" })).toMatchObject({
      allowed: true,
      observation: {
        activePatientRef: childRef,
        reason: "allowed",
      },
    });
    expect(harness.flow.pendingActions[0]).toMatchObject({
      patientRef: childRef,
      type: "book_appt",
    });
  });

  it("suspends scheduling for FAQ and resumes the scheduling task after answer", () => {
    const harness = new TranscriptEvalHarness();

    const schedulingTurn = harness.hear(
      "I need to schedule a glaucoma visit",
      scheduleTurn({ visitReason: "glaucoma visit", visitType: "medical" }),
    );
    expect(schedulingTurn.decision).toMatchObject({
      type: "ask",
      slot: "patientIdentity",
    });
    const scheduleTask = harness.flow.currentTask;
    expect(scheduleTask).toMatchObject({ kind: "schedule" });

    const faqTurn = harness.hear(
      "what are your hours",
      faqUnderstanding("hours"),
    );
    expect(faqTurn.decision).toMatchObject({
      type: "call_tool",
      tool: "lookup_knowledge",
    });
    expect(harness.flow.currentTask).toMatchObject({
      kind: "faq",
      returnTo: scheduleTask?.id,
    });

    const resumed = completeCurrentTaskAndResume(harness.flow);

    expect(resumed).toMatchObject({
      id: scheduleTask?.id,
      kind: "schedule",
    });
    expect(harness.flow.currentTask).toMatchObject({
      id: scheduleTask?.id,
      kind: "schedule",
    });
  });

  it("allows transfer side effects without a separate confirmation gate", () => {
    const harness = new TranscriptEvalHarness();
    harness.hear("I need to schedule an appointment", scheduleTurn());

    expect(harness.policy("transfer_call")).toMatchObject({
      allowed: true,
      observation: { reason: "allowed" },
    });
  });

  it("gates Spring Hill office routing separately from human transfer", () => {
    const harness = new TranscriptEvalHarness({ officeKey: "crystal-river" });

    expect(harness.policy("route_to_spring_hill")).toMatchObject({
      allowed: false,
      outcome: {
        nextStep: "route_office",
        facts: {
          reason: "side_effect_confirmation_required",
          toolName: "route_to_spring_hill",
        },
      },
    });

    harness.confirmSideEffect(
      "route_office",
      {},
      "Switch active scheduling to Spring Hill.",
    );

    expect(harness.policy("route_to_spring_hill")).toMatchObject({
      allowed: true,
      observation: {
        reason: "allowed",
        toolName: "route_to_spring_hill",
      },
    });
  });

  it("keeps turn-state packets compact and free of patient detail", () => {
    const harness = new TranscriptEvalHarness({
      patientId: "secret-patient-1",
      patientName: "Doe, Jane",
      dob: "1980-01-01",
      appointments: [appointment(98765)],
    });

    harness.hear(
      "I need to schedule a glaucoma visit",
      scheduleTurn({ visitReason: "glaucoma visit", visitType: "medical" }),
    );
    const packet = compileTurnStatePacket(harness.flow);

    expect(packet.length).toBeLessThan(600);
    expect(packet).toContain("patientStatus: matched_not_verified");
    expect(packet).not.toContain("secret-patient-1");
    expect(packet).not.toContain("Jane");
    expect(packet).not.toContain("Doe");
    expect(packet).not.toContain("1980-01-01");
    expect(packet).not.toContain("98765");
    expect(packet).not.toContain("9:00 AM");
    expect(packet).not.toContain("Dr. Bach");
    expect(packet).not.toContain("glaucoma");
  });
});

function appointment(id: number, date = "2026-06-01"): CallerAppointment {
  return {
    id,
    date,
    time: "9:00 AM",
    provider: "Dr. Bach",
    type: "Follow-up",
    facility: "Spring Hill",
    confirmed: true,
  };
}

function patientNameFor(firstName?: string, lastName?: string): string {
  return [firstName, lastName].filter(Boolean).join(" ") || "Jane Doe";
}

function relativeDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function scheduleTurn({
  visitReason,
  visitType,
  preferredWindow,
}: {
  visitReason?: string;
  visitType?: VisitType;
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
    confidence: 0.92,
    evidence: [visitReason ?? "schedule appointment"],
  };
}

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
    confidence: 0.93,
    evidence: [`${appointmentAction} appointment`],
  };
}

function patientIdentityTurn(firstName: string): TurnUnderstanding {
  return {
    goal: "unclear",
    appointmentAction: null,
    patient: {
      patientMentioned: "caller",
      relationshipToCaller: "self",
      firstName,
    },
    interruption: "backchannel",
    confidence: 0.74,
    evidence: [firstName],
  };
}

function transferTurn(evidence: string): TurnUnderstanding {
  return {
    goal: "transfer_request",
    appointmentAction: null,
    interruption: "transfer_request",
    confidence: 0.92,
    evidence: [evidence],
  };
}

function faqUnderstanding(topic: string): TurnUnderstanding {
  return {
    goal: "faq",
    appointmentAction: null,
    interruption: "faq",
    confidence: 0.88,
    evidence: [topic],
  };
}
