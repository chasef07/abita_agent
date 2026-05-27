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

export type AppointmentLoadStatus = "found" | "none" | "error";

export type PreCallIdentityStatus =
  | "not_attempted"
  | "single_match_pending_confirmation"
  | "single_match_confirmed"
  | "multiple_matches_pending_selection"
  | "multiple_match_selected_pending_verification"
  | "multiple_match_confirmed"
  | "no_match"
  | "lookup_failed";

export type PreCallIdentityPromotion =
  | "none"
  | "first_name_confirmed"
  | "candidate_selected"
  | "verify_patient_required";

export interface PreCallPatientCandidate {
  ref: PatientRef;
  firstName?: string;
  lastName?: string;
  dob?: string;
  patientId?: string;
  relationshipToCaller?: PatientRelationshipToCaller;
  appointments: CallerAppointment[];
  appointmentsStatus?: AppointmentLoadStatus;
}

export interface PreCallContextState {
  status: PreCallIdentityStatus;
  source: "phone_lookup";
  callerPhone: string;
  lookupDurationMs?: number;
  failureReason?: string;
  retryable?: boolean;
  candidates: PreCallPatientCandidate[];
  selectedCandidateRef?: PatientRef;
  appointmentLoadStatus?: AppointmentLoadStatus;
  appointmentMessage?: string;
  identityPromotion?: PreCallIdentityPromotion;
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
  appointmentsStatus?: AppointmentLoadStatus;
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
  cancelConfirmed?: boolean;
  routeConfirmed?: boolean;
  transferConfirmed?: boolean;
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
  | "reschedule"
  | "route_office"
  | "transfer"
  | "end_call";

export type WorkflowToolName =
  | "verify_patient"
  | "add_patient"
  | "update_insurance"
  | "get_availability"
  | "cancel_appt"
  | "add_patient_note"
  | "book_appt"
  | "check_insurance"
  | "lookup_knowledge"
  | "route_to_spring_hill"
  | "transfer_call";

export interface PlannerFact {
  key: string;
  value: string;
}

export interface MissingFact {
  key: string;
  label: string;
}

export interface BlockedAction {
  action: WorkflowToolName | string;
  reason: string;
  until?: string;
}

export type WorkflowTaskKind =
  | "intent_triage"
  | "knowledge_answer"
  | "appointment_confirm"
  | "appointment_cancel"
  | "appointment_reschedule"
  | "scheduling"
  | "registration"
  | "insurance"
  | "transfer"
  | "end_call";

export type WorkflowCommandAction =
  | "ask"
  | "call_tool"
  | "confirm"
  | "respond"
  | "complete";

export type WorkflowCommandSource = "task_plan";

export interface WorkflowCommand {
  taskId: string;
  taskKind: ParentTaskPlan["kind"] | TaskFrame["kind"] | ActiveFlow;
  patientRef?: PatientRef;
  phase: string;
  objective: string;
  knownFacts: PlannerFact[];
  missingFacts: MissingFact[];
  nextAction: WorkflowCommandAction;
  slot?: string;
  tool?: WorkflowToolName;
  args?: unknown;
  suggestedTool?: WorkflowToolName;
  allowedTools: WorkflowToolName[];
  blockedActions: BlockedAction[];
  statePatch?: PlannerStatePatch;
  confirmationType?: ConfirmationType;
  resolvedMetaDecision?: {
    tool: "prepareSchedulingPath";
    outcome: ToolOutcome;
  };
  instruction: string;
  commandSource: WorkflowCommandSource;
}

export interface PlannerStatePatch {
  taskPlans?: Record<string, ParentTaskPlan>;
  activeTaskPlanId?: string;
  activeIntent?: IntentKind | null;
  activeFlow?: ActiveFlow;
  step?: FlowStep;
  patientStatus?: PatientStatus;
  visitType?: VisitType;
  officeKey?: OfficeKey;
  coverageType?: InsuranceCoverageType;
  routing?: SchedulingRouting;
  requiredSlots?: string[];
  completedSteps?: string[];
  pendingConfirmation?: CallFlowState["pendingConfirmation"];
  currentTask?: TaskFrame;
  taskStack?: TaskFrame[];
  schedulingGoal?: SchedulingGoalState;
}

export interface AppointmentLookupSubplan {
  phase:
    | "needs_verified_patient"
    | "loading_appointments"
    | "appointments_loaded"
    | "none_found"
    | "lookup_failed";
  loadedAppointmentCount: number;
  refreshedAtTurnId?: string;
}

export interface AppointmentConfirmPlan {
  id: string;
  kind: "appointment_confirm";
  taskFrameId?: string;
  patientRef?: PatientRef;
  phase:
    | "needs_lookup"
    | "presenting_appointments"
    | "confirmation_answered"
    | "complete";
  objective: string;
  lookup: AppointmentLookupSubplan;
  createdAt: number;
  updatedAt: number;
}

export interface AppointmentCancelPlan {
  id: string;
  kind: "appointment_cancel";
  taskFrameId?: string;
  patientRef?: PatientRef;
  phase:
    | "needs_lookup"
    | "selecting_appointment"
    | "confirming_cancel"
    | "cancelling"
    | "cancelled"
    | "complete";
  objective: string;
  lookup: AppointmentLookupSubplan;
  targetAppointmentId?: number;
  targetAppointmentSummary?: string;
  targetSelectionStatus: "none" | "ambiguous" | "selected";
  targetSelectionEvidence: string[];
  cancelConfirmed?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AppointmentReschedulePlan {
  id: string;
  kind: "appointment_reschedule";
  taskFrameId?: string;
  patientRef?: PatientRef;
  phase:
    | "requested"
    | "needs_verified_patient"
    | "loading_existing_appointments"
    | "selecting_old_appointment"
    | "collecting_replacement_window"
    | "searching_replacement"
    | "offering_replacement"
    | "confirming_reschedule"
    | "booking_replacement"
    | "cancelling_old_appointment"
    | "complete"
    | "partial_failure";
  objective: string;
  lookup: AppointmentLookupSubplan;
  targetAppointmentId?: number;
  targetAppointmentSummary?: string;
  targetSelectionStatus: "none" | "ambiguous" | "selected";
  targetSelectionEvidence: string[];
  replacementSlotId?: string;
  replacementSlotSummary?: string;
  appointmentReason?: string;
  referringDoctor?: string;
  rescheduleConfirmed?: boolean;
  replacementBookedAppointmentId?: number;
  oldCancelled?: boolean;
  rescheduleOperationId?: string;
  partialFailureReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GenericTaskPlan {
  id: string;
  kind: Exclude<
    WorkflowTaskKind,
    "appointment_confirm" | "appointment_cancel" | "appointment_reschedule"
  >;
  taskFrameId?: string;
  patientRef?: PatientRef;
  phase: string;
  objective: string;
  createdAt: number;
  updatedAt: number;
}

export type ParentTaskPlan =
  | AppointmentConfirmPlan
  | AppointmentCancelPlan
  | AppointmentReschedulePlan
  | GenericTaskPlan;

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
  preCall?: PreCallContextState;
  taskStack: TaskFrame[];
  currentTask?: TaskFrame;
  taskPlans?: Record<string, ParentTaskPlan>;
  activeTaskPlanId?: string;
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
  | "partial_failure"
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
