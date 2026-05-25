import { z } from "zod";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import { invalidateAvailabilitySearches } from "./availability.js";
import {
  applyInferredIntentState,
  type InferredCallerIntent,
  type IntentStateUpdate,
} from "./intent.js";
import { invalidatePendingActionsForStateChange } from "./pending-actions.js";
import { activeWorkflowCommandForState } from "./plans/active-command.js";
import {
  confirmPreloadedPatientIdentityFromTranscript,
  ensureActivePatientContext,
  hasActivePatientIdentityChanged,
  nextPatientFlowStep,
  recordPatientVerificationAttempt,
  setActivePatientRelationship,
  snapshotActivePatientIdentity,
  updateActivePatientInsurance,
} from "./state.js";
import type {
  CallFlowState,
  AvailabilityInvalidationReason,
  FlowStep,
  IntentKind,
  PatientContext,
  PatientRelationshipToCaller,
  TrackedSlotSource,
  VisitType,
  WorkflowCommand,
} from "./types.js";
import { classifyVisitType } from "./scheduling.js";

const relationshipSchema = z.enum([
  "self",
  "child",
  "parent",
  "spouse",
  "other_family",
  "other",
  "unknown",
]);

const visitTypeSchema = z.enum([
  "medical",
  "routine_vision",
  "optical_shop",
  "urgent",
]);

const coverageTypeSchema = z.enum(["medical", "routine_vision"]);

export const turnUnderstandingSchema = z.object({
  goal: z.enum([
    "schedule",
    "register_new_patient",
    "manage_existing_appointment",
    "insurance_question",
    "faq",
    "transfer_request",
    "unclear",
  ]),
  appointmentAction: z
    .enum(["confirm", "cancel", "reschedule"])
    .nullable()
    .optional(),
  patient: z
    .object({
      patientMentioned: z
        .enum(["caller", "someone_else", "unknown"])
        .nullable()
        .optional(),
      relationshipToCaller: relationshipSchema.nullable().optional(),
      firstName: z.string().trim().min(1).nullable().optional(),
      lastName: z.string().trim().min(1).nullable().optional(),
      dob: z.string().trim().min(1).nullable().optional(),
      phone: z.string().trim().min(1).nullable().optional(),
      correction: z.boolean().optional(),
    })
    .optional(),
  scheduling: z
    .object({
      visitReason: z.string().trim().min(1).nullable().optional(),
      visitType: visitTypeSchema.nullable().optional(),
      preferredWindow: z.string().trim().min(1).nullable().optional(),
      selectedSlotId: z.string().trim().min(1).nullable().optional(),
      bookingConfirmed: z.boolean().nullable().optional(),
      note: z
        .object({
          appointmentReason: z.string().trim().min(1).nullable().optional(),
          referringDoctor: z.string().trim().min(1).nullable().optional(),
        })
        .optional(),
    })
    .optional(),
  insurance: z
    .object({
      plan: z.string().trim().min(1).nullable().optional(),
      coverageType: coverageTypeSchema.nullable().optional(),
    })
    .optional(),
  confirmation: z
    .object({
      cancelConfirmed: z.boolean().nullable().optional(),
      routeConfirmed: z.boolean().nullable().optional(),
      transferConfirmed: z.boolean().nullable().optional(),
    })
    .optional(),
  interruption: z
    .enum(["faq", "transfer_request", "correction", "backchannel", "none"])
    .optional(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().trim().min(1)).max(8).optional(),
});

export type TurnUnderstanding = z.infer<typeof turnUnderstandingSchema>;
export type TurnGoal = TurnUnderstanding["goal"];
export type TurnInterruption = NonNullable<TurnUnderstanding["interruption"]>;
type TurnUnderstandingNote = NonNullable<
  NonNullable<TurnUnderstanding["scheduling"]>["note"]
>;

export interface TurnUnderstandingStateUpdate extends IntentStateUpdate {
  understanding: TurnUnderstanding;
  pathFactsChanged: boolean;
}

export function createUnclearTurnUnderstanding(
  input: {
    confidence?: number;
    evidence?: string[];
  } = {},
): TurnUnderstanding {
  return {
    goal: "unclear",
    appointmentAction: null,
    interruption: "none",
    confidence: input.confidence ?? 0,
    evidence: input.evidence ?? [],
  };
}

