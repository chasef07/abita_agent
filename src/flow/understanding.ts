import { z } from "zod";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import { type InferredCallerIntent } from "./intent.js";
import { activeWorkflowCommandForState } from "./plans/active-command.js";
import type {
  CallFlowState,
  IntentKind,
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
      registrationConfirmed: z.boolean().nullable().optional(),
      insuranceUpdateConfirmed: z.boolean().nullable().optional(),
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
  const cancelConfirmationPending =
    activeCommand?.confirmationType === "cancel" ||
    flow.pendingConfirmation?.type === "cancel";
  const explicitCancel = cancelConfirmationPending
    ? isExplicitCancelConfirmation(normalized)
    : false;
  const explicitCancelRejection = cancelConfirmationPending
    ? isExplicitCancelRejection(normalized)
    : false;

  if (affirmative || negative || explicitCancel || explicitCancelRejection) {
    const confirmed =
      (affirmative || explicitCancel) && !explicitCancelRejection;
    if (cancelConfirmationPending) {
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
    if (
      activeCommand?.confirmationType === "registration" ||
      flow.pendingConfirmation?.type === "registration"
    ) {
      return {
        goal: "register_new_patient",
        confirmation: { registrationConfirmed: confirmed },
        confidence: 0.95,
        evidence,
      };
    }
    if (
      activeCommand?.confirmationType === "insurance_update" ||
      flow.pendingConfirmation?.type === "insurance_update"
    ) {
      return {
        goal: "insurance_question",
        confirmation: { insuranceUpdateConfirmed: confirmed },
        confidence: 0.95,
        evidence,
      };
    }
    if (
      activeCommand?.confirmationType === "transfer" ||
      flow.pendingConfirmation?.type === "transfer"
    ) {
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

  if (transferRequestFromTranscript(normalized)) {
    return {
      goal: "transfer_request",
      interruption: "transfer_request",
      confidence: 0.86,
      evidence,
    };
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

  if (
    shouldTreatTranscriptAsReferringDoctor(activeCommand, cleaned, normalized)
  ) {
    return {
      goal: "schedule",
      scheduling: {
        note: {
          referringDoctor: referringDoctorValueFromTranscript(
            cleaned,
            normalized,
          ),
        },
      },
      confidence: 0.9,
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

export function turnUnderstandingToInferredIntent(
  understanding: TurnUnderstanding,
  flow?: CallFlowState,
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
    activeIntent: intentForTurnUnderstanding(understanding, flow),
  };

  if (visitReason) inferred.visitReason = visitReason;
  if (visitType) inferred.visitType = visitType;
  if (insurancePlan) inferred.insurancePlan = insurancePlan;
  if (coverageType) inferred.coverageType = coverageType;
  return inferred;
}

export function normalizeTurnUnderstanding(
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
          registrationConfirmed:
            understanding.confirmation.registrationConfirmed ?? undefined,
          insuranceUpdateConfirmed:
            understanding.confirmation.insuranceUpdateConfirmed ?? undefined,
          transferConfirmed:
            understanding.confirmation.transferConfirmed ?? undefined,
        }
      : undefined,
    interruption: understanding.interruption ?? "none",
    evidence: (understanding.evidence ?? []).map(cleanString).filter(isString),
  };
}

function intentForTurnUnderstanding(
  understanding: TurnUnderstanding,
  flow?: CallFlowState,
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
      if (
        flow &&
        shouldTreatScheduleTurnAsRescheduleFact(flow, understanding)
      ) {
        return "existing_appointment_reschedule";
      }
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

function coverageTypeForVisitType(
  visitType?: VisitType,
): InsuranceCoverageType | undefined {
  if (visitType === "routine_vision") return "routine_vision";
  if (visitType === "medical" || visitType === "urgent") return "medical";
  return undefined;
}

function isAffirmative(normalized: string): boolean {
  return /^(yes|yeah|yep|correct|right|sure|ok|okay|perfect|that works|sounds good|that sounds good|go ahead|please do|yup|i confirm)\b/.test(
    normalized,
  );
}

function isNegative(normalized: string): boolean {
  return /^(no|nope|not that|that does not work|doesn t work|different|another|not correct)\b/.test(
    normalized,
  );
}

function isExplicitCancelConfirmation(normalized: string): boolean {
  return (
    /\bcancel\b/.test(normalized) && !isExplicitCancelRejection(normalized)
  );
}

function isExplicitCancelRejection(normalized: string): boolean {
  return /\b(no|not|don t|dont|do not|stop)\b.{0,24}\bcancel\b/.test(
    normalized,
  );
}

function appointmentActionFromTranscript(
  normalized: string,
): TurnUnderstanding["appointmentAction"] | undefined {
  if (
    insuranceQuestionFromTranscript(normalized) &&
    !appointmentContextFromTranscript(normalized)
  ) {
    return undefined;
  }

  if (/\b(reschedule|re schedule)\b/.test(normalized)) {
    return "reschedule";
  }

  if (
    /\bmove\b/.test(normalized) &&
    appointmentContextFromTranscript(normalized)
  ) {
    return "reschedule";
  }

  if (
    /\b(changes?|changed|changing)\b/.test(normalized) &&
    appointmentContextFromTranscript(normalized)
  ) {
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

function appointmentContextFromTranscript(normalized: string): boolean {
  return /\b(appointment|appt|visit|schedule|booking|booked|slot|time|date)\b/.test(
    normalized,
  );
}

function transferRequestFromTranscript(normalized: string): boolean {
  return (
    /\b(transfer|front desk|representative|office staff)\b/.test(normalized) ||
    /\b(talk|speak)\b(?:\s+\w+){0,3}\s+(?:to|with)\s+(?:someone|somebody|a person|person|a human|human|representative|staff|front desk|office)\b/.test(
      normalized,
    ) ||
    /\b(persona real|alguien real|oficinista|recepcionista)\b/.test(
      normalized,
    ) ||
    /\b(?:necesito|quiero|ocupo|busco)\b(?:\s+\w+){0,4}\s+(?:oficina|oficinista|recepcionista|persona real|alguien real)\b/.test(
      normalized,
    ) ||
    /\b(?:hablar|comunicarme)\b(?:\s+\w+){0,4}\s+(?:con|a)\s+(?:alguien|una persona|persona real|recepcionista|oficina)\b/.test(
      normalized,
    )
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
  if (commandHasMissingFact(command, "referringDoctor")) return false;
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

function shouldTreatTranscriptAsReferringDoctor(
  command: WorkflowCommand | undefined,
  transcript: string,
  normalized: string,
): boolean {
  if (!commandHasMissingFact(command, "referringDoctor")) return false;
  if (looksLikeProviderConfirmation(normalized)) return false;
  const trimmed = transcript.trim();
  return trimmed.length > 0 && trimmed.length <= 120;
}

function referringDoctorValueFromTranscript(
  transcript: string,
  normalized: string,
): string {
  if (isNoReferringDoctorResponse(normalized)) return "none";
  return transcript.trim();
}

function isNoReferringDoctorResponse(normalized: string): boolean {
  return /\b(no referring doctor|no referral|none|nobody referred|no one referred|don t have one|do not have one|i don t have one|i do not have one|not referred|self referred)\b/.test(
    normalized,
  );
}

function looksLikeProviderConfirmation(normalized: string): boolean {
  if (/\b(refer|referred|referral|sent)\b/.test(normalized)) return false;
  return (
    /\b(?:with\s+)?(?:doctor|dr)\s+(?:bach|licht|noel|austin\s+bach|j\s+licht|d\s+noel)\b/.test(
      normalized,
    ) && /\b(?:yes|yeah|yep|correct|right|ok|okay)\b/.test(normalized)
  );
}

function commandHasMissingFact(
  command: WorkflowCommand | undefined,
  key: string,
): boolean {
  return command?.missingFacts.some((fact) => fact.key === key) === true;
}

function hasPreferredWindowCue(normalized: string): boolean {
  return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|later|earlier|next week|this week|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(st|nd|rd|th)?|\d{1,2}:\d{2})\b/.test(
    normalized,
  );
}

function cleanString(value?: string | null): string | undefined {
  const cleaned = value?.trim().replace(/\s+/g, " ");
  return cleaned || undefined;
}

function normalizeEvidenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isString(value: string | undefined): value is string {
  return Boolean(value);
}
