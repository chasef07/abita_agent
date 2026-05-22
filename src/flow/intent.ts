import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { CallFlowState, FlowStep, IntentKind } from "./types.js";
import { startPatientTask } from "./state.js";

export interface InferredCallerIntent {
  activeIntent: IntentKind;
  visitReason?: string;
  insurancePlan?: string;
  coverageType?: InsuranceCoverageType;
}

export interface IntentStateUpdate {
  inferred: InferredCallerIntent;
  previousIntent: IntentKind | null;
  changed: boolean;
}

const TRANSFER_PATTERNS = [
  /\bhuman\b/,
  /\brepresentative\b/,
  /\bperson\b/,
  /\bsomeone\b/,
  /\bfront desk\b/,
  /\bcall back\b/,
  /\btransfer\b/,
];

const CANCEL_APPOINTMENT_PATTERNS = [
  /\bcancel\b.*\b(appointment|appt|visit)\b/,
  /\b(appointment|appt|visit)\b.*\bcancel\b/,
  /\bcancelar\b.*\b(cita|turno)\b/,
];

const RESCHEDULE_APPOINTMENT_PATTERNS = [
  /\breschedule\b/,
  /\bmove\b.*\b(appointment|appt|visit)\b/,
  /\bchange\b.*\b(appointment|appt|visit)\b/,
  /\b(cambiar|mover|reprogramar)\b.*\b(cita|turno)\b/,
];

const CONFIRM_APPOINTMENT_PATTERNS = [
  /\bconfirm\b.*\b(appointment|appt|visit)\b/,
  /\b(appointment|appt|visit)\b.*\b(confirm|time|when)\b/,
  /\bwhat time\b.*\b(appointment|appt|visit)\b/,
  /\bwhen\b.*\b(my|the)\b.*\b(appointment|appt|visit)\b/,
  /\bdo i have\b.*\b(appointment|appt|visit)\b/,
  /\bam i scheduled\b/,
  /\bcheck\b.*\b(my|the)\b.*\b(appointment|appt|visit)\b/,
  /\blook up\b.*\b(my|the)\b.*\b(appointment|appt|visit)\b/,
  /\bupcoming\b.*\b(appointment|appt|visit)\b/,
  /\btengo\b.*\b(cita|turno)\b/,
];

const NEW_PATIENT_PATTERNS = [
  /\bnew patient\b/,
  /\bfirst time\b/,
  /\bnever been\b/,
  /\bregister\b/,
  /\bregistration\b/,
  /\bset (me|them|him|her) up\b/,
  /\bnuevo paciente\b/,
  /\bprimera vez\b/,
];

const SCHEDULING_PATTERNS = [
  /\bschedule\b/,
  /\bappointment\b/,
  /\bbook\b/,
  /\bseen\b/,
  /\bexam\b/,
  /\bfollow[ -]?up\b/,
  /\bcita\b/,
];

const INSURANCE_PATTERNS = [
  /\binsurance\b/,
  /\bcoverage\b/,
  /\bplan\b/,
  /\bdo you take\b/,
  /\baccept\b/,
  /\bseguro\b/,
  /\baceptan\b/,
];

const QUICK_QUESTION_PATTERNS = [
  /\bhours\b/,
  /\baddress\b/,
  /\blocation\b/,
  /\bfax\b/,
  /\bphone\b/,
  /\bopen\b/,
  /\bdireccion\b/,
  /\bhorario\b/,
];

const ROUTINE_PATTERNS = [
  /\broutine\b/,
  /\bannual\b/,
  /\beye exam\b/,
  /\bvision\b/,
  /\bglasses\b/,
  /\bcontacts?\b/,
  /\bexamen de la vista\b/,
  /\blentes\b/,
  /\bcontactos\b/,
];

const MEDICAL_PATTERNS = [
  /\bglaucoma\b/,
  /\bcataract\b/,
  /\bretina\b/,
  /\bpost[ -]?op\b/,
  /\breferral\b/,
  /\bflashes\b/,
  /\bfloaters\b/,
  /\beye pain\b/,
  /\bcatarata\b/,
  /\bdolor\b.*\bojo\b/,
];

const COMMON_PLAN_PATTERNS = [
  /\bvsp\b/i,
  /\beyemed\b/i,
  /\bhumana\b/i,
  /\baetna\b/i,
  /\bcigna\b/i,
  /\bcare ?plus\b/i,
  /\bflorida blue\b/i,
  /\bblue cross\b/i,
  /\bunited\b/i,
  /\bmedicare\b/i,
  /\bmedicaid\b/i,
  /\bambetter\b/i,
  /\boscar\b/i,
  /\btricare\b/i,
];

export function inferCallerIntentFromTranscript(
  transcript: string,
): InferredCallerIntent {
  const text = transcript.trim();
  const normalized = text.toLowerCase();
  const activeIntent = inferIntentKind(normalized);
  const coverageType = inferCoverageType(normalized);
  const visitReason = inferVisitReason(text, normalized);
  const insurancePlan = inferInsurancePlan(text);

  return {
    activeIntent,
    ...(visitReason ? { visitReason } : {}),
    ...(insurancePlan ? { insurancePlan } : {}),
    ...(coverageType ? { coverageType } : {}),
  };
}

export function applyIntentStateFromTranscript(
  flow: CallFlowState,
  transcript: string,
): IntentStateUpdate {
  return applyInferredIntentState(
    flow,
    inferCallerIntentFromTranscript(transcript),
  );
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

function inferIntentKind(normalized: string): IntentKind {
  if (TRANSFER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "transfer_request";
  }
  if (CANCEL_APPOINTMENT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "existing_appointment_cancel";
  }
  if (
    RESCHEDULE_APPOINTMENT_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return "existing_appointment_reschedule";
  }
  if (
    CONFIRM_APPOINTMENT_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return "existing_appointment_confirm";
  }
  if (NEW_PATIENT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "new_patient_registration";
  }
  if (INSURANCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "insurance_question";
  }
  if (QUICK_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "faq";
  }
  if (SCHEDULING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "new_appointment";
  }
  return "unclear";
}

function inferCoverageType(
  normalized: string,
): InsuranceCoverageType | undefined {
  if (ROUTINE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "routine_vision";
  }
  if (MEDICAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "medical";
  }
  return undefined;
}

function inferVisitReason(
  transcript: string,
  normalized: string,
): string | undefined {
  if (
    ROUTINE_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    MEDICAL_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return transcript;
  }
  return undefined;
}

function inferInsurancePlan(transcript: string): string | undefined {
  for (const pattern of COMMON_PLAN_PATTERNS) {
    const match = transcript.match(pattern);
    if (match?.[0]) return match[0];
  }
  return undefined;
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
      flow.patientStatus =
        flow.patientStatus === "unknown" ? "new" : flow.patientStatus;
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
