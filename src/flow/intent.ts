import type { InsuranceCoverageType } from "../insurance-rules.js";
import type {
  CallFlowState,
  FlowStep,
  IntentKind,
  VisitType,
} from "./types.js";
import { ensureActivePatientContext, startPatientTask } from "./state.js";

export interface InferredCallerIntent {
  activeIntent: IntentKind;
  visitReason?: string;
  visitType?: VisitType;
  insurancePlan?: string;
  coverageType?: InsuranceCoverageType;
}

export interface IntentStateUpdate {
  inferred: InferredCallerIntent;
  previousIntent: IntentKind | null;
  changed: boolean;
}

export function applyInferredIntentState(
  flow: CallFlowState,
  inferred: InferredCallerIntent,
): IntentStateUpdate {
  const previousIntent = flow.activeIntent;

  if (inferred.activeIntent === "unclear" && previousIntent) {
    return { inferred, previousIntent, changed: false };
  }

  flow.activeIntent = inferred.activeIntent;
  if (shouldMoveFlowToIntent(flow, previousIntent, inferred.activeIntent)) {
    applyIntentStartingPoint(flow, inferred);
  }

  return {
    inferred,
    previousIntent,
    changed: previousIntent !== flow.activeIntent,
  };
}

function shouldMoveFlowToIntent(
  flow: CallFlowState,
  previousIntent: IntentKind | null,
  nextIntent: IntentKind,
): boolean {
  return (
    !previousIntent ||
    previousIntent !== nextIntent ||
    flow.activeFlow === "intro" ||
    flow.step === "understand_intent"
  );
}

function applyIntentStartingPoint(
  flow: CallFlowState,
  inferred: InferredCallerIntent,
): void {
  const hasVisitContext = Boolean(inferred.visitReason ?? flow.visitType);
  const hasCoverageContext = Boolean(
    inferred.coverageType ?? flow.coverageType ?? flow.visitType,
  );

  switch (inferred.activeIntent) {
    case "new_appointment":
      flow.activeFlow = "scheduling";
      flow.step = hasVisitContext
        ? patientStepForScheduling(flow)
        : "triage_visit_type";
      flow.requiredSlots =
        flow.step === "triage_visit_type" ? ["visitReason"] : [];
      startPatientTask(flow, { kind: "schedule", step: flow.step });
      return;
    case "new_patient_registration":
      flow.activeFlow = "new_patient";
      if (flow.patientStatus === "unknown") {
        flow.patientStatus = "new";
        const patient = ensureActivePatientContext(flow);
        if (patient.status === "unknown") patient.status = "new";
      }
      flow.step = hasVisitContext
        ? "collect_registration"
        : "triage_visit_type";
      flow.requiredSlots =
        flow.step === "triage_visit_type" ? ["visitReason"] : [];
      startPatientTask(flow, { kind: "schedule", step: flow.step });
      return;
    case "existing_appointment_confirm":
    case "existing_appointment_reschedule":
      flow.activeFlow = "appointment_management";
      flow.step = needsPatientVerification(flow) ? "verify_patient" : "answer";
      flow.requiredSlots = needsPatientVerification(flow)
        ? ["patientIdentity"]
        : [];
      startPatientTask(flow, {
        kind: "appointment_management",
        step: flow.step,
      });
      return;
    case "existing_appointment_cancel":
      flow.activeFlow = "appointment_management";
      flow.step = needsPatientVerification(flow)
        ? "verify_patient"
        : "confirm_cancel";
      flow.requiredSlots = needsPatientVerification(flow)
        ? ["patientIdentity"]
        : [];
      startPatientTask(flow, {
        kind: "appointment_management",
        step: flow.step,
      });
      return;
    case "insurance_question":
      flow.activeFlow = "insurance";
      flow.step = hasCoverageContext ? "check_insurance" : "triage_visit_type";
      flow.requiredSlots =
        flow.step === "triage_visit_type" ? ["visitReason"] : ["insurancePlan"];
      startPatientTask(flow, { kind: "insurance", step: flow.step });
      return;
    case "faq":
      flow.activeFlow = "quick_question";
      flow.step = "answer";
      flow.requiredSlots = [];
      startPatientTask(flow, {
        kind: "faq",
        step: flow.step,
        returnTo: flow.currentTask?.id,
      });
      return;
    case "transfer_request":
      flow.activeFlow = "transfer";
      flow.step = "handoff";
      flow.requiredSlots = [];
      startPatientTask(flow, {
        kind: "transfer",
        step: flow.step,
        returnTo: flow.currentTask?.id,
      });
      return;
    case "unclear":
      flow.activeFlow = "intent";
      flow.step = "understand_intent";
      flow.requiredSlots = ["intent"];
      return;
  }
}

function patientStepForScheduling(flow: CallFlowState): FlowStep {
  if (flow.patientStatus === "verified" || flow.patientStatus === "created") {
    return "get_availability";
  }
  if (flow.patientStatus === "new") return "collect_registration";
  return "verify_patient";
}

function needsPatientVerification(flow: CallFlowState): boolean {
  return flow.patientStatus !== "verified" && flow.patientStatus !== "created";
}