export function inferObviousTurnUnderstanding(
  flow: CallFlowState,
  transcript: string,
): TurnUnderstanding | undefined {
  const cleaned = transcript.trim();
  const normalized = normalizeEvidenceText(cleaned);
  if (!normalized) return undefined;

  const activeCommand = activeWorkflowCommandForState(flow);
  const evidence = [cleaned];
  const affirmative = isAffirmative(normalized);
  const negative = isNegative(normalized);

  if (affirmative || negative) {
    const confirmed = affirmative;
    if (activeCommand?.confirmationType === "cancel") {
      return {
        goal: "manage_existing_appointment",
        appointmentAction: "cancel",
        confirmation: { cancelConfirmed: confirmed },
        confidence: 0.95,
        evidence,
      };
    }
    if (activeCommand?.confirmationType === "route_office") {
      return {
        goal: "schedule",
        confirmation: { routeConfirmed: confirmed },
        confidence: 0.95,
        evidence,
      };
    }
    if (activeCommand?.confirmationType === "transfer") {
      return {
        goal: "transfer_request",
        confirmation: { transferConfirmed: confirmed },
        confidence: 0.95,
        evidence,
      };
    }

    if (isRescheduleConfirmationFlow(flow, activeCommand)) {
      return {
        goal: "manage_existing_appointment",
        appointmentAction: "reschedule",
        scheduling: {
          selectedSlotId: selectedSlotForConfirmation(flow, activeCommand),
          bookingConfirmed: confirmed,
        },
        confidence: 0.95,
        evidence,
      };
    }

    if (isBookingConfirmationFlow(flow, activeCommand)) {
      return {
        goal: "schedule",
        scheduling: {
          selectedSlotId: selectedSlotForConfirmation(flow, activeCommand),
          bookingConfirmed: confirmed,
        },
        confidence: 0.95,
        evidence,
      };
    }
  }

  const appointmentAction = appointmentActionFromTranscript(normalized);
  if (appointmentAction) {
    return {
      goal: "manage_existing_appointment",
      appointmentAction,
      patient: { patientMentioned: "caller", relationshipToCaller: "self" },
      confidence: 0.88,
      evidence,
    };
  }

  if (scheduleIntentFromTranscript(normalized)) {
    const visitType = classifyVisitType(cleaned) ?? undefined;
    const preferredWindow = hasPreferredWindowCue(normalized)
      ? cleaned
      : undefined;
    return {
      goal: "schedule",
      scheduling:
        visitType || preferredWindow
          ? {
              ...(visitType ? { visitType, visitReason: cleaned } : {}),
              ...(preferredWindow ? { preferredWindow } : {}),
            }
          : undefined,
      confidence: 0.82,
      evidence,
    };
  }

  if (insuranceQuestionFromTranscript(normalized)) {
    return {
      goal: "insurance_question",
      confidence: 0.82,
      evidence,
    };
  }

  if (transferRequestFromTranscript(normalized)) {
    return {
      goal: "transfer_request",
      interruption: "transfer_request",
      confidence: 0.86,
      evidence,
    };
  }

  if (shouldTreatTranscriptAsVisitReason(flow, activeCommand, cleaned)) {
    const visitType = classifyVisitType(cleaned) ?? undefined;
    return {
      goal: "schedule",
      scheduling: {
        visitReason: cleaned,
        ...(visitType ? { visitType } : {}),
      },
      confidence: visitType ? 0.86 : 0.72,
      evidence,
    };
  }

  if (shouldTreatTranscriptAsPreferredWindow(flow, activeCommand, normalized)) {
    return {
      goal:
        flow.activeIntent === "existing_appointment_reschedule"
          ? "manage_existing_appointment"
          : "schedule",
      appointmentAction:
        flow.activeIntent === "existing_appointment_reschedule"
          ? "reschedule"
          : null,
      scheduling: { preferredWindow: cleaned },
      confidence: 0.76,
      evidence,
    };
  }

  return undefined;
}

export function parseTurnUnderstanding(
  value: unknown,
): TurnUnderstanding | undefined {
  const result = turnUnderstandingSchema.safeParse(value);
  if (!result.success) return undefined;
  return normalizeTurnUnderstanding(result.data);
}

