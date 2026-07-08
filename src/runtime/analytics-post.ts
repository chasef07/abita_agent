type AnalyticsLogger = Pick<Console, "log" | "warn">;

export type AnalyticsPostResult = {
  attempts: number;
  ok: boolean;
  skipped?: boolean;
  status?: number;
};

export type ShutdownAnalyticsPostResult = {
  richResult: AnalyticsPostResult;
  summaryResult: AnalyticsPostResult;
};

export function getAnalyticsSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.LIVEKIT_FORWARD_SYNC_SECRET || env.WEBHOOK_SECRET;
}

function payloadLabel(payload: Record<string, unknown>): string {
  const callId = typeof payload.callId === "string" ? payload.callId : "";
  const status = typeof payload.status === "string" ? payload.status : "";
  return [callId, status].filter(Boolean).join(" ");
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postAnalyticsPayload(
  payload: Record<string, unknown>,
  options: {
    fetchImpl?: typeof fetch;
    logger?: AnalyticsLogger;
    maxAttempts?: number;
    phase: string;
    retryDelayMs?: number;
    secret?: string;
    timeoutMs?: number;
    url?: string;
  },
): Promise<AnalyticsPostResult> {
  const {
    fetchImpl = fetch,
    logger = console,
    maxAttempts = 4,
    phase,
    retryDelayMs = 2_000,
    secret,
    timeoutMs = 10_000,
    url,
  } = options;

  if (!url) return { attempts: 0, ok: false, skipped: true };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret) headers.Authorization = `Bearer ${secret}`;

  let lastStatus: number | undefined;
  const label = payloadLabel(payload);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        body: JSON.stringify(payload),
        headers,
        method: "POST",
        signal:
          timeoutMs > 0 && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(timeoutMs)
            : undefined,
      });
      lastStatus = response.status;
      if (response.ok) {
        logger.log(
          `[${phase}] Analytics POST succeeded (attempt ${attempt})${label ? ` ${label}` : ""}`,
        );
        return { attempts: attempt, ok: true, status: response.status };
      }

      const body = await response.text().catch(() => "");
      logger.warn(
        `[${phase}] Analytics POST returned ${response.status} (attempt ${attempt})${label ? ` ${label}` : ""}: ${body.slice(0, 200)}`,
      );
    } catch (error) {
      logger.warn(
        `[${phase}] Analytics POST failed (attempt ${attempt})${label ? ` ${label}` : ""}:`,
        error,
      );
    }

    if (attempt < maxAttempts) await wait(retryDelayMs * attempt);
  }

  logger.warn(
    `[${phase}] Analytics POST exhausted attempts${label ? ` ${label}` : ""}`,
  );
  return { attempts: maxAttempts, ok: false, status: lastStatus };
}

export async function postShutdownAnalyticsPayloads(
  summaryPayload: Record<string, unknown>,
  richPayload: Record<string, unknown>,
  options: {
    fetchImpl?: typeof fetch;
    logger?: AnalyticsLogger;
    secret?: string;
    url?: string;
  },
): Promise<ShutdownAnalyticsPostResult> {
  const summaryResult = await postAnalyticsPayload(summaryPayload, {
    ...options,
    maxAttempts: 2,
    phase: "shutdown-summary",
    retryDelayMs: 1_000,
    timeoutMs: 3_000,
  });
  const richResult = await postAnalyticsPayload(richPayload, {
    ...options,
    phase: "shutdown",
  });

  return { richResult, summaryResult };
}
