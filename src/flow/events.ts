import type {
  ActiveFlow,
  AppointmentLoadStatus,
  CallFlowState,
  CallerAppointment,
  AvailabilityInvalidationReason,
  FlowStep,
  IntentKind,
  PatientStatus,
  PatientRef,
  SchedulingRouting,
  TrackedSlotSource,
  VisitType,
  WorkflowCommand,
  WorkflowToolName,
} from "./types.js";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { SideEffectToolName } from "./pending-actions.js";
import {
  turnUnderstandingToInferredIntent,
  type TurnUnderstanding,
} from "./understanding.js";

export type FlowEventSource =
  | "deterministic_understanding"
  | "model_understanding"
  | "tool_result"
  | "policy"
  | "planner"
  | "system";

export interface CallerTurnMeaning {
  intent?: IntentKind;
  facts?: {
    patient?: PatientIdentityFacts;
    scheduling?: SchedulingFacts;
    insurance?: InsuranceFacts;
    appointment?: AppointmentManagementFacts;
  };
  confirmation?: {
    type:
      | "booking"
      | "cancel"
      | "reschedule"
      | "transfer"
      | "route_office"
      | "registration"
      | "insurance_update";
    confirmed: boolean;
  };
  topicSwitch?: boolean;
  evidence: string[];
  confidence: number;
}

export interface PatientIdentityFacts {
  patientMentioned?: "caller" | "someone_else" | "unknown";
  relationshipToCaller?: string;
  firstName?: string;
  lastName?: string;
  dob?: string;
  phone?: string;
  correction?: boolean;
}

export interface SchedulingFacts {
  visitReason?: string;
  visitType?: string;
  preferredWindow?: string;
  selectedSlotId?: string;
  bookingConfirmed?: boolean;
  appointmentReason?: string;
  referringDoctor?: string;
}

export interface InsuranceFacts {
  plan?: string;
  coverageType?: string;
}

export interface AppointmentManagementFacts {
  action?: "confirm" | "cancel" | "reschedule";
  targetAppointmentId?: number;
}

export interface FlowEventBase {
  id: string;
  type: string;
  createdAt: number;
  source: FlowEventSource;
  transcript?: string;
  confidence?: number;
  evidence?: string[];
}

export interface CallerTurnMeaningEvent extends FlowEventBase {
  type: "caller_turn_meaning";
  meaning: CallerTurnMeaning;
  understanding: TurnUnderstanding;
}

export interface PreCallIdentityObservedEvent extends FlowEventBase {
  type: "pre_call_identity_observed";
  transcript: string;
}

export interface ConfirmedPreCallCallerRestoredEvent extends FlowEventBase {
  type: "confirmed_pre_call_caller_restored";
}

export interface PlannerCommandEvent extends FlowEventBase {
  type: "planner_command_applied";
  command: WorkflowCommand;
}

export interface ToolGuardObservedEvent extends FlowEventBase {
  type: "tool_guard_observed";
  toolName: WorkflowToolName;
  argsHash: string;
  guardAllowed: boolean;
}

export interface WorkflowFactEvent extends FlowEventBase {
  type: "workflow_fact_event";
  workflowEventType:
    | "facts_changed"
    | "patient_verified"
    | "appointments_loaded"
    | "appointments_none_found"
    | "availability_offered"
    | "booking_succeeded"
    | "cancel_succeeded";
}

export interface WorkflowStepUpdatedEvent extends FlowEventBase {
  type: "workflow_step_updated";
  step: FlowStep;
  activeFlow?: ActiveFlow;
}

export interface PatientRecordedEvent extends FlowEventBase {
  type: "patient_recorded";
  patientId?: string | null;
  patientName?: string | null;
  dob?: string | null;
  phone?: string | null;
  appointments?: CallerAppointment[] | null;
  appointmentsStatus?: AppointmentLoadStatus | null;
  slotSource?: TrackedSlotSource;
}

export interface PatientPayloadAppliedEvent extends FlowEventBase {
  type: "patient_payload_applied";
  patientStatus?: PatientStatus;
  officeKey: CallFlowState["officeKey"];
  routing?: SchedulingRouting;
  allowedProviders?: string[];
  routingAmbiguous?: boolean;
  preauthRequired?: boolean;
  coverageType?: InsuranceCoverageType;
  visitType?: VisitType;
  insurance?: {
    plan?: string | null;
    coverageType?: InsuranceCoverageType | null;
    canonicalPlan?: string | null;
    currentCarrier?: string | null;
    source?: TrackedSlotSource;
  };
}

export interface PatientSessionClearedEvent extends FlowEventBase {
  type: "patient_session_cleared";
}

export interface ActivePatientStatusSyncedEvent extends FlowEventBase {
  type: "active_patient_status_synced";
  patientStatus: PatientStatus;
}