export function applyTurnUnderstandingFromTranscript(
  flow: CallFlowState,
  transcript: string,
  understanding: TurnUnderstanding,
): TurnUnderstandingStateUpdate {
  confirmPreloadedPatientIdentityFromTranscript(flow, transcript);
  return applyTurnUnderstanding(flow, understanding);
}

export function applyTurnUnderstanding(
  flow: CallFlowState,
  understanding: TurnUnderstanding,
): TurnUnderstandingStateUpdate {
  const normalized = normalizeTurnUnderstanding(understanding);
  if (normalized.confidence < 0.5) {
    return {
      inferred: { activeIntent: "unclear" },
      previousIntent: flow.activeIntent,
      changed: false,
      understanding: normalized,
      pathFactsChanged: false,
    };
  }

  const patientSnapshot = snapshotActivePatientIdentity(flow);
  const visitReasonBefore = flow.schedulingGoal?.visitReason;
  const visitTypeBefore = flow.visitType;
  const coverageTypeBefore = flow.coverageType;
  const preferredWindowBefore = flow.schedulingGoal?.preferredWindow;
  const insurancePlanBefore = activePatientInsurancePlan(flow);
  const pathFactsChanged = schedulingPathFactsChanged(normalized, {
    coverageType: coverageTypeBefore,
    insurancePlan: insurancePlanBefore,
    visitReason: visitReasonBefore,
    visitType: visitTypeBefore,
  });

  applyPatientUnderstanding(flow, normalized);
  applySchedulingUnderstanding(flow, normalized);
  applyInsuranceUnderstanding(flow, normalized);

  if (hasActivePatientIdentityChanged(flow, patientSnapshot)) {
    invalidateStateForNewFacts(flow, "patient_changed");
  }
  if (flow.visitType && visitTypeBefore && flow.visitType !== visitTypeBefore) {
    invalidateStateForNewFacts(flow, "visit_type_changed");
  }
  if (
    flow.coverageType &&
    coverageTypeBefore &&
    flow.coverageType !== coverageTypeBefore
  ) {
    invalidateStateForNewFacts(flow, "insurance_changed");
  }
  if (
    flow.schedulingGoal?.preferredWindow &&
    preferredWindowBefore &&
    flow.schedulingGoal.preferredWindow !== preferredWindowBefore
  ) {
    invalidateStateForNewFacts(flow, "preferred_window_changed");
  }

  const inferred = turnUnderstandingToInferredIntent(normalized);
  const update = applyInferredIntentState(flow, inferred);
  applySchedulingGoalAfterIntent(flow, normalized, inferred.activeIntent);

  return {
    ...update,
    understanding: normalized,
    pathFactsChanged,
  };
}

export function turnUnderstandingToInferredIntent(
  understanding: TurnUnderstanding,
): InferredCallerIntent {
  if (understanding.confidence < 0.5) {
    return { activeIntent: "unclear" };
  }

  const visitReason = cleanString(understanding.scheduling?.visitReason);
  const visitType = understanding.scheduling?.visitType ?? undefined;
  const insurancePlan = cleanString(understanding.insurance?.plan);
  const coverageType =
    understanding.insurance?.coverageType ??
    coverageTypeForVisitType(visitType);

  const inferred: InferredCallerIntent = {
    activeIntent: intentForTurnUnderstanding(understanding),
  };

  if (visitReason) inferred.visitReason = visitReason;
  if (visitType) inferred.visitType = visitType;
  if (insurancePlan) inferred.insurancePlan = insurancePlan;
  if (coverageType) inferred.coverageType = coverageType;
  return inferred;
}

