export const MAX_CALL_DURATION_MS = 30 * 60 * 1000;
export const CALL_DURATION_LIMIT_REASON = "max call duration exceeded";

type DeadlineContext = {
  shutdown(reason?: string): void;
};

type LoggerLike = Pick<Console, "error" | "warn">;

export type CallDurationDeadline = {
  clear(): void;
  exceeded(): boolean;
};

export function attachCallDurationDeadline(
  ctx: DeadlineContext,
  options: {
    callId: string;
    logger?: LoggerLike;
    onExceeded?: () => void;
    roomName: string;
    shutdownSession?: (reason: string) => void;
    timeoutMs?: number;
  },
): CallDurationDeadline {
  const timeoutMs = options.timeoutMs ?? MAX_CALL_DURATION_MS;
  const logger = options.logger ?? console;
  let cleared = false;
  let exceeded = false;

  const timer = setTimeout(() => {
    if (cleared) return;
    exceeded = true;
    logger.warn(
      `[call] Maximum call duration reached for ${options.callId}; limitMs=${timeoutMs}, room=${options.roomName || "unknown"}`,
    );
    options.onExceeded?.();
    try {
      options.shutdownSession?.(CALL_DURATION_LIMIT_REASON);
    } catch (err) {
      logger.error(
        `[call] Failed to shut down agent session after duration limit for ${options.callId}:`,
        err,
      );
    }
    ctx.shutdown(CALL_DURATION_LIMIT_REASON);
  }, timeoutMs);

  return {
    clear() {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
    },
    exceeded: () => exceeded,
  };
}