export interface ActivePatientAppointmentsRecordedEvent extends FlowEventBase {
  type: "active_patient_appointments_recorded";
  appointments: CallerAppointment[];
  appointmentsStatus?: AppointmentLoadStatus | null;
}

export interface ActivePatientAppointmentRemovedEvent extends FlowEventBase {
  type: "active_patient_appointment_removed";
  appointmentId: number;
}

export interface PatientVerificationAttemptedEvent extends FlowEventBase {
  type: "patient_verification_attempted";
  firstName?: string;
  lastName?: string;
  dob?: string;
  phone?: string;
}

export interface ActivePatientInsuranceUpdatedEvent extends FlowEventBase {
  type: "active_patient_insurance_updated";
  plan?: string | null;
  coverageType?: InsuranceCoverageType | null;
  canonicalPlan?: string | null;
  currentCarrier?: string | null;
  routing?: SchedulingRouting | null;
  allowedProviders?: string[];
  routingAmbiguous?: boolean;
  preauthRequired?: boolean;
  slotSource?: TrackedSlotSource;
}

export interface InsuranceCheckedEvent extends FlowEventBase {
  type: "insurance_checked";
  plan: string;
  canonicalPlan?: string | null;
  coverageType?: InsuranceCoverageType | null;
  status: "accepted" | "not_accepted" | "needs_clarification" | "unknown";
  officeKey: CallFlowState["officeKey"];
}

export interface RoutineVisionOfficeEnsuredEvent extends FlowEventBase {
  type: "routine_vision_office_ensured";
  officeKey: "spring-hill";
}

export interface OfficeRoutedEvent extends FlowEventBase {
  type: "office_routed";
  officeKey: CallFlowState["officeKey"];
}

export interface AvailabilityVisitContextEnsuredEvent extends FlowEventBase {
  type: "availability_visit_context_ensured";
  visitType: VisitType;
}

export interface RescheduleReplacementBookedEvent extends FlowEventBase {
  type: "reschedule_replacement_booked";
  replacementBookedAppointmentId: number;
}

export interface RescheduleOldAppointmentCancelledEvent extends FlowEventBase {
  type: "reschedule_old_appointment_cancelled";
  appointmentId: number;
}

export interface AvailabilityInvalidatedEvent extends FlowEventBase {
  type: "availability_invalidated";
  reason: AvailabilityInvalidationReason;
}

export interface SideEffectConfirmationRequestedEvent extends FlowEventBase {
  type: "side_effect_confirmation_requested";
  toolName: SideEffectToolName;
  argsHash: string;
  spokenSummary: string;
  patientRef?: PatientRef;
  appointmentId?: number;
  requiredFieldsComplete?: boolean;
  requestedAfterTranscript?: string;
  toolCallId: string;
}

export interface SideEffectConfirmedEvent extends FlowEventBase {
  type: "side_effect_confirmed";
  toolName: SideEffectToolName;
  argsHash: string;
  spokenSummary: string;
  patientRef?: PatientRef;
  appointmentId?: number;
  requiredFieldsComplete?: boolean;
  toolCallId: string;
}

export interface ToolSucceededEvent extends FlowEventBase {
  type: "tool_succeeded";
  toolName: WorkflowToolName;
  outputClass: string;
  argsHash?: string;
  patientRef?: PatientRef;
  appointmentId?: number;
  facts: Record<string, unknown>;
}

export interface ToolFailedEvent extends FlowEventBase {
  type: "tool_failed";
  toolName: WorkflowToolName;
  reason: string;
  facts?: Record<string, unknown>;
}

export type FlowEvent =
  | CallerTurnMeaningEvent
  | PreCallIdentityObservedEvent
  | ConfirmedPreCallCallerRestoredEvent
  | PlannerCommandEvent
  | ToolGuardObservedEvent
  | WorkflowFactEvent
  | WorkflowStepUpdatedEvent
  | PatientRecordedEvent
  | PatientPayloadAppliedEvent
  | PatientSessionClearedEvent
  | ActivePatientStatusSyncedEvent
  | ActivePatientAppointmentsRecordedEvent
  | ActivePatientAppointmentRemovedEvent
  | PatientVerificationAttemptedEvent
  | ActivePatientInsuranceUpdatedEvent
  | InsuranceCheckedEvent
  | RoutineVisionOfficeEnsuredEvent
  | OfficeRoutedEvent
  | AvailabilityVisitContextEnsuredEvent
  | RescheduleReplacementBookedEvent
  | RescheduleOldAppointmentCancelledEvent
  | AvailabilityInvalidatedEvent
  | SideEffectConfirmationRequestedEvent
  | SideEffectConfirmedEvent
  | ToolSucceededEvent
  | ToolFailedEvent;

let eventSequence = 0;