function normalizeTurnUnderstanding(
  understanding: TurnUnderstanding,
): TurnUnderstanding {
  return {
    ...understanding,
    appointmentAction: understanding.appointmentAction ?? null,
    patient: understanding.patient
      ? {
          ...understanding.patient,
          firstName: cleanString(understanding.patient.firstName),
          lastName: cleanString(understanding.patient.lastName),
          dob: cleanString(understanding.patient.dob),
          phone: cleanString(understanding.patient.phone),
          relationshipToCaller:
            understanding.patient.relationshipToCaller ?? undefined,
          patientMentioned: understanding.patient.patientMentioned ?? undefined,
          correction: understanding.patient.correction ?? false,
        }
      : undefined,
    scheduling: understanding.scheduling
      ? {
          ...understanding.scheduling,
          visitReason: cleanString(understanding.scheduling.visitReason),
          preferredWindow: cleanString(
            understanding.scheduling.preferredWindow,
          ),
          selectedSlotId: cleanString(understanding.scheduling.selectedSlotId),
          visitType: understanding.scheduling.visitType ?? undefined,
          bookingConfirmed:
            understanding.scheduling.bookingConfirmed ?? undefined,
          note: understanding.scheduling.note
            ? {
                appointmentReason: cleanString(
                  understanding.scheduling.note.appointmentReason,
                ),
                referringDoctor: cleanString(
                  understanding.scheduling.note.referringDoctor,
                ),
              }
            : undefined,
        }
      : undefined,
    insurance: understanding.insurance
      ? {
          ...understanding.insurance,
          plan: cleanString(understanding.insurance.plan),
          coverageType: understanding.insurance.coverageType ?? undefined,
        }
      : undefined,
    confirmation: understanding.confirmation
      ? {
          cancelConfirmed:
            understanding.confirmation.cancelConfirmed ?? undefined,
          routeConfirmed:
            understanding.confirmation.routeConfirmed ?? undefined,
          transferConfirmed:
            understanding.confirmation.transferConfirmed ?? undefined,
        }
      : undefined,
    interruption: understanding.interruption ?? "none",
    evidence: (understanding.evidence ?? []).map(cleanString).filter(isString),
  };
}

function applyPatientUnderstanding(
  flow: CallFlowState,
  understanding: TurnUnderstanding,
): void {
  const patient = understanding.patient;
  if (!patient) return;

  const relationship =
    patient.relationshipToCaller ??
    relationshipForMention(patient.patientMentioned ?? undefined);
  const firstName = cleanString(patient.firstName);
  const lastName = cleanString(patient.lastName);
  const dob = cleanString(patient.dob);
  const phone = cleanString(patient.phone);

  if (!relationship && !firstName && !lastName && !dob && !phone) return;

  const activePatient = ensureActivePatientContext(flow);
  if (
    activePatient.status === "verified" &&
    patientMatchesSpokenIdentity(activePatient, {
      firstName,
      lastName,
      dob,
      relationshipToCaller: relationship,
    })
  ) {
    if (relationship) setActivePatientRelationship(flow, relationship);
    return;
  }

  if (
    relationship &&
    !firstName &&
    !lastName &&
    !dob &&
    !phone &&
    relationship === "self"
  ) {
    setActivePatientRelationship(flow, relationship);
    return;
  }

  recordPatientVerificationAttempt(flow, {
    firstName,
    lastName,
    dob,
    phone,
    usePhone: Boolean(phone),
    relationshipToCaller: relationship,
    source: sourceForUnderstanding(understanding),
  });
}

function applySchedulingUnderstanding(
  flow: CallFlowState,
  understanding: TurnUnderstanding,
): void {
  const scheduling = understanding.scheduling;
  if (!scheduling && !isSchedulingGoal(understanding.goal)) return;

  const visitType = scheduling?.visitType ?? undefined;
  if (visitType) {
    flow.visitType = visitType;
    const coverageType = coverageTypeForVisitType(visitType);
    if (coverageType) flow.coverageType = coverageType;
  }

  const preferredWindow = cleanString(scheduling?.preferredWindow);
  const visitReason = cleanString(scheduling?.visitReason);
  const selectedSlotId = cleanString(scheduling?.selectedSlotId);
  const bookingConfirmed = scheduling?.bookingConfirmed ?? undefined;
  const appointmentAction = appointmentActionForGoal(understanding);

  if (
    !flow.schedulingGoal &&
    !preferredWindow &&
    !visitReason &&
    !selectedSlotId &&
    !visitType &&
    bookingConfirmed === undefined &&
    !appointmentAction
  ) {
    return;
  }

  flow.schedulingGoal = {
    ...(flow.schedulingGoal ?? {
      status: "collecting",
      updatedAt: Date.now(),
    }),
    patientRef: flow.activePatientRef,
    ...(appointmentAction ? { appointmentAction } : {}),
    ...(visitReason ? { visitReason } : {}),
    ...(visitType ? { visitType } : {}),
    ...(preferredWindow ? { preferredWindow } : {}),
    ...(selectedSlotId ? { selectedSlotId } : {}),
    ...(bookingConfirmed !== undefined ? { bookingConfirmed } : {}),
    noteDraft: mergeNoteDraft(
      flow.schedulingGoal?.noteDraft,
      scheduling?.note,
      understanding.evidence,
    ),
    lastConfidence: understanding.confidence,
    evidence: understanding.evidence?.slice(0, 4) ?? [],
    updatedAt: Date.now(),
  };

  advanceSchedulingStepAfterVisitContext(
    flow,
    Boolean(visitReason || visitType),
  );
}

