import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { OfficeKey } from "../offices.js";
import type {
  CallFlowState,
  FlowLanguage,
  FlowStep,
  PatientStatus,
  SchedulingRouting,
} from "./types.js";

export interface CreateInitialFlowStateInput {
  officeKey: OfficeKey;
  language?: FlowLanguage;
  patientId?: string | null;
  routing?: string | null;
  coverageType?: InsuranceCoverageType | null;
}

const ROUTINGS = new Set<string>([
  "bach_only",
  "bach_licht",
  "all_three",
  "optical_only",
]);

export function normalizeSchedulingRouting(
  routing?: string | null,
): SchedulingRouting | undefined {
  return routing && ROUTINGS.has(routing)
    ? (routing as SchedulingRouting)
    : undefined;
}

export function nextPatientFlowStep(patientStatus: PatientStatus): FlowStep {
  if (patientStatus === "verified") return "get_availability";
  if (patientStatus === "new") return "collect_registration";
  return "verify_patient";
}

export function createInitialFlowState({
  officeKey,
  language = "en",
  patientId,
  routing,
  coverageType,
}: CreateInitialFlowStateInput): CallFlowState {
  const patientStatus: PatientStatus = patientId ? "matched" : "unknown";
  const normalizedCoverageType = coverageType ?? undefined;

  return {
    activeFlow: "intro",
    step: "understand_intent",
    language,
    patientStatus,
    officeKey,
    coverageType: normalizedCoverageType,
    routing: normalizeSchedulingRouting(routing),
    visitType:
      normalizedCoverageType === "routine_vision"
        ? "routine_vision"
        : undefined,
    requiredSlots: [],
    completedSteps: [],
  };
}

export function applyFlowStatePatch(
  flow: CallFlowState,
  patch: Partial<CallFlowState> | undefined,
): CallFlowState {
  if (!patch) return flow;
  Object.assign(flow, patch);
  return flow;
}
