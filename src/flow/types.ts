import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { OfficeKey } from "../customer/profile.js";

export type ActiveFlow =
  | "intro"
  | "intent"
  | "existing_patient"
  | "new_patient"
  | "insurance"
  | "routing"
  | "scheduling"
  | "appointment_management"
  | "quick_question"
  | "transfer"
  | "end";

export type FlowStep =
  | "understand_intent"
  | "triage_visit_type"
  | "check_insurance"
  | "route_office"
  | "verify_patient"
  | "collect_registration"
  | "collect_visit_reason"
  | "get_availability"
  | "confirm_booking"
  | "book"
  | "confirm_cancel"
  | "cancel"
  | "answer"
  | "handoff";

export type FlowLanguage = "en" | "es";

export type IntentKind =
  | "new_appointment"
  | "existing_appointment_confirm"
  | "existing_appointment_cancel"
  | "existing_appointment_reschedule"
  | "insurance_question"
  | "faq"
  | "new_patient_registration"
  | "transfer_request"
  | "unclear";

export type PatientStatus =
  | "unknown"
  | "candidate"
  | "matched"
  | "verified"
  | "new"
  | "created";

export type PatientRef = string;

export type PatientRelationshipToCaller =
  | "self"
  | "child"
  | "parent"
  | "spouse"
  | "other_family"
  | "other"
  | "unknown";

export type TrackedSlotSource =
  | "phone_lookup"
  | "caller_spoken"
  | "caller_spelled"
  | "tool_result"
  | "agent_inferred";

export interface TrackedSlot {
  value: string;
  source: TrackedSlotSource;
  confidence: "low" | "medium" | "high";
  confirmed: boolean;
  turnId?: string;
}

export interface CallerAppointment {
  id: number;
  date: string;
  time: string;
  provider: string;
  type: string;
  facility: string;
  confirmed: boolean;
}

export interface InsuranceContext {
  plan?: TrackedSlot;
  coverageType?: InsuranceCoverageType;
  canonicalPlan?: string;
  checkedAtTurnId?: string;
}

export interface PatientContext {
  ref: PatientRef;
  status: PatientStatus;
  relationshipToCaller?: PatientRelationshipToCaller;
  firstName?: TrackedSlot;
  lastName?: TrackedSlot;
  dob?: TrackedSlot;
  phone?: TrackedSlot;
  patientId?: string;
  verificationAttempts: number;
  lastVerifiedArgsHash?: string;
  lastNoMatchReason?: string;
  canonicalNameSource?: "phone_lookup" | "caller_spelled" | "caller_spoken";
  spellingConfirmed?: boolean;
  insurance?: InsuranceContext;
  appointments: CallerAppointment[];
  activeSchedulingTaskId?: string;
  activeAppointmentTaskIds: string[];
}

export type VisitType =
  | "medical"
  | "routine_vision"
  | "optical_shop"
  | "urgent";

export type SchedulingRouting =
  | "bach_only"
  | "bach_licht"
  | "all_three"
  | "optical_only";

export type SchedulingGoalStatus =
  | "collecting"
  | "ready_for_availability"
  | "offering_slot"
  | "confirming_booking"
  | "booked"
  | "interrupted";

export interface SchedulingGoalState {
  patientRef?: PatientRef;
  status: SchedulingGoalStatus;
  appointmentAction?: "schedule" | "confirm" | "cancel" | "reschedule";
  visitReason?: string;
  visitType?: VisitType;
  preferredWindow?: string;
  selectedSlotId?: string;
  bookingConfirmed?: boolean;
  noteDraft?: {
    appointmentReason?: string;
    referringDoctor?: string;
  };
  lastConfidence?: number;
  evidence?: string[];
  updatedAt: number;
}

export type ConfirmationType =
  | "book"
  | "cancel"
  | "route_office"
  | "transfer"
  | "end_call";

export interface TaskFrame {
  id: string;
  kind:
    | "schedule"
    | "appointment_management"
    | "insurance"
    | "faq"
    | "transfer";
  patientRef?: PatientRef;
  step: FlowStep;
  returnTo?: string;
  createdAt: number;
}