function applyInsuranceUnderstanding(
  flow: CallFlowState,
  understanding: TurnUnderstanding,
): void {
  const plan = cleanString(understanding.insurance?.plan);
  const coverageType =
    understanding.insurance?.coverageType ??
    coverageTypeForVisitType(understanding.scheduling?.visitType ?? undefined);

  if (!plan && !coverageType) return;

  if (coverageType) {
    flow.coverageType = coverageType;
    if (coverageType === "routine_vision") {
      flow.visitType = "routine_vision";
    }
  }

  if (plan) {
    updateActivePatientInsurance(flow, {
      plan,
      coverageType,
      source: "caller_spoken",
    });
    return;
  }

  if (coverageType && shouldAttachCoverageToCallerSpokenPlan(flow)) {
    updateActivePatientInsurance(flow, {
      coverageType,
      source: "caller_spoken",
    });
  }
}

function applySchedulingGoalAfterIntent(
  flow: CallFlowState,
  understanding: TurnUnderstanding,
  activeIntent: IntentKind,
): void {
  const confirmationState = confirmationStateForUnderstanding(understanding);
  if (
    !flow.schedulingGoal &&
    !isSchedulingGoal(understanding.goal) &&
    !confirmationState
  ) {
    return;
  }

  flow.schedulingGoal = {
    ...(flow.schedulingGoal ?? {
      updatedAt: Date.now(),
      status: "collecting",
    }),
    patientRef: flow.activePatientRef,
    appointmentAction:
      flow.schedulingGoal?.appointmentAction ??
      appointmentActionForIntent(activeIntent),
    status: schedulingStatusForStep(
      flow.step,
      understanding.goal === "faq" || understanding.goal === "transfer_request",
    ),
    ...confirmationState,
    lastConfidence: understanding.confidence,
    evidence: understanding.evidence?.slice(0, 4) ?? [],
    updatedAt: Date.now(),
  };
}

function confirmationStateForUnderstanding(
  understanding: TurnUnderstanding,
): Pick<
  NonNullable<CallFlowState["schedulingGoal"]>,
  | "bookingConfirmed"
  | "cancelConfirmed"
  | "routeConfirmed"
  | "transferConfirmed"
> | null {
  const confirmation = understanding.confirmation;
  const scheduling = understanding.scheduling;
  const next: Pick<
    NonNullable<CallFlowState["schedulingGoal"]>,
    | "bookingConfirmed"
    | "cancelConfirmed"
    | "routeConfirmed"
    | "transferConfirmed"
  > = {};

  if (scheduling?.bookingConfirmed != null) {
    next.bookingConfirmed = scheduling.bookingConfirmed;
  }
  if (confirmation?.cancelConfirmed != null) {
    next.cancelConfirmed = confirmation.cancelConfirmed;
  }
  if (confirmation?.routeConfirmed != null) {
    next.routeConfirmed = confirmation.routeConfirmed;
  }
  if (confirmation?.transferConfirmed != null) {
    next.transferConfirmed = confirmation.transferConfirmed;
  }

  return Object.keys(next).length > 0 ? next : null;
}

