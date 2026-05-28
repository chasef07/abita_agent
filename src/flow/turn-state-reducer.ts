import type { InsuranceCoverageType } from "../insurance-rules.js";
import { invalidateAvailabilitySearches } from "./availability.js";
import { applyInferredIntentState, type IntentStateUpdate } from "./intent.js";
import { invalidatePendingActionsForStateChange } from "./pending-actions.js";
import {
  applyPreCallIdentityFromTranscript,
  ensureActivePatientContext,
  hasActivePatientIdentityChanged,
  nextPatientFlowStep,
  recordPatientVerificationAttempt,
  setActivePatientRelationship,
  snapshotActivePatientIdentity,
  updateActivePatientInsurance,
} from "./state.js";
import {
  normalizeTurnUnderstanding,
  turnUnderstandingToInferredIntent,
  type TurnUnderstanding,
} from "./understanding.js";
import type {
  AvailabilityInvalidationReason,
  CallFlowState,
  FlowStep,
  IntentKind,
  PatientContext,
  PatientRelationshipToCaller,
  TrackedSlotSource,
  VisitType,
} from "./types.js";

type TurnUnderstandingNote = NonNullable<
  NonNullable<TurnUnderstanding["scheduling"]>["note"]
>;

export interface TurnUnderstandingStateUpdate extends IntentStateUpdate {
  understanding: TurnUnderstanding;
  pathFactsChanged: boolean;
}

export function reduceTurnUnderstandingFromTranscript(
  flow: CallFlowState,
  transcript: string,
  understanding: TurnUnderstanding,
): TurnUnderstandingStateUpdate {
  applyPreCallIdentityFromTranscript(flow, transcript);
  return reduceTurnUnderstanding(flow, understanding);
}

export function reduceTurnUnderstanding(
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

  reducePatientUnderstanding(flow, normalized);
  reduceSchedulingUnderstanding(flow, normalized);
  reduceInsuranceUnderstanding(flow, normalized);

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

  const inferred = turnUnderstandingToInferredIntent(normalized, flow);
  const update = applyInferredIntentState(flow, inferred);
  reduceSchedulingGoalAfterIntent(flow, normalized, inferred.activeIntent);

  return {
    ...update,
    understanding: normalized,
    pathFactsChanged,
  };
}

function reducePatientUnderstanding(
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
    relationshipToCaller: relationship,
    source: sourceForUnderstanding(understanding),
  });
}

function reduceSchedulingUnderstanding(
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
  const appointmentAction = appointmentActionForGoal(flow, understanding);

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

function reduceInsuranceUnderstanding(
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

function reduceSchedulingGoalAfterIntent(
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

function appointmentActionForGoal(
  flow: CallFlowState,
  understanding: TurnUnderstanding,
): NonNullable<CallFlowState["schedulingGoal"]>["appointmentAction"] {
  if (understanding.goal === "schedule") {
    return shouldTreatScheduleTurnAsRescheduleFact(flow, understanding)
      ? "reschedule"
      : "schedule";
  }
  if (understanding.goal !== "manage_existing_appointment") return undefined;
  return understanding.appointmentAction ?? "confirm";
}

function shouldTreatScheduleTurnAsRescheduleFact(
  flow: CallFlowState,
  understanding: TurnUnderstanding,
): boolean {
  if (understanding.goal !== "schedule") return false;
  if (
    flow.activeIntent !== "existing_appointment_reschedule" &&
    flow.schedulingGoal?.appointmentAction !== "reschedule"
  ) {
    return false;
  }

  const scheduling = understanding.scheduling;
  const hasNewVisitContext = Boolean(
    cleanString(scheduling?.visitReason) || scheduling?.visitType,
  );
  const hasRescheduleFact = Boolean(
    cleanString(scheduling?.preferredWindow) ||
    cleanString(scheduling?.selectedSlotId) ||
    scheduling?.bookingConfirmed !== undefined ||
    cleanString(scheduling?.note?.appointmentReason) ||
    cleanString(scheduling?.note?.referringDoctor),
  );

  return hasRescheduleFact && !hasNewVisitContext;
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

function isSchedulingGoal(goal: TurnUnderstanding["goal"]): boolean {
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
