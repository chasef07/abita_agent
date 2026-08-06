import type {
  AppointmentActionAnalytics,
  PatientIdentityOutcome,
} from "./state/call-state.js";

type TimestampInput = number | string | Date | undefined;

type FunctionCallLike = {
  callId?: string;
  createdAt?: number;
  id?: string;
  name?: string;
};

type FunctionCallOutputLike = {
  callId?: string;
  createdAt?: number;
  isError?: boolean;
  name?: string;
  output?: string;
};

type FunctionToolsExecutedLike = {
  createdAt?: number;
  functionCalls?: FunctionCallLike[];
  functionCallOutputs?: FunctionCallOutputLike[];
};

const TOOL_EXECUTION_STATUS_BY_OUTPUT_CLASS = {
  appointment_booked: "success",
  appointment_booking_failed: "error",
  appointment_cancelled: "success",
  appointment_cancellation_failed: "error",
  appointment_needs_input: "success",
  appointment_not_booked: "error",
  appointment_not_cancelled: "error",
  appointment_not_rescheduled: "error",
  appointment_reschedule_partial: "error",
  appointment_reschedule_failed: "error",
  appointment_rescheduled: "success",
  availability_failed: "error",
  availability_needs_input: "success",
  availability_returned: "success",
  duplicate_tool_call: "success",
  duplicate_tool_rejected: "error",
  insurance_checked: "success",
  insurance_update_failed: "error",
  insurance_update_needs_input: "success",
  insurance_updated: "success",
  internal_tool_error: "error",
  invalid_tool_arguments: "error",
  middleware_error: "error",
  multiple_patient_matches: "success",
  patient_created: "success",
  patient_creation_failed: "error",
  patient_creation_needs_input: "success",
  patient_lookup_failed: "error",
  patient_lookup_returned: "success",
  patient_new: "success",
  patient_not_found: "success",
  patient_switched: "success",
  patient_verified: "success",
  staff_task_created: "success",
  staff_task_duplicate: "success",
  staff_task_failed: "error",
  transfer_ambiguous: "success",
  transfer_failed: "error",
  transfer_started: "success",
  unknown: "success",
  unknown_tool: "error",
} as const;

export type ToolOutputClass =
  keyof typeof TOOL_EXECUTION_STATUS_BY_OUTPUT_CLASS;

export type ToolExecutionAnalytics = {
  callId: string;
  createdAt: string;
  outputClass: ToolOutputClass;
  status: "success" | "error";
  toolName: string;
};

export type SttProfileTransitionAnalytics = {
  assistantText?: string;
  callerText?: string;
  createdAt: string;
  from: string | null;
  reason: string;
  to: string;
};

export type SessionEventAnalytics = {
  close?: {
    createdAt: string;
    reason?: string;
  };
  errors: Array<{
    code?: string;
    createdAt: string;
    messageClass: string;
    name?: string;
    source?: string;
  }>;
  falseInterruptions: Array<{
    createdAt: string;
    resumed: boolean;
  }>;
  overlappingSpeech: Array<{
    createdAt: string;
    durationMs?: number;
    isInterruption?: boolean;
  }>;
};

export type LlmSummary = {
  avgTtftMs?: number;
  cacheHitRate: number;
  cachedPromptTokens: number;
  completionTokens: number;
  fallbackUsed: boolean;
  modelsUsed: string[];
  peakPromptTokens?: number;
  promptTokens: number;
};

export function timestampToIso(value: TimestampInput): string {
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }

  return new Date().toISOString();
}

