import { createHash } from "crypto";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { OfficeKey } from "../customer/profile.js";
import type {
  CallFlowState,
  CallerAppointment,
  InsuranceContext,
  PatientContext,
  PatientRef,
  PatientRelationshipToCaller,
  FlowLanguage,
  FlowStep,
  PatientStatus,
  SchedulingRouting,
  TaskFrame,
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
    appointments: upcomingAppointments(appointments ?? []),
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
    appointments: upcomingAppointments(appointments),
    activeAppointmentTaskIds: [],
  };
}

export function confirmPreloadedPatientIdentityFromTranscript(
  flow: CallFlowState,
  transcript: string,
): PatientContext | undefined {
  const patient = flow.patients[flow.activePatientRef ?? DEFAULT_PATIENT_REF];
  if (
    flow.patientStatus !== "matched" ||
    patient?.status !== "matched" ||
    !patient.patientId ||
    !patient.firstName?.value
  ) {
    return undefined;
  }

  const transcriptWords = wordsForMatch(transcript);
  const firstName = normalizeIdentityValue(patient.firstName.value);
  if (!firstName || !transcriptWords.has(firstName)) return undefined;

  patient.status = "verified";
  patient.firstName = { ...patient.firstName, confirmed: true };
  if (patient.lastName) {
    patient.lastName = { ...patient.lastName, confirmed: true };
  }
  if (patient.dob) {
    patient.dob = { ...patient.dob, confirmed: true };
  }
  flow.patientStatus = "verified";
  if (flow.step === "verify_patient") {
    flow.step = stepAfterPreloadedPatientConfirmation(flow);
    if (flow.currentTask) {
      flow.currentTask.step = flow.step;
    }
  }
  return patient;
}

export interface PatientIdentitySnapshot {
  patientRef?: PatientRef;
  patientId?: string;
  firstName?: string;
  lastName?: string;
  dob?: string;
  phone?: string;
  relationshipToCaller?: PatientRelationshipToCaller;
  status?: PatientStatus;
}

export interface PatientStateChangeResult {
  patient: PatientContext;
  previousPatientRef?: PatientRef;
  activePatientRef: PatientRef;
  switchedPatient: boolean;
  identityChanged: boolean;
}

export function ensureActivePatientContext(
  flow: CallFlowState,
  ref: PatientRef = flow.activePatientRef ?? DEFAULT_PATIENT_REF,
): PatientContext {
  flow.activePatientRef = ref;
  flow.patients[ref] ??= createPatientContext({ ref });
  return flow.patients[ref];
}

export function switchActivePatient(
  flow: CallFlowState,
  ref: PatientRef,
): PatientStateChangeResult {
  const previousPatientRef = flow.activePatientRef;
  const previous = previousPatientRef
    ? flow.patients[previousPatientRef]
    : undefined;
  const before = previous ? snapshotPatientIdentity(previous) : undefined;
  const patient = ensureActivePatientContext(flow, ref);
  flow.patientStatus = patient.status;
  flow.step = nextPatientFlowStep(patient.status);
  const after = snapshotPatientIdentity(patient);

  return {
    patient,
    previousPatientRef,
    activePatientRef: ref,
    switchedPatient: previousPatientRef !== ref,
    identityChanged: !before || !sameIdentitySnapshot(before, after),
  };
}

