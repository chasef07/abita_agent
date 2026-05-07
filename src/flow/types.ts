import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { OfficeKey } from "../offices.js";

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

export type PatientStatus = "unknown" | "matched" | "verified" | "new";

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

export type ConfirmationType =
  | "book"
  | "cancel"
  | "route_office"
  | "transfer"
  | "end_call";

export interface CallFlowState {
  activeFlow: ActiveFlow;
  step: FlowStep;
  language: FlowLanguage;
  patientStatus: PatientStatus;
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
  lastToolCall?: {
    name: string;
    argsHash: string;
    outcome: ToolOutcomeStatus;
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