export function nextFlowEventId(prefix = "flow_event"): string {
  eventSequence += 1;
  return `${prefix}_${Date.now()}_${eventSequence}`;
}

export function isTransferIntent(intent: IntentKind | undefined): boolean {
  return intent === "transfer_request";
}

export function isTransferConfirmation(
  meaning: CallerTurnMeaning,
): boolean | undefined {
  return meaning.confirmation?.type === "transfer"
    ? meaning.confirmation.confirmed
    : undefined;
}

export function patientRefForMeaning(
  meaning: CallerTurnMeaning,
): PatientRef | undefined {
  return meaning.facts?.patient?.patientMentioned === "caller"
    ? "caller"
    : undefined;
}

export function callerTurnMeaningFromUnderstanding(
  understanding: TurnUnderstanding,
  flow?: CallFlowState,
): CallerTurnMeaning {
  const inferred = turnUnderstandingToInferredIntent(understanding, flow);
  const scheduling = understanding.scheduling;
  const patient = understanding.patient;
  const insurance = understanding.insurance;
  const confirmation = confirmationMeaning(understanding);
  const appointmentAction = understanding.appointmentAction ?? undefined;

  return {
    intent: inferred.activeIntent,
    facts: {
      ...(patient
        ? {
            patient: {
              patientMentioned: patient.patientMentioned ?? undefined,
              relationshipToCaller: patient.relationshipToCaller ?? undefined,
              firstName: patient.firstName ?? undefined,
              lastName: patient.lastName ?? undefined,
              dob: patient.dob ?? undefined,
              phone: patient.phone ?? undefined,
              correction: patient.correction,
            },
          }
        : {}),
      ...(scheduling
        ? {
            scheduling: {
              visitReason: scheduling.visitReason ?? undefined,
              visitType: scheduling.visitType ?? undefined,
              preferredWindow: scheduling.preferredWindow ?? undefined,
              selectedSlotId: scheduling.selectedSlotId ?? undefined,
              bookingConfirmed: scheduling.bookingConfirmed ?? undefined,
              appointmentReason:
                scheduling.note?.appointmentReason ?? undefined,
              referringDoctor: scheduling.note?.referringDoctor ?? undefined,
            },
          }
        : {}),
      ...(insurance
        ? {
            insurance: {
              plan: insurance.plan ?? undefined,
              coverageType: insurance.coverageType ?? undefined,
            },
          }
        : {}),
      ...(appointmentAction
        ? {
            appointment: {
              action: appointmentAction,
            },
          }
        : {}),
    },
    ...(confirmation ? { confirmation } : {}),
    topicSwitch:
      understanding.interruption === "faq" ||
      understanding.interruption === "transfer_request" ||
      understanding.interruption === "correction",
    evidence: understanding.evidence ?? [],
    confidence: understanding.confidence,
  };
}

export function callerTurnMeaningEvent({
  transcript,
  understanding,
  flow,
  source = "deterministic_understanding",
}: {
  transcript: string;
  understanding: TurnUnderstanding;
  flow?: CallFlowState;
  source?: CallerTurnMeaningEvent["source"];
}): CallerTurnMeaningEvent {
  const meaning = callerTurnMeaningFromUnderstanding(understanding, flow);
  return {
    id: nextFlowEventId("caller_turn"),
    type: "caller_turn_meaning",
    source,
    createdAt: Date.now(),
    transcript,
    confidence: meaning.confidence,
    evidence: meaning.evidence,
    meaning,
    understanding,
  };
}

function confirmationMeaning(
  understanding: TurnUnderstanding,
): CallerTurnMeaning["confirmation"] | undefined {
  if (understanding.confirmation?.transferConfirmed != null) {
    return {
      type: "transfer",
      confirmed: understanding.confirmation.transferConfirmed,
    };
  }
  if (understanding.confirmation?.cancelConfirmed != null) {
    return {
      type: "cancel",
      confirmed: understanding.confirmation.cancelConfirmed,
    };
  }
  if (understanding.confirmation?.routeConfirmed != null) {
    return {
      type: "route_office",
      confirmed: understanding.confirmation.routeConfirmed,
    };
  }
  if (understanding.confirmation?.registrationConfirmed != null) {
    return {
      type: "registration",
      confirmed: understanding.confirmation.registrationConfirmed,
    };
  }
  if (understanding.confirmation?.insuranceUpdateConfirmed != null) {
    return {
      type: "insurance_update",
      confirmed: understanding.confirmation.insuranceUpdateConfirmed,
    };
  }
  if (understanding.scheduling?.bookingConfirmed != null) {
    return {
      type:
        understanding.appointmentAction === "reschedule"
          ? "reschedule"
          : "booking",
      confirmed: understanding.scheduling.bookingConfirmed,
    };
  }
  return undefined;
}