export function startPatientTask(
  flow: CallFlowState,
  input: {
    kind: TaskFrame["kind"];
    step?: FlowStep;
    patientRef?: PatientRef;
    returnTo?: string;
    createdAt?: number;
  },
): TaskFrame {
  const patientRef = input.patientRef ?? flow.activePatientRef;
  const step = input.step ?? flow.step;
  const existingTask =
    findSuspendedTask(flow, input.kind, patientRef) ??
    (flow.currentTask?.kind === input.kind &&
    flow.currentTask.patientRef === patientRef
      ? flow.currentTask
      : undefined);

  if (
    flow.currentTask &&
    flow.currentTask.id !== existingTask?.id &&
    !flow.taskStack.some((task) => task.id === flow.currentTask?.id)
  ) {
    flow.taskStack.push({ ...flow.currentTask });
  }

  const task =
    existingTask ??
    ({
      id: nextTaskId(flow, input.kind, patientRef),
      kind: input.kind,
      patientRef,
      step,
      returnTo: input.returnTo ?? flow.currentTask?.id,
      createdAt: input.createdAt ?? Date.now(),
    } satisfies TaskFrame);

  task.step = step;
  task.returnTo = input.returnTo ?? task.returnTo;
  flow.taskStack = flow.taskStack.filter(
    (candidate) => candidate.id !== task.id,
  );
  flow.currentTask = task;
  if (patientRef) {
    ensureActivePatientContext(flow, patientRef);
    attachTaskToPatient(flow.patients[patientRef], task);
  }
  flow.activeFlow = activeFlowForTaskKind(task.kind);
  flow.step = task.step;
  return task;
}

export function resumePatientTask(
  flow: CallFlowState,
  input: {
    patientRef?: PatientRef;
    kind?: TaskFrame["kind"];
  } = {},
): TaskFrame | undefined {
  const task = [...flow.taskStack].reverse().find((candidate) => {
    if (input.patientRef && candidate.patientRef !== input.patientRef) {
      return false;
    }
    if (input.kind && candidate.kind !== input.kind) return false;
    return true;
  });
  if (!task) return undefined;

  flow.taskStack = flow.taskStack.filter(
    (candidate) => candidate.id !== task.id,
  );
  if (
    flow.currentTask &&
    flow.currentTask.id !== task.id &&
    !flow.taskStack.some((candidate) => candidate.id === flow.currentTask?.id)
  ) {
    flow.taskStack.push({ ...flow.currentTask });
  }
  flow.currentTask = task;
  if (task.patientRef) {
    ensureActivePatientContext(flow, task.patientRef);
  }
  flow.activeFlow = activeFlowForTaskKind(task.kind);
  flow.step = task.step;
  return task;
}

export function completeCurrentTaskAndResume(
  flow: CallFlowState,
): TaskFrame | undefined {
  const completedTask = flow.currentTask;
  if (!completedTask) return undefined;
  flow.currentTask = undefined;

  const returnTask = completedTask.returnTo
    ? flow.taskStack.find((task) => task.id === completedTask.returnTo)
    : undefined;
  if (returnTask) {
    flow.taskStack = flow.taskStack.filter((task) => task.id !== returnTask.id);
    flow.currentTask = returnTask;
    if (returnTask.patientRef) {
      ensureActivePatientContext(flow, returnTask.patientRef);
    }
    flow.activeFlow = activeFlowForTaskKind(returnTask.kind);
    flow.step = returnTask.step;
    return returnTask;
  }

  return resumePatientTask(flow);
}

export function snapshotActivePatientIdentity(
  flow: CallFlowState,
): PatientIdentitySnapshot {
  const ref = flow.activePatientRef ?? DEFAULT_PATIENT_REF;
  const patient = flow.patients[ref];
  return patient
    ? snapshotPatientIdentity(patient)
    : { patientRef: ref, status: flow.patientStatus };
}

export function hasActivePatientIdentityChanged(
  flow: CallFlowState,
  before: PatientIdentitySnapshot,
): boolean {
  return !sameIdentitySnapshot(before, snapshotActivePatientIdentity(flow));
}

export function recordCallerSpelledPatientName(
  flow: CallFlowState,
  args: {
    firstName?: string;
    lastName?: string;
  },
): { patient: PatientContext; identityChanged: boolean } {
  const before = snapshotActivePatientIdentity(flow);
  const patient = ensureActivePatientContext(flow);

  if (args.firstName) {
    patient.firstName = trackedSlot(
      args.firstName,
      "caller_spelled",
      "high",
      true,
    );
  }
  if (args.lastName) {
    patient.lastName = trackedSlot(
      args.lastName,
      "caller_spelled",
      "high",
      true,
    );
  }
  if (args.firstName || args.lastName) {
    patient.canonicalNameSource = "caller_spelled";
    patient.spellingConfirmed = true;
    patient.status =
      patient.status === "unknown" ? "candidate" : patient.status;
    flow.patientStatus = patient.status;
  }

  return {
    patient,
    identityChanged: hasActivePatientIdentityChanged(flow, before),
  };
}