function intentForTurnUnderstanding(
  understanding: TurnUnderstanding,
): IntentKind {
  if (
    understanding.interruption === "transfer_request" ||
    understanding.goal === "transfer_request"
  ) {
    return "transfer_request";
  }
  if (understanding.interruption === "faq" || understanding.goal === "faq") {
    return "faq";
  }

  switch (understanding.goal) {
    case "schedule":
      return "new_appointment";
    case "register_new_patient":
      return "new_patient_registration";
    case "manage_existing_appointment":
      return intentForAppointmentAction(understanding.appointmentAction);
    case "insurance_question":
      return "insurance_question";
    case "unclear":
      return "unclear";
  }
}

function intentForAppointmentAction(
  action: TurnUnderstanding["appointmentAction"],
): IntentKind {
  switch (action) {
    case "cancel":
      return "existing_appointment_cancel";
    case "reschedule":
      return "existing_appointment_reschedule";
    case "confirm":
    default:
      return "existing_appointment_confirm";
  }
}

function appointmentActionForGoal(
  understanding: TurnUnderstanding,
): NonNullable<CallFlowState["schedulingGoal"]>["appointmentAction"] {
  if (understanding.goal === "schedule") return "schedule";
  if (understanding.goal !== "manage_existing_appointment") return undefined;
  return understanding.appointmentAction ?? "confirm";
}

function appointmentActionForIntent(
  intent: IntentKind,
): NonNullable<CallFlowState["schedulingGoal"]>["appointmentAction"] {
  switch (intent) {
    case "new_appointment":
    case "new_patient_registration":
      return "schedule";
    case "existing_appointment_cancel":
      return "cancel";
    case "existing_appointment_reschedule":
      return "reschedule";
    case "existing_appointment_confirm":
      return "confirm";
    default:
      return undefined;
  }
}

function schedulingStatusForStep(
  step: FlowStep,
  interrupted: boolean,
): NonNullable<CallFlowState["schedulingGoal"]>["status"] {
  if (interrupted) return "interrupted";
  switch (step) {
    case "get_availability":
      return "ready_for_availability";
    case "confirm_booking":
      return "confirming_booking";
    case "book":
      return "booked";
    case "answer":
      return "offering_slot";
    default:
      return "collecting";
  }
}

function advanceSchedulingStepAfterVisitContext(
  flow: CallFlowState,
  hasVisitContext: boolean,
): void {
  if (!hasVisitContext || flow.step !== "triage_visit_type") return;
  if (
    flow.activeIntent !== "new_appointment" &&
    flow.activeFlow !== "scheduling" &&
    flow.currentTask?.kind !== "schedule"
  ) {
    return;
  }

  const nextStep = nextPatientFlowStep(flow.patientStatus);
  flow.activeFlow = "scheduling";
  flow.step = nextStep;
  flow.requiredSlots =
    nextStep === "verify_patient"
      ? ["patientIdentity"]
      : nextStep === "collect_registration"
        ? ["patientIdentity"]
        : [];
  if (flow.currentTask?.kind === "schedule") {
    flow.currentTask.step = nextStep;
  }
}

function coverageTypeForVisitType(
  visitType?: VisitType,
): InsuranceCoverageType | undefined {
  if (visitType === "routine_vision") return "routine_vision";
  if (visitType === "medical" || visitType === "urgent") return "medical";
  return undefined;
}

function shouldAttachCoverageToCallerSpokenPlan(flow: CallFlowState): boolean {
  const patient = flow.patients[flow.activePatientRef ?? "caller"];
  return (
    patient?.insurance?.plan?.source === "caller_spoken" &&
    !patient.insurance.coverageType
  );
}

function relationshipForMention(
  patientMentioned?: NonNullable<
    TurnUnderstanding["patient"]
  >["patientMentioned"],
): PatientRelationshipToCaller | undefined {
  if (patientMentioned === "caller") return "self";
  return undefined;
}

function sourceForUnderstanding(
  understanding: TurnUnderstanding,
): TrackedSlotSource {
  return understanding.interruption === "correction" ||
    understanding.patient?.correction
    ? "caller_spelled"
    : "caller_spoken";
}