export type PendingAction =
  | {
      id: string;
      type: "book_appt";
      patientRef: PatientRef;
      slotHash: string;
      appointmentTypeId?: number;
      officeKey: OfficeKey;
      routing?: SchedulingRouting;
      availabilitySearchId: string;
      spokenSummary: string;
      confirmed: boolean;
      consumed: boolean;
      confirmationTurnId?: string;
      createdTurnId: string;
      invalidated?: boolean;
      invalidationReason?: string;
      lastBookingAttemptHash?: string;
      bookingAttemptCount: number;
      lastBookingErrorClass?:
        | "slot_unavailable"
        | "invalid_appointment_type"
        | "duplicate_same_slot"
        | "middleware_error"
        | "unknown";
      slotInvalidated: boolean;
    }
  | {
      id: string;
      type: "cancel_appt";
      patientRef: PatientRef;
      appointmentId: number;
      argsHash: string;
      spokenSummary: string;
      confirmed: boolean;
      consumed: boolean;
      confirmationTurnId?: string;
      createdTurnId: string;
      invalidated?: boolean;
      invalidationReason?: string;
    }
  | {
      id: string;
      type: "add_patient";
      patientRef: PatientRef;
      requiredFieldsComplete: boolean;
      argsHash: string;
      spokenSummary: string;
      confirmed: boolean;
      consumed: boolean;
      confirmationTurnId?: string;
      createdTurnId: string;
      invalidated?: boolean;
      invalidationReason?: string;
    }
  | {
      id: string;
      type: "update_insurance" | "transfer_call" | "route_office";
      patientRef?: PatientRef;
      argsHash: string;
      spokenSummary: string;
      confirmed: boolean;
      consumed: boolean;
      confirmationTurnId?: string;
      createdTurnId: string;
      invalidated?: boolean;
      invalidationReason?: string;
    };

export type AvailabilityFailureReason =
  | "no_slots"
  | "caller_rejected"
  | "slot_unavailable"
  | "invalid_appointment_type"
  | "duplicate_search"
  | "budget_exhausted";

export type AvailabilityInvalidationReason =
  | "patient_changed"
  | "visit_type_changed"
  | "preferred_window_changed"
  | "insurance_changed"
  | "office_changed"
  | "routing_changed"
  | "provider_restriction_changed"
  | "appointment_type_invalid"
  | "booking_completed";

export interface CachedSlot {
  slotHash: string;
  startDatetime?: string;
  columnId?: number;
  profileId?: number;
  duration?: number;
  appointmentTypeId?: number;
}

export interface AvailabilitySearch {
  id: string;
  patientRef: PatientRef;
  officeKey: OfficeKey;
  visitType?: VisitType;
  coverageType?: InsuranceCoverageType;
  routing?: SchedulingRouting;
  appointmentTypeId?: number;
  requestedWindow?: string;
  searchedKeys: string[];
  cachedSlots: CachedSlot[];
  rejectedSlotHashes: string[];
  exactSearchCount: number;
  broadenCount: number;
  duplicateSearchCount: number;
  maxSearches: number;
  failureReasons: AvailabilityFailureReason[];
  lastInvalidationReason?: AvailabilityInvalidationReason;
  status: "active" | "exhausted" | "satisfied" | "invalidated";
}

export interface CallFlowState {
  activeIntent: IntentKind | null;
  activeFlow: ActiveFlow;
  step: FlowStep;
  language: FlowLanguage;
  patientStatus: PatientStatus;
  activePatientRef?: PatientRef;
  patients: Record<PatientRef, PatientContext>;
  taskStack: TaskFrame[];
  currentTask?: TaskFrame;
  pendingActions: PendingAction[];
  availabilitySearches: AvailabilitySearch[];
  schedulingGoal?: SchedulingGoalState;
  visitType?: VisitType;
  officeKey: OfficeKey;
  coverageType?: InsuranceCoverageType;
  routing?: SchedulingRouting;
  requiredSlots: string[];
  completedSteps: string[];
  pendingConfirmation?: {
    type: ConfirmationType;
    payload: unknown;
  };
  lastGuardedToolCall?: {
    name: string;
    argsHash: string;
    guardAllowed: boolean;
  };
}

export type ToolOutcomeStatus =
  | "success"
  | "needs_clarification"
  | "not_found"
  | "not_allowed"
  | "route_required"
  | "transfer_required"
  | "error";

export interface ToolOutcome {
  outcome: ToolOutcomeStatus;
  nextStep: FlowStep;
  statePatch?: Partial<CallFlowState>;
  speak?: string;
  facts?: Record<string, unknown>;
  retryable?: boolean;
}

export type FlowDecision =
  | { type: "ask"; slot: string; promptHint: string }
  | { type: "call_tool"; tool: string; args: unknown }
  | { type: "call_meta_tool"; tool: string; args: unknown }
  | {
      type: "confirm";
      confirmation: NonNullable<CallFlowState["pendingConfirmation"]>;
    }
  | { type: "say"; instruction: string }
  | { type: "transfer"; reason: string }
  | { type: "end_call"; reason: string };