export function setActivePatientRelationship(
  flow: CallFlowState,
  relationshipToCaller: PatientRelationshipToCaller,
): { patient: PatientContext; relationshipChanged: boolean } {
  const patient = ensureActivePatientContext(flow);
  const previousRelationship = patient.relationshipToCaller;
  patient.relationshipToCaller = relationshipToCaller;
  return {
    patient,
    relationshipChanged:
      Boolean(previousRelationship) &&
      previousRelationship !== "unknown" &&
      previousRelationship !== relationshipToCaller,
  };
}

export function recordPatientVerificationAttempt(
  flow: CallFlowState,
  args: {
    firstName?: string;
    lastName?: string;
    dob?: string;
    phone?: string;
    usePhone?: boolean;
    relationshipToCaller?: PatientRelationshipToCaller;
    source?: TrackedSlotSource;
  },
): PatientContext {
  const source = args.source ?? "caller_spoken";
  const isSpelled = source === "caller_spelled";
  const patient = ensureActivePatientContext(
    flow,
    resolveVerificationAttemptPatientRef(flow, args),
  );

  if (args.firstName) {
    patient.firstName = trackedSlot(
      args.firstName,
      source,
      isSpelled ? "high" : "medium",
      isSpelled,
    );
    patient.canonicalNameSource = isSpelled
      ? "caller_spelled"
      : "caller_spoken";
  }
  if (args.lastName) {
    patient.lastName = trackedSlot(
      args.lastName,
      source,
      isSpelled ? "high" : "medium",
      isSpelled,
    );
    patient.canonicalNameSource = isSpelled
      ? "caller_spelled"
      : "caller_spoken";
  }
  if (args.dob) {
    patient.dob = trackedSlot(args.dob, source, "medium", false);
  }
  if (args.phone) {
    patient.phone = trackedSlot(args.phone, "phone_lookup", "medium", false);
  }
  if (args.relationshipToCaller) {
    patient.relationshipToCaller = args.relationshipToCaller;
  }
  if (isSpelled && (args.firstName || args.lastName)) {
    patient.spellingConfirmed = true;
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
): PatientStateChangeResult {
  const previousPatientRef = flow.activePatientRef ?? DEFAULT_PATIENT_REF;
  const targetPatientRef = resolveVerifiedPatientRef(
    flow,
    result.patientId ?? undefined,
  );
  const patient = ensureActivePatientContext(flow, targetPatientRef);
  const before = snapshotPatientIdentity(patient);
  const source = result.source ?? "tool_result";
  const nameSlots = result.patientName
    ? splitPatientName(result.patientName)
    : {};

  if (result.patientId) patient.patientId = result.patientId;
  if (nameSlots.firstName) {
    patient.firstName = mergeVerifiedNameSlot(
      patient.firstName,
      nameSlots.firstName,
      source,
    );
  }
  if (nameSlots.lastName) {
    patient.lastName = mergeVerifiedNameSlot(
      patient.lastName,
      nameSlots.lastName,
      source,
    );
  }
  if (result.dob) {
    patient.dob = trackedSlot(result.dob, source, "high", true);
  }
  if (result.phone) {
    patient.phone = trackedSlot(result.phone, source, "medium", true);
  }
  if (result.appointments) {
    patient.appointments = upcomingAppointments(result.appointments);
  }
  patient.status = result.patientId ? "verified" : patient.status;
  flow.patientStatus = patient.status;
  flow.step = nextPatientFlowStep(patient.status);

  const after = snapshotPatientIdentity(patient);
  return {
    patient,
    previousPatientRef,
    activePatientRef: targetPatientRef,
    switchedPatient: previousPatientRef !== targetPatientRef,
    identityChanged: !sameIdentitySnapshot(before, after),
  };
}

export function updateActivePatientInsurance(
  flow: CallFlowState,
  insurance: {
    plan?: string | null;
    coverageType?: InsuranceContext["coverageType"] | null;
    canonicalPlan?: string | null;
    source?: TrackedSlotSource;
  },
): PatientContext {
  const patient = ensureActivePatientContext(flow);
  const source = insurance.source ?? "tool_result";
  patient.insurance = {
    ...(patient.insurance ?? {}),
    ...(insurance.plan
      ? { plan: trackedSlot(insurance.plan, source, "medium", true) }
      : {}),
    ...(insurance.coverageType ? { coverageType: insurance.coverageType } : {}),
    ...(insurance.canonicalPlan
      ? { canonicalPlan: insurance.canonicalPlan }
      : {}),
  };
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

function mergeVerifiedNameSlot(
  existing: TrackedSlot | undefined,
  value: string,
  source: TrackedSlotSource,
): TrackedSlot {
  if (
    existing?.source === "caller_spelled" &&
    normalizeIdentityValue(existing.value) === normalizeIdentityValue(value)
  ) {
    return {
      ...existing,
      confidence: "high",
      confirmed: true,
    };
  }
  return trackedSlot(value, source, "high", true);
}

function resolveVerifiedPatientRef(
  flow: CallFlowState,
  patientId: string | undefined,
): PatientRef {
  const activeRef = flow.activePatientRef ?? DEFAULT_PATIENT_REF;
  const activePatient = flow.patients[activeRef];
  if (!patientId) return activeRef;
  if (activePatient?.patientId === patientId) return activeRef;

  const existingRef = findPatientRefByPatientId(flow, patientId);
  if (existingRef) return existingRef;

  if (!activePatient?.patientId) return activeRef;
  return `patient:${patientId}`;
}

function resolveVerificationAttemptPatientRef(
  flow: CallFlowState,
  args: {
    firstName?: string;
    lastName?: string;
    dob?: string;
    phone?: string;
    usePhone?: boolean;
    relationshipToCaller?: PatientRelationshipToCaller;
  },
): PatientRef {
  const activeRef = flow.activePatientRef ?? DEFAULT_PATIENT_REF;
  const activePatient = flow.patients[activeRef];
  if (!activePatient?.patientId) return activeRef;
  if (!verificationAttemptConflictsWithPatient(activePatient, args)) {
    return activeRef;
  }

  const ref = `candidate:${hashStateArgs({
    firstName: normalizeIdentityValue(args.firstName),
    lastName: normalizeIdentityValue(args.lastName),
    dob: normalizeIdentityValue(args.dob),
    phone: args.usePhone ? normalizeIdentityValue(args.phone) : undefined,
  }).slice(0, 12)}`;
  flow.patients[ref] ??= createPatientContext({ ref, status: "candidate" });
  return ref;
}

function verificationAttemptConflictsWithPatient(
  patient: PatientContext,
  args: {
    firstName?: string;
    lastName?: string;
    dob?: string;
    relationshipToCaller?: PatientRelationshipToCaller;
  },
): boolean {
  return (
    conflicts(patient.firstName?.value, args.firstName) ||
    conflicts(patient.lastName?.value, args.lastName) ||
    conflicts(patient.dob?.value, args.dob) ||
    relationshipConflicts(
      patient.relationshipToCaller,
      args.relationshipToCaller,
    )
  );
}

function conflicts(
  existing: string | undefined,
  next: string | undefined,
): boolean {
  if (!existing || !next) return false;
  return normalizeIdentityValue(existing) !== normalizeIdentityValue(next);
}

function relationshipConflicts(
  existing: PatientRelationshipToCaller | undefined,
  next: PatientRelationshipToCaller | undefined,
): boolean {
  if (!existing || existing === "unknown" || !next || next === "unknown") {
    return false;
  }
  return existing !== next;
}

function findPatientRefByPatientId(
  flow: CallFlowState,
  patientId: string,
): PatientRef | undefined {
  return Object.entries(flow.patients).find(
    ([, patient]) => patient.patientId === patientId,
  )?.[0];
}

function snapshotPatientIdentity(
  patient: PatientContext,
): PatientIdentitySnapshot {
  return {
    patientRef: patient.ref,
    patientId: patient.patientId,
    firstName: normalizeIdentityValue(patient.firstName?.value),
    lastName: normalizeIdentityValue(patient.lastName?.value),
    dob: normalizeIdentityValue(patient.dob?.value),
    phone: normalizeIdentityValue(patient.phone?.value),
    relationshipToCaller: patient.relationshipToCaller,
    status: patient.status,
  };
}

function sameIdentitySnapshot(
  left: PatientIdentitySnapshot,
  right: PatientIdentitySnapshot,
): boolean {
  return (
    left.patientRef === right.patientRef &&
    !conflicts(left.patientId, right.patientId) &&
    !conflicts(left.firstName, right.firstName) &&
    !conflicts(left.lastName, right.lastName) &&
    !conflicts(left.dob, right.dob) &&
    !conflicts(left.phone, right.phone) &&
    !relationshipConflicts(
      left.relationshipToCaller,
      right.relationshipToCaller,
    )
  );
}

function findSuspendedTask(
  flow: CallFlowState,
  kind: TaskFrame["kind"],
  patientRef: PatientRef | undefined,
): TaskFrame | undefined {
  return [...flow.taskStack]
    .reverse()
    .find((task) => task.kind === kind && task.patientRef === patientRef);
}

function nextTaskId(
  flow: CallFlowState,
  kind: TaskFrame["kind"],
  patientRef: PatientRef | undefined,
): string {
  const patientPart = patientRef?.replace(/[^a-zA-Z0-9_-]/g, "_") ?? "call";
  const sequence =
    flow.taskStack.length +
    (flow.currentTask ? 1 : 0) +
    Object.values(flow.patients).reduce(
      (count, patient) =>
        count +
        (patient.activeSchedulingTaskId ? 1 : 0) +
        patient.activeAppointmentTaskIds.length,
      0,
    ) +
    1;
  return `task_${kind}_${patientPart}_${sequence}`;
}

function attachTaskToPatient(patient: PatientContext, task: TaskFrame): void {
  if (task.kind === "schedule") {
    patient.activeSchedulingTaskId = task.id;
  }
  if (
    task.kind === "appointment_management" &&
    !patient.activeAppointmentTaskIds.includes(task.id)
  ) {
    patient.activeAppointmentTaskIds.push(task.id);
  }
}

function activeFlowForTaskKind(
  kind: TaskFrame["kind"],
): CallFlowState["activeFlow"] {
  switch (kind) {
    case "schedule":
      return "scheduling";
    case "appointment_management":
      return "appointment_management";
    case "insurance":
      return "insurance";
    case "faq":
      return "quick_question";
    case "transfer":
      return "transfer";
  }
}

function normalizeIdentityValue(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || undefined;
}

function splitPatientName(patientName: string): {
  firstName?: string;
  lastName?: string;
} {
  const [lastName, firstAndMiddle] = patientName
    .split(",", 2)
    .map((part) => part.trim())
    .filter(Boolean);
  if (lastName && firstAndMiddle) {
    return {
      firstName: firstAndMiddle.split(/\s+/).filter(Boolean)[0],
      lastName,
    };
  }

  const parts = patientName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function stepAfterPreloadedPatientConfirmation(flow: CallFlowState): FlowStep {
  if (flow.activeFlow === "appointment_management") {
    if (flow.activeIntent === "existing_appointment_cancel") {
      return "confirm_cancel";
    }
    return "answer";
  }
  if (flow.activeFlow === "scheduling") {
    return "get_availability";
  }
  return nextPatientFlowStep("verified");
}

function wordsForMatch(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean),
  );
}

function upcomingAppointments(
  appointments: CallerAppointment[],
  now = new Date(),
): CallerAppointment[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return appointments.filter((appointment) => {
    const date = new Date(appointment.date);
    if (Number.isNaN(date.getTime())) return false;
    date.setHours(0, 0, 0, 0);
    return date >= today;
  });
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
