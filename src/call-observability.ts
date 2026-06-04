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

export type ToolExecutionAnalytics = {
  callId: string;
  createdAt: string;
  outputClass: string;
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

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedStatus(
  output: Record<string, unknown> | null,
): string | null {
  return asString(output?.status)?.toLowerCase() ?? null;
}

function normalizedOutcome(
  output: Record<string, unknown> | null,
): string | null {
  return asString(output?.outcome)?.toLowerCase() ?? null;
}

function normalizedOutputText(output: string | undefined): string {
  return typeof output === "string" ? output.toLowerCase() : "";
}

export function classifyToolOutput(
  toolName: string,
  output: string | undefined,
  isError: boolean,
): string {
  if (isError) return "middleware_error";

  const parsed = parseJsonObject(output);
  const status = normalizedStatus(parsed);
  const outcome = normalizedOutcome(parsed);
  if (status === "error") return "tool_error";
  const outputText = normalizedOutputText(output);

  switch (toolName) {
    case "book_appt":
      if (
        /\bnot booked\b/.test(outputText) ||
        /\bno longer available\b/.test(outputText) ||
        /\bcheck availability again\b/.test(outputText) ||
        /\bverify or create the patient\b/.test(outputText)
      ) {
        return "appointment_not_booked";
      }
      if (
        status === "booked" ||
        status === "ok" ||
        /\bbooked\b/.test(outputText) ||
        asString(parsed?.appointmentId) ||
        (isRecord(parsed?.facts) && asString(parsed.facts.appointmentId)) ||
        asString(parsed?.id) ||
        parsed?.ok === true
      ) {
        return "appointment_booked";
      }
      return "appointment_not_booked";
    case "cancel_appt":
      if (
        /\bnot cancelled\b/.test(outputText) ||
        /\bnot canceled\b/.test(outputText) ||
        /\bfailed to cancel\b/.test(outputText) ||
        /\bload appointments\b/.test(outputText) ||
        /\bverify the patient\b/.test(outputText) ||
        status === "not_found" ||
        outcome === "not_found" ||
        outcome === "error"
      ) {
        return "appointment_not_cancelled";
      }
      if (
        /\bcancelled the appointment\b/.test(outputText) ||
        /\bcanceled the appointment\b/.test(outputText) ||
        /\bappointment cancelled\b/.test(outputText) ||
        /\bappointment canceled\b/.test(outputText) ||
        status === "cancelled" ||
        status === "ok" ||
        status === "success" ||
        parsed?.ok === true
      ) {
        return "appointment_cancelled";
      }
      return "appointment_not_cancelled";
    case "reschedule_appt":
      if (
        /\bdid not cancel the existing appointment\b/.test(outputText) ||
        /\bnot booked\b/.test(outputText) ||
        /\bno longer available\b/.test(outputText) ||
        /\bcheck availability again\b/.test(outputText) ||
        /\bverify the patient\b/.test(outputText) ||
        /\bload appointments\b/.test(outputText) ||
        status === "not_found" ||
        outcome === "not_found" ||
        outcome === "error"
      ) {
        return "appointment_not_rescheduled";
      }
      if (/\bcould not cancel the old appointment\b/.test(outputText)) {
        return "appointment_reschedule_partial";
      }
      if (
        status === "rescheduled" ||
        /\brescheduled the appointment\b/.test(outputText)
      ) {
        return "appointment_rescheduled";
      }
      return "appointment_not_rescheduled";
    case "confirm_appt":
      if (
        status === "no_appointments" ||
        parsed?.appointmentsStatus === "none"
      ) {
        return "appointments_not_found";
      }
      if (
        status === "found" ||
        parsed?.appointmentsStatus === "found" ||
        Array.isArray(parsed?.appointments)
      ) {
        return "appointments_found";
      }
      return "appointment_lookup_returned";
    case "transfer_call":
      if (/\btransfer already started\b/.test(outputText)) {
        return "duplicate_tool_call";
      }
      if (
        /\bcould not transfer\b/.test(outputText) ||
        /\btransfer was interrupted\b/.test(outputText) ||
        /\bno active sip session\b/.test(outputText) ||
        /\btransfer failed\b/.test(outputText)
      ) {
        return "transfer_failed";
      }
      if (
        outcome === "not_allowed" ||
        outcome === "needs_clarification" ||
        parsed?.retryable === true
      ) {
        return "transfer_not_started";
      }
      return "transfer_started";
    case "get_availability":
      return "availability_returned";
    case "confirm_patient_identity":
    case "verify_patient":
      if (status === "verified") return "patient_verified";
      if (status === "multiple_matches") return "multiple_patient_matches";
      if (status === "not_found") return "patient_not_found";
      return "patient_lookup_returned";
    case "add_patient":
      return "patient_created";
    case "update_insurance":
      return "insurance_updated";
    case "check_insurance":
      return "insurance_checked";
    case "lookup_knowledge":
      return "knowledge_returned";
    default:
      return "unknown";
  }
}

function toolExecutionStatus(
  isError: boolean,
  outputClass: string,
): ToolExecutionAnalytics["status"] {
  if (
    isError ||
    outputClass === "middleware_error" ||
    outputClass === "tool_error" ||
    outputClass === "appointment_not_cancelled" ||
    outputClass === "appointment_not_rescheduled" ||
    outputClass === "appointment_reschedule_partial" ||
    outputClass === "transfer_failed" ||
    outputClass === "transfer_not_started"
  ) {
    return "error";
  }

  return "success";
}

export function snapshotToolExecutions(
  event: FunctionToolsExecutedLike,
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
    const outputClass = classifyToolOutput(toolName, output?.output, isError);

    return {
      callId: call.callId ?? output?.callId ?? call.id ?? "unknown",
      createdAt: timestampToIso(
        event.createdAt ?? output?.createdAt ?? call.createdAt,
      ),
      outputClass,
      status: toolExecutionStatus(isError, outputClass),
      toolName,
    };
  });
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