export function createEmptySessionEventAnalytics(): SessionEventAnalytics {
  return {
    errors: [],
    falseInterruptions: [],
    overlappingSpeech: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function textSample(value: unknown, maxLength = 240): string | undefined {
  const text = asString(value)?.replace(/\s+/g, " ");
  if (!text) return undefined;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

export function snapshotSttProfileTransition(input: {
  assistantText?: unknown;
  callerText?: unknown;
  createdAt?: TimestampInput;
  from: string | null;
  reason: string;
  to: string;
}): SttProfileTransitionAnalytics {
  const assistantText = textSample(input.assistantText);
  const callerText = textSample(input.callerText);

  return {
    ...(assistantText ? { assistantText } : {}),
    ...(callerText ? { callerText } : {}),
    createdAt: timestampToIso(input.createdAt),
    from: input.from,
    reason: input.reason,
    to: input.to,
  };
}

function asNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function normalizedOutputText(output: string | undefined): string {
  if (typeof output !== "string") return "";
  try {
    const parsed = JSON.parse(output) as unknown;
    return typeof parsed === "string" ? parsed.toLowerCase() : "";
  } catch {
    // Some tests and provider adapters pass the already-decoded tool string.
    return output.toLowerCase();
  }
}

export function classifyToolOutput(
  toolName: string,
  output: string | undefined,
  isError: boolean,
  patientIdentityOutcome?: PatientIdentityOutcome,
): ToolOutputClass {
  const outputText = normalizedOutputText(output);
  const platformError = platformToolErrorClass(outputText, isError);
  if (platformError) return platformError;

  if (duplicateToolWasRejected(outputText)) return "duplicate_tool_rejected";

  switch (toolName) {
    case "book_appointment":
      if (/\bcouldn't book the appointment\b/.test(outputText)) {
        return "appointment_booking_failed";
      }
      if (
        !isError &&
        (/\bread back\b/.test(outputText) ||
          /\bsearch availability again\b/.test(outputText) ||
          /\bverify or create the patient\b/.test(outputText) ||
          /\buse reschedule_appointment\b/.test(outputText) ||
          /\bask for a useful appointment reason\b/.test(outputText) ||
          /\bask whether the caller has a referring doctor\b/.test(outputText))
      ) {
        return "appointment_needs_input";
      }
      if (
        /\bnot booked\b/.test(outputText) ||
        /\bslot unavailable\b/.test(outputText) ||
        /\bno longer available\b/.test(outputText) ||
        /\bcheck availability again\b/.test(outputText) ||
        /\bverify or create the patient\b/.test(outputText)
      ) {
        return "appointment_not_booked";
      }
      if (/\bbooked\b/.test(outputText)) {
        return "appointment_booked";
      }
      return isError ? "middleware_error" : "appointment_not_booked";
    case "cancel_appointment":
      if (/\bcouldn't cancel the appointment\b/.test(outputText)) {
        return "appointment_cancellation_failed";
      }
      if (
        !isError &&
        (/\bload appointments\b/.test(outputText) ||
          /\bverify the patient\b/.test(outputText) ||
          /\bappointmentref\b/.test(outputText))
      ) {
        return "appointment_needs_input";
      }
      if (
        /\bnot cancelled\b/.test(outputText) ||
        /\bnot canceled\b/.test(outputText) ||
        /\bfailed to cancel\b/.test(outputText) ||
        /\bload appointments\b/.test(outputText) ||
        /\bverify the patient\b/.test(outputText)
      ) {
        return "appointment_not_cancelled";
      }
      if (
        /\bcancelled the appointment\b/.test(outputText) ||
        /\bcanceled the appointment\b/.test(outputText) ||
        /\bappointment cancelled\b/.test(outputText) ||
        /\bappointment canceled\b/.test(outputText)
      ) {
        return "appointment_cancelled";
      }
      return isError ? "middleware_error" : "appointment_not_cancelled";
    case "reschedule_appointment":
      if (/\bcouldn't book the new appointment\b/.test(outputText)) {
        return "appointment_reschedule_failed";
      }
      if (/\bcould not cancel the old appointment\b/.test(outputText)) {
        return "appointment_reschedule_partial";
      }
      if (
        !isError &&
        (/\bread back\b/.test(outputText) ||
          /\bverify the patient\b/.test(outputText) ||
          /\bload appointments\b/.test(outputText) ||
          /\bappointmentref\b/.test(outputText) ||
          /\bsearch availability again\b/.test(outputText) ||
          /\bask for a useful appointment reason\b/.test(outputText) ||
          /\bask whether the caller has a referring doctor\b/.test(outputText))
      ) {
        return "appointment_needs_input";
      }
      if (
        /\bdid not cancel the existing appointment\b/.test(outputText) ||
        /\bnot booked\b/.test(outputText) ||
        /\bno longer available\b/.test(outputText) ||
        /\bcheck availability again\b/.test(outputText) ||
        /\bverify the patient\b/.test(outputText) ||
        /\bload appointments\b/.test(outputText)
      ) {
        return "appointment_not_rescheduled";
      }
      if (
        /\bappointment is already rescheduled\b/.test(outputText) ||
        /\brescheduled the appointment\b/.test(outputText)
      ) {
        return "appointment_rescheduled";
      }
      return isError ? "middleware_error" : "appointment_not_rescheduled";
    case "transfer_call":
      if (/\btransfer already (?:in progress|started)\b/.test(outputText)) {
        return "duplicate_tool_call";
      }
      if (/\btransfer may already be in progress\b/.test(outputText)) {
        return "transfer_ambiguous";
      }
      if (
        /\bcould not transfer\b/.test(outputText) ||
        /\bcouldn't transfer\b/.test(outputText) ||
        /\bcall is no longer active\b/.test(outputText) ||
        /\btransfer was interrupted\b/.test(outputText) ||
        /\bno active sip session\b/.test(outputText) ||
        /\btransfer failed\b/.test(outputText)
      ) {
        return "transfer_failed";
      }
      return isError ? "middleware_error" : "transfer_started";
    case "create_staff_task":
      if (
        /\bcould not send the staff task\b/.test(outputText) ||
        /\bcouldn't send the message\b/.test(outputText)
      ) {
        return "staff_task_failed";
      }
      if (/\btask already sent to staff\b/.test(outputText)) {
        return "staff_task_duplicate";
      }
      if (/\btask sent to staff\b/.test(outputText)) {
        return "staff_task_created";
      }
      return isError ? "middleware_error" : "staff_task_created";
    case "get_availability":
      if (/\bcouldn't check availability\b/.test(outputText)) {
        return "availability_failed";
      }
      if (
        /\bverify or create the patient before checking availability\b/.test(
          outputText,
        ) ||
        /\bbefore checking availability\b/.test(outputText)
      ) {
        return "availability_needs_input";
      }
      return isError ? "middleware_error" : "availability_returned";
    case "resolve_patient":
      if (patientIdentityOutcome) {
        return patientIdentityOutputClass(patientIdentityOutcome);
      }
      if (
        /\bcouldn't look up the patient\b/.test(outputText) ||
        /\bpatient lookup failed\b/.test(outputText)
      ) {
        return "patient_lookup_failed";
      }
      if (isError) return "middleware_error";
      return patientIdentityOutputClass(patientIdentityOutcome);
    case "add_patient":
      if (/\bcouldn't create the patient chart\b/.test(outputText)) {
        return "patient_creation_failed";
      }
      if (
        /\bbefore creating a new chart\b/.test(outputText) ||
        /\brun check_insurance\b/.test(outputText) ||
        /\bcollect the patient's ssn\b/.test(outputText) ||
        /\bcallback phone number is required\b/.test(outputText) ||
        /\bask the caller\b/.test(outputText) ||
        /\bread back\b/.test(outputText)
      ) {
        return "patient_creation_needs_input";
      }
      if (isError) return "middleware_error";
      return "patient_created";
    case "update_insurance":
      if (
        /\bcouldn't update the insurance\b/.test(outputText) ||
        /\binsurance was not updated\b/.test(outputText)
      ) {
        return "insurance_update_failed";
      }
      if (
        /\bverify the patient\b/.test(outputText) ||
        /\brun check_insurance\b/.test(outputText) ||
        /\bcollect the member id\b/.test(outputText)
      ) {
        return "insurance_update_needs_input";
      }
      if (isError) return "middleware_error";
      return "insurance_updated";
    case "check_insurance":
      return isError ? "middleware_error" : "insurance_checked";
    default:
      return isError ? "middleware_error" : "unknown";
  }
}

function platformToolErrorClass(
  outputText: string,
  isError: boolean,
): ToolOutputClass | null {
  if (!isError) return null;
  if (
    /^invalid arguments for\b/.test(outputText) ||
    /^invalid tool arguments\b/.test(outputText)
  ) {
    return "invalid_tool_arguments";
  }
  if (/^unknown function:/.test(outputText)) return "unknown_tool";
  if (/\ban internal error occurred\b/.test(outputText)) {
    return "internal_tool_error";
  }
  return null;
}

function toolExecutionStatus(
  outputClass: ToolOutputClass,
): ToolExecutionAnalytics["status"] {
  return TOOL_EXECUTION_STATUS_BY_OUTPUT_CLASS[outputClass];
}

export function snapshotToolExecutions(
  event: FunctionToolsExecutedLike,
  takePatientIdentityOutcome: () => PatientIdentityOutcome | undefined = () =>
    undefined,
): ToolExecutionAnalytics[] {
  const outputsByCallId = new Map<string, FunctionCallOutputLike>();
  for (const output of event.functionCallOutputs ?? []) {
    if (output.callId) outputsByCallId.set(output.callId, output);
  }

  return (event.functionCalls ?? []).map((call, index) => {
    const output =
      (call.callId ? outputsByCallId.get(call.callId) : undefined) ??
      event.functionCallOutputs?.[index];
    const toolName = call.name ?? output?.name ?? "unknown";
    const isError = output?.isError === true;
    const duplicateRejected = duplicateToolWasRejected(
      normalizedOutputText(output?.output),
    );
    const patientIdentityOutcome =
      !duplicateRejected &&
      toolName === "resolve_patient" &&
      !platformToolErrorClass(normalizedOutputText(output?.output), isError)
        ? takePatientIdentityOutcome()
        : undefined;
    const outputClass = classifyToolOutput(
      toolName,
      output?.output,
      isError,
      patientIdentityOutcome,
    );

    return {
      callId: call.callId ?? output?.callId ?? call.id ?? "unknown",
      createdAt: timestampToIso(
        event.createdAt ?? output?.createdAt ?? call.createdAt,
      ),
      outputClass,
      status: toolExecutionStatus(outputClass),
      toolName,
    };
  });
}

function duplicateToolWasRejected(outputText: string): boolean {
  return /^same tool `[^`]+` is already running:/.test(outputText);
}

function patientIdentityOutputClass(
  outcome: PatientIdentityOutcome | undefined,
): ToolOutputClass {
  switch (outcome) {
    case "verified":
      return "patient_verified";
    case "switched":
      return "patient_switched";
    case "new":
      return "patient_new";
    case "not_found":
      return "patient_not_found";
    case "multiple_matches":
      return "multiple_patient_matches";
    case "lookup_failed":
      return "patient_lookup_failed";
    case "needs_identity":
    case undefined:
      return "patient_lookup_returned";
  }
}

export function withAppointmentActionToolExecutionFallback(
  executions: ToolExecutionAnalytics[],
  appointmentActions: AppointmentActionAnalytics[],
): ToolExecutionAnalytics[] {
  const remainingExistingByActionKey = new Map<string, number>();
  for (const execution of executions) {
    const actionKey = appointmentExecutionKey(
      execution.toolName,
      execution.outputClass,
    );
    remainingExistingByActionKey.set(
      actionKey,
      (remainingExistingByActionKey.get(actionKey) ?? 0) + 1,
    );
  }

  const fallbackExecutions: ToolExecutionAnalytics[] = [];
  appointmentActions.forEach((action, index) => {
    const toolName =
      action.toolName ?? toolNameForAppointmentAction(action.action);
    const outputClass = outputClassForAppointmentAction(action);
    const actionKey = appointmentExecutionKey(toolName, outputClass);
    const existing = remainingExistingByActionKey.get(actionKey) ?? 0;
    if (existing > 0) {
      remainingExistingByActionKey.set(actionKey, existing - 1);
      return;
    }

    fallbackExecutions.push({
      callId: `appointment_action_${index + 1}`,
      createdAt: timestampToIso(action.createdAt),
      outputClass,
      status: toolExecutionStatus(outputClass),
      toolName,
    });
  });

  return [...executions, ...fallbackExecutions];
}

function appointmentExecutionKey(
  toolName: string,
  outputClass: ToolOutputClass,
): string {
  return `${toolName}:${outputClass}`;
}

function toolNameForAppointmentAction(
  action: AppointmentActionAnalytics["action"],
): string {
  switch (action) {
    case "booked":
      return "book_appointment";
    case "cancelled":
      return "cancel_appointment";
    case "rescheduled":
      return "reschedule_appointment";
  }
}

function outputClassForAppointmentAction(
  action: AppointmentActionAnalytics,
): ToolOutputClass {
  switch (action.action) {
    case "booked":
      return action.status === "error"
        ? "appointment_not_booked"
        : "appointment_booked";
    case "cancelled":
      return action.status === "error"
        ? "appointment_not_cancelled"
        : "appointment_cancelled";
    case "rescheduled":
      if (action.status === "partial") return "appointment_reschedule_partial";
      return action.status === "error"
        ? "appointment_not_rescheduled"
        : "appointment_rescheduled";
  }
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return asString(error.code) ?? asString(error.status) ?? undefined;
}

function errorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name;
  if (!isRecord(error)) return undefined;
  return asString(error.name) ?? undefined;
}

export function classifyErrorMessage(error: unknown): string {
  const name = errorName(error);
  const code = errorCode(error);
  if (code) return `code:${code}`;
  if (name) return name;
  return typeof error;
}

export function sourceName(source: unknown): string | undefined {
  if (!source) return undefined;
  if (typeof source === "function" && source.name) return source.name;
  if (isRecord(source)) {
    const constructorName = isRecord(source.constructor)
      ? asString(source.constructor.name)
      : undefined;
    return constructorName ?? asString(source.name) ?? undefined;
  }
  return undefined;
}

export function snapshotErrorEvent(event: {
  createdAt?: number;
  error?: unknown;
  source?: unknown;
}): SessionEventAnalytics["errors"][number] {
  return {
    code: errorCode(event.error),
    createdAt: timestampToIso(event.createdAt),
    messageClass: classifyErrorMessage(event.error),
    name: errorName(event.error),
    source: sourceName(event.source),
  };
}

export function snapshotCloseEvent(event: {
  createdAt?: number;
  reason?: unknown;
}): NonNullable<SessionEventAnalytics["close"]> {
  return {
    createdAt: timestampToIso(event.createdAt),
    reason: asString(event.reason) ?? undefined,
  };
}

export function snapshotFalseInterruptionEvent(event: {
  createdAt?: number;
  resumed?: boolean;
}): SessionEventAnalytics["falseInterruptions"][number] {
  return {
    createdAt: timestampToIso(event.createdAt),
    resumed: event.resumed === true,
  };
}

export function snapshotOverlappingSpeechEvent(event: {
  detectedAt?: number;
  isInterruption?: boolean;
  totalDurationInS?: number;
}): SessionEventAnalytics["overlappingSpeech"][number] {
  const durationMs = Math.round(asNumber(event.totalDurationInS) * 1000);

  return {
    createdAt: timestampToIso(event.detectedAt),
    ...(durationMs > 0 ? { durationMs } : {}),
    isInterruption: event.isInterruption === true,
  };
}

function metricMetadataModel(metric: Record<string, unknown>): string | null {
  const metadata = metric.metadata;
  if (!isRecord(metadata)) return null;

  const modelName = asString(metadata.modelName);
  const provider = asString(metadata.modelProvider);
  if (provider === "livekit" && modelName?.includes("/")) {
    return modelName;
  }
  if (provider && provider !== "unknown" && modelName) {
    return `${provider}/${modelName}`;
  }
  return modelName;
}

function addModel(models: Set<string>, model: unknown): void {
  const value = normalizeLlmModelName(asString(model));
  if (value) models.add(value);
}

function normalizeLlmModelName(model: string | null): string | null {
  if (!model) return null;
  const normalized = model.trim();
  if (!normalized) return null;
  if (
    normalized === "FallbackAdapter" ||
    normalized.endsWith("/FallbackAdapter")
  ) {
    return null;
  }
  if (normalized.startsWith("unknown/")) {
    return normalizeLlmModelName(normalized.slice("unknown/".length));
  }
  return normalized;
}

function addUsageModels(models: Set<string>, usage: unknown): void {
  for (const entry of usageModelEntries(usage)) {
    if (entry.type !== "llm_usage") continue;
    addModel(models, entry.model);
  }
}

function usageModelEntries(usage: unknown): Record<string, unknown>[] {
  if (!isRecord(usage)) return [];

  const usageEntries = Array.isArray(usage.modelUsage)
    ? usage.modelUsage
    : Array.isArray(usage.usage)
      ? usage.usage
      : [];

  return usageEntries.filter(isRecord);
}

function usageTokenValue(
  entry: Record<string, unknown>,
  keys: string[],
): number {
  for (const key of keys) {
    const value = asNumber(entry[key]);
    if (value > 0) return value;
  }

  return 0;
}

export function buildLlmSummary(input: {
  fallbackModel: string;
  llmMetrics: Record<string, unknown>[];
  usage?: unknown;
}): LlmSummary {
  const models = new Set<string>();
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;
  let peakPromptTokens = 0;
  const ttftValues: number[] = [];

  for (const metric of input.llmMetrics) {
    if (
      metric.type !== "llm_metrics" &&
      metric.type !== "realtime_model_metrics"
    ) {
      continue;
    }

    addModel(models, metricMetadataModel(metric));
    const prompt = asNumber(metric.promptTokens ?? metric.inputTokens);
    const completion = asNumber(metric.completionTokens ?? metric.outputTokens);
    const cached = asNumber(
      metric.promptCachedTokens ??
        (isRecord(metric.inputTokenDetails)
          ? metric.inputTokenDetails.cachedTokens
          : undefined),
    );
    const ttft = asNumber(metric.ttftMs);

    promptTokens += prompt;
    completionTokens += completion;
    cachedPromptTokens += cached;
    peakPromptTokens = Math.max(peakPromptTokens, prompt);
    if (ttft > 0) ttftValues.push(ttft);
  }

  addUsageModels(models, input.usage);
  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    cachedPromptTokens === 0
  ) {
    for (const entry of usageModelEntries(input.usage)) {
      if (entry.type !== "llm_usage") continue;
      promptTokens += usageTokenValue(entry, [
        "inputTokens",
        "input_tokens",
        "promptTokens",
        "prompt_tokens",
      ]);
      completionTokens += usageTokenValue(entry, [
        "outputTokens",
        "output_tokens",
        "completionTokens",
        "completion_tokens",
      ]);
      cachedPromptTokens += usageTokenValue(entry, [
        "inputCachedTokens",
        "input_cached_tokens",
        "promptCachedTokens",
        "prompt_cached_tokens",
      ]);
      peakPromptTokens = Math.max(peakPromptTokens, promptTokens);
    }
  }

  const modelsUsed = [...models];
  const fallbackModel = normalizeLlmModelName(input.fallbackModel);
  const fallbackUsed = Boolean(
    fallbackModel &&
    modelsUsed.some(
      (model) => model === fallbackModel || model.endsWith(`/${fallbackModel}`),
    ),
  );

  return {
    ...(ttftValues.length > 0
      ? {
          avgTtftMs: Math.round(
            ttftValues.reduce((sum, value) => sum + value, 0) /
              ttftValues.length,
          ),
        }
      : {}),
    cacheHitRate: promptTokens > 0 ? cachedPromptTokens / promptTokens : 0,
    cachedPromptTokens,
    completionTokens,
    fallbackUsed,
    modelsUsed,
    ...(peakPromptTokens > 0 ? { peakPromptTokens } : {}),
    promptTokens,
  };
}