function patientMatchesSpokenIdentity(
  patient: PatientContext,
  next: {
    firstName?: string;
    lastName?: string;
    dob?: string;
    relationshipToCaller?: PatientRelationshipToCaller;
  },
): boolean {
  return (
    !conflicts(patient.firstName?.value, next.firstName) &&
    !conflicts(patient.lastName?.value, next.lastName) &&
    !conflicts(patient.dob?.value, next.dob) &&
    !relationshipConflict(
      patient.relationshipToCaller,
      next.relationshipToCaller,
    )
  );
}

function conflicts(existing: string | undefined, next: string | undefined) {
  if (!existing || !next) return false;
  return normalizeForCompare(existing) !== normalizeForCompare(next);
}

function relationshipConflict(
  existing: PatientRelationshipToCaller | undefined,
  next: PatientRelationshipToCaller | undefined,
): boolean {
  if (!existing || existing === "unknown" || !next || next === "unknown") {
    return false;
  }
  return existing !== next;
}

function normalizeForCompare(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isSchedulingGoal(goal: TurnGoal): boolean {
  return (
    goal === "schedule" ||
    goal === "register_new_patient" ||
    goal === "manage_existing_appointment"
  );
}

function mergeNoteDraft(
  existing: NonNullable<CallFlowState["schedulingGoal"]>["noteDraft"],
  note?: TurnUnderstandingNote,
  evidence: string[] = [],
): NonNullable<CallFlowState["schedulingGoal"]>["noteDraft"] {
  const nextAppointmentReason = cleanString(note?.appointmentReason);
  const nextReferringDoctor = cleanString(note?.referringDoctor);
  const appointmentReason =
    nextAppointmentReason &&
    noteValueIsGroundedInEvidence(nextAppointmentReason, evidence)
      ? nextAppointmentReason
      : existing?.appointmentReason;
  const referringDoctor =
    nextReferringDoctor &&
    noteValueIsGroundedInEvidence(nextReferringDoctor, evidence)
      ? nextReferringDoctor
      : existing?.referringDoctor;

  if (!appointmentReason && !referringDoctor) return undefined;
  return {
    ...(appointmentReason ? { appointmentReason } : {}),
    ...(referringDoctor ? { referringDoctor } : {}),
  };
}

function noteValueIsGroundedInEvidence(
  value: string,
  evidence: string[] = [],
): boolean {
  const normalizedValue = normalizeEvidenceText(value);
  if (!normalizedValue) return false;
  if (normalizedValue === "none") return true;

  const normalizedEvidence = normalizeEvidenceText(evidence.join(" "));
  if (!normalizedEvidence) return false;
  if (normalizedEvidence.includes(normalizedValue)) return true;

  const withoutTitle = normalizedValue.replace(/^(doctor|dr)\s+/, "").trim();
  return withoutTitle.length >= 3 && normalizedEvidence.includes(withoutTitle);
}

function normalizeEvidenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAffirmative(normalized: string): boolean {
  return /^(yes|yeah|yep|correct|right|sure|ok|okay|perfect|that works|sounds good|that sounds good|go ahead|please do|yup)\b/.test(
    normalized,
  );
}

function isNegative(normalized: string): boolean {
  return /^(no|nope|not that|that does not work|doesn t work|different|another|not correct)\b/.test(
    normalized,
  );
}

function appointmentActionFromTranscript(
  normalized: string,
): TurnUnderstanding["appointmentAction"] | undefined {
  if (/\b(reschedule|re schedule|move|change)\b/.test(normalized)) {
    return "reschedule";
  }
  if (/\b(cancel|cancelation|cancellation)\b/.test(normalized)) {
    return "cancel";
  }
  if (/\b(confirm|check my appointment|appointment time)\b/.test(normalized)) {
    return "confirm";
  }
  return undefined;
}

function scheduleIntentFromTranscript(normalized: string): boolean {
  return /\b(schedule|book|make|set up|get on the schedule|availability|openings|appointment)\b/.test(
    normalized,
  );
}

function insuranceQuestionFromTranscript(normalized: string): boolean {
  return /\b(insurance|coverage|plan|do you take|accept)\b/.test(normalized);
}

function transferRequestFromTranscript(normalized: string): boolean {
  return /\b(human|person|front desk|office|representative|someone|transfer)\b/.test(
    normalized,
  );
}

function isBookingConfirmationFlow(
  flow: CallFlowState,
  command: WorkflowCommand | undefined,
): boolean {
  return (
    flow.step === "confirm_booking" ||
    command?.phase === "confirming_booking" ||
    command?.missingFacts.some((fact) => fact.key === "bookingConfirmation") ===
      true
  );
}

function isRescheduleConfirmationFlow(
  flow: CallFlowState,
  command: WorkflowCommand | undefined,
): boolean {
  return (
    flow.activeIntent === "existing_appointment_reschedule" ||
    command?.taskKind === "appointment_reschedule" ||
    command?.missingFacts.some(
      (fact) => fact.key === "rescheduleConfirmation",
    ) === true
  );
}

function selectedSlotForConfirmation(
  flow: CallFlowState,
  command: WorkflowCommand | undefined,
): string | undefined {
  const args = command?.args;
  const commandSlotId =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as { slotId?: unknown }).slotId
      : undefined;
  return (
    flow.schedulingGoal?.selectedSlotId ??
    (typeof commandSlotId === "string" ? commandSlotId : undefined) ??
    latestCachedSlotId(flow)
  );
}

