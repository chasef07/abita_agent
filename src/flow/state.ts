import { createHash } from "crypto";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { OfficeKey } from "../offices.js";
import type {
  CallFlowState,
  CallerAppointment,
  PatientContext,
  PatientRef,
  FlowLanguage,
  FlowStep,
  PatientStatus,
  SchedulingRouting,
  TrackedSlot,
  TrackedSlotSource,
} from "./types.js";

export interface CreateInitialFlowStateInput {
  officeKey: OfficeKey;
  language?: FlowLanguage;
  patientId?: string | null;
  patientName?: string | null;
  dob?: string | null;
  callerPhone?: string | null;
  appointments?: CallerAppointment[] | null;
  routing?: string | null;
  coverageType?: InsuranceCoverageType | null;
}

export const DEFAULT_PATIENT_REF = "caller";

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
  if (patientStatus === "verified" || patientStatus === "created")
    return "get_availability";
  if (patientStatus === "new") return "collect_registration";
  return "verify_patient";
}

export function createInitialFlowState({
  officeKey,
  language = "en",
  patientId,
  patientName,
  dob,
  callerPhone,
  appointments,
  routing,
  coverageType,
}: CreateInitialFlowStateInput): CallFlowState {
  const patientStatus: PatientStatus = patientId ? "matched" : "unknown";
  const normalizedCoverageType = coverageType ?? undefined;
  const activePatientRef = DEFAULT_PATIENT_REF;
  const patient = createPatientContext({
    ref: activePatientRef,
    status: patientStatus,
    patientId: patientId ?? undefined,
    patientName: patientName ?? undefined,
    dob: dob ?? undefined,
    phone: callerPhone ?? undefined,
    appointments: appointments ?? [],
    source: patientId ? "phone_lookup" : "agent_inferred",
  });

  return {
    activeIntent: null,
    activeFlow: "intro",
    step: "understand_intent",
    language,
    patientStatus,
    activePatientRef,
    patients: {
      [activePatientRef]: patient,
    },
    taskStack: [],
    pendingActions: [],
    availabilitySearches: [],
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

export function createPatientContext({
  ref,
  status = "unknown",
  patientId,
  patientName,
  dob,
  phone,
  appointments = [],
  source = "agent_inferred",
}: {
  ref: PatientRef;
  status?: PatientStatus;
  patientId?: string;
  patientName?: string;
  dob?: string;
  phone?: string;
  appointments?: CallerAppointment[];
  source?: TrackedSlotSource;
}): PatientContext {
  const nameSlots = patientName ? splitPatientName(patientName) : {};

  return {
    ref,
    status,
    relationshipToCaller: ref === DEFAULT_PATIENT_REF ? "self" : "unknown",
    firstName: nameSlots.firstName
      ? trackedSlot(nameSlots.firstName, source, "medium", Boolean(patientId))
      : undefined,
    lastName: nameSlots.lastName
      ? trackedSlot(nameSlots.lastName, source, "medium", Boolean(patientId))
      : undefined,
    dob: dob ? trackedSlot(dob, source, "high", Boolean(patientId)) : undefined,
    phone: phone
      ? trackedSlot(phone, source, "medium", Boolean(patientId))
      : undefined,
    patientId,
    verificationAttempts: 0,
    canonicalNameSource:
      source === "phone_lookup" ? "phone_lookup" : "caller_spoken",
    spellingConfirmed: false,
    appointments,
    activeAppointmentTaskIds: [],
  };
}

export function ensureActivePatientContext(
  flow: CallFlowState,
  ref: PatientRef = flow.activePatientRef ?? DEFAULT_PATIENT_REF,
): PatientContext {
  flow.activePatientRef = ref;
  flow.patients[ref] ??= createPatientContext({ ref });
  return flow.patients[ref];
}

export function recordPatientVerificationAttempt(
  flow: CallFlowState,
  args: {
    firstName?: string;
    lastName?: string;
    dob?: string;
    phone?: string;
    usePhone?: boolean;
    source?: TrackedSlotSource;
  },
): PatientContext {
  const patient = ensureActivePatientContext(flow);
  const source = args.source ?? "caller_spoken";

  if (args.firstName) {
    patient.firstName = trackedSlot(args.firstName, source, "medium", false);
    patient.canonicalNameSource =
      source === "caller_spelled" ? "caller_spelled" : "caller_spoken";
  }
  if (args.lastName) {
    patient.lastName = trackedSlot(args.lastName, source, "medium", false);
    patient.canonicalNameSource =
      source === "caller_spelled" ? "caller_spelled" : "caller_spoken";
  }
  if (args.dob) {
    patient.dob = trackedSlot(args.dob, source, "medium", false);
  }
  if (args.phone) {
    patient.phone = trackedSlot(args.phone, "phone_lookup", "medium", false);
  }

  patient.status = patient.status === "unknown" ? "candidate" : patient.status;
  patient.verificationAttempts += 1;
  patient.lastVerifiedArgsHash = hashStateArgs({
    firstName: args.firstName,
    lastName: args.lastName,
    dob: args.dob,
    phone: args.usePhone ? args.phone : undefined,
  });
  flow.patientStatus = patient.status;
  flow.step = "verify_patient";
  return patient;
}

export function recordVerifiedPatient(
  flow: CallFlowState,
  result: {
    patientId?: string | null;
    patientName?: string | null;
    dob?: string | null;
    phone?: string | null;
    appointments?: CallerAppointment[] | null;
    source?: TrackedSlotSource;
  },
): PatientContext {
  const patient = ensureActivePatientContext(flow);
  const source = result.source ?? "tool_result";
  const nameSlots = result.patientName
    ? splitPatientName(result.patientName)
    : {};

  if (result.patientId) patient.patientId = result.patientId;
  if (nameSlots.firstName) {
    patient.firstName = trackedSlot(nameSlots.firstName, source, "high", true);
  }
  if (nameSlots.lastName) {
    patient.lastName = trackedSlot(nameSlots.lastName, source, "high", true);
  }
  if (result.dob) {
    patient.dob = trackedSlot(result.dob, source, "high", true);
  }
  if (result.phone) {
    patient.phone = trackedSlot(result.phone, source, "medium", true);
  }
  if (result.appointments) {
    patient.appointments = result.appointments;
  }
  patient.status = result.patientId ? "verified" : patient.status;
  flow.patientStatus = patient.status;
  return patient;
}

function trackedSlot(
  value: string,
  source: TrackedSlotSource,
  confidence: TrackedSlot["confidence"],
  confirmed: boolean,
): TrackedSlot {
  return {
    value,
    source,
    confidence,
    confirmed,
  };
}

function splitPatientName(patientName: string): {
  firstName?: string;
  lastName?: string;
} {
  const parts = patientName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function hashStateArgs(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value ?? {}))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
    )
    .join(",")}}`;
}