function latestCachedSlotId(flow: CallFlowState): string | undefined {
  return [...flow.availabilitySearches]
    .reverse()
    .find((search) => search.status !== "invalidated")?.cachedSlots[0]
    ?.slotHash;
}

function shouldTreatTranscriptAsVisitReason(
  flow: CallFlowState,
  command: WorkflowCommand | undefined,
  transcript: string,
): boolean {
  if (!transcript || transcript.length > 120) return false;
  return (
    flow.step === "triage_visit_type" ||
    flow.step === "collect_visit_reason" ||
    command?.missingFacts.some((fact) => fact.key === "visitReason") === true
  );
}

function shouldTreatTranscriptAsPreferredWindow(
  flow: CallFlowState,
  command: WorkflowCommand | undefined,
  normalized: string,
): boolean {
  if (
    flow.step !== "get_availability" &&
    command?.missingFacts.some(
      (fact) =>
        fact.key === "preferredDate" ||
        fact.key === "replacementWindow" ||
        fact.key === "availability" ||
        fact.key === "replacementAvailability",
    ) !== true
  ) {
    return false;
  }

  return hasPreferredWindowCue(normalized);
}

function hasPreferredWindowCue(normalized: string): boolean {
  return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|later|earlier|next week|this week|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(st|nd|rd|th)?|\d{1,2}:\d{2})\b/.test(
    normalized,
  );
}

function invalidateStateForNewFacts(
  flow: CallFlowState,
  reason: AvailabilityInvalidationReason,
): void {
  invalidateAvailabilitySearches(flow, reason);
  invalidatePendingActionsForStateChange(flow, reason);
}

function schedulingPathFactsChanged(
  understanding: TurnUnderstanding,
  before: {
    coverageType?: string;
    insurancePlan?: string;
    visitReason?: string;
    visitType?: string;
  },
): boolean {
  const visitReason = cleanString(understanding.scheduling?.visitReason);
  const visitType = understanding.scheduling?.visitType ?? undefined;
  const coverageType =
    understanding.insurance?.coverageType ??
    coverageTypeForVisitType(visitType);
  const insurancePlan = cleanString(understanding.insurance?.plan);

  return (
    trackedFactChanged(visitReason, before.visitReason) ||
    trackedFactChanged(visitType, before.visitType) ||
    trackedFactChanged(coverageType, before.coverageType) ||
    trackedFactChanged(insurancePlan, before.insurancePlan)
  );
}

function trackedFactChanged(
  next: string | undefined,
  previous: string | undefined,
): boolean {
  if (!next) return false;
  if (!previous) return true;
  return (
    normalizeFactForComparison(next) !== normalizeFactForComparison(previous)
  );
}

function normalizeFactForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function activePatientInsurancePlan(flow: CallFlowState): string | undefined {
  const patient = flow.patients[flow.activePatientRef ?? "caller"];
  return patient?.insurance?.canonicalPlan ?? patient?.insurance?.plan?.value;
}

function cleanString(value?: string | null): string | undefined {
  const cleaned = value?.trim().replace(/\s+/g, " ");
  return cleaned || undefined;
}

function isString(value: string | undefined): value is string {
  return Boolean(value);
}
