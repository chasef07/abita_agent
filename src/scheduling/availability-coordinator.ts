import type {
  AvailabilityInvalidationReason,
  CallState,
} from "../state/call-state.js";
import { recordAvailabilityReadEvent } from "../state/observability.js";
import type { AvailabilityResult } from "./middleware.js";
import { middlewareFailureIsRetryable } from "../clients/owned-middleware.js";

type AvailabilityCoordinator = {
  completed: Map<string, { expiresAt: number; result: AvailabilityResult }>;
  generation: number;
  inFlight: Map<string, InFlightAvailabilityRead>;
  failed: Map<string, { attempts: number; result: AvailabilityResult }>;
};

type InFlightAvailabilityRead = {
  promise: Promise<AvailabilityResult>;
  result?: AvailabilityResult;
};

type CoordinatedAvailabilityReadOptions = {
  now: Date;
  signal?: AbortSignal;
};

const coordinatorKey = Symbol("availabilityCoordinator");

type CallStateWithAvailabilityCoordinator = CallState & {
  [coordinatorKey]?: AvailabilityCoordinator;
};

export async function coordinatedAvailabilityRead(
  state: CallState,
  key: string,
  read: () => Promise<AvailabilityResult>,
  options: CoordinatedAvailabilityReadOptions,
): Promise<AvailabilityResult> {
  const startedAt = Date.now();
  const { now, signal } = options;
  signal?.throwIfAborted();
  const coordinator = availabilityCoordinatorFor(state);
  const failed = coordinator.failed.get(key);
  if (failed && !availabilityReadCanRetry(state, key)) {
    return failed.result;
  }
  const completed = coordinator.completed.get(key);
  if (completed) {
    if (now.getTime() >= completed.expiresAt) {
      coordinator.completed.clear();
      recordAvailabilityReadEvent(state, {
        operation: "invalidation",
        reason: "booking_token_expired",
      });
    } else {
      recordAvailabilityReadEvent(state, {
        operation: "completed_cache_hit",
        durationMs: elapsedMilliseconds(startedAt),
      });
      return completed.result;
    }
  }

  const existing = coordinator.inFlight.get(key);
  if (existing) {
    try {
      return await existing.promise;
    } finally {
      recordAvailabilityReadEvent(state, {
        operation: "in_flight_join",
        durationMs: elapsedMilliseconds(startedAt),
      });
    }
  }

  const pending = Promise.resolve().then(read);
  const inFlight: InFlightAvailabilityRead = { promise: pending };
  inFlight.promise = pending.then((result) => {
    // Count backend attempts once, even when multiple tool calls share the read.
    if (coordinator.inFlight.get(key) === inFlight && !signal?.aborted) {
      if (result.status === "incomplete" || result.status === "error") {
        const attempts = (coordinator.failed.get(key)?.attempts ?? 0) + 1;
        coordinator.failed.set(key, { attempts, result });
      } else {
        coordinator.failed.delete(key);
      }
    }
    inFlight.result = result;
    return result;
  });
  coordinator.inFlight.set(key, inFlight);
  const discard = () => {
    if (coordinator.inFlight.get(key) === inFlight) {
      invalidateAvailabilityReads(state, "request_cancelled");
    }
  };
  signal?.addEventListener("abort", discard, { once: true });
  try {
    return await inFlight.promise;
  } catch (error) {
    if (coordinator.inFlight.get(key) === inFlight) {
      coordinator.inFlight.delete(key);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", discard);
    recordAvailabilityReadEvent(state, {
      operation: "middleware_call",
      durationMs: elapsedMilliseconds(startedAt),
    });
  }
}

export function cacheCompletedAvailabilityRead(
  state: CallState,
  key: string,
  result: AvailabilityResult,
  now: Date,
): number | undefined {
  const coordinator = availabilityCoordinatorFor(state);
  const expiresAt = availabilityResultExpiresAt(result);
  if (
    (result.status !== "found" && result.status !== "none") ||
    (result.status === "found" &&
      (expiresAt === null || expiresAt <= now.getTime()))
  ) {
    discardInFlightAvailabilityResult(coordinator, key, result);
    return;
  }
  // Cache hits must retain the original fetch deadline, especially empty results
  // which have no booking token to provide an independent expiry.
  const snapshotExpiresAt =
    coordinator.completed.get(key)?.expiresAt ??
    availabilitySnapshotExpiresAt(result, now);
  if (!coordinator.completed.has(key)) {
    coordinator.completed.set(key, {
      expiresAt: snapshotExpiresAt,
      result: copyAvailabilityResult(result),
    });
  }
  discardInFlightAvailabilityResult(coordinator, key, result);
  return snapshotExpiresAt;
}

export function discardAvailabilityRead(
  state: CallState,
  key: string,
  result: AvailabilityResult,
): void {
  discardInFlightAvailabilityResult(
    availabilityCoordinatorFor(state),
    key,
    result,
  );
}

export function invalidateAvailabilityCacheForExpiredResult(
  state: CallState,
  key: string,
  result: AvailabilityResult,
): void {
  const coordinator = availabilityCoordinatorFor(state);
  if (coordinator.inFlight.get(key)?.result !== result) return;

  coordinator.completed.clear();
  coordinator.inFlight.delete(key);
  recordAvailabilityReadEvent(state, {
    operation: "invalidation",
    reason: "booking_token_expired",
  });
}

export function availabilityResultHasExpiredBookingTokens(
  result: AvailabilityResult,
  now: Date,
): boolean {
  const expiresAt = availabilityResultExpiresAt(result);
  return expiresAt !== null && expiresAt <= now.getTime();
}

export function availabilityReadGeneration(state: CallState): number {
  return availabilityCoordinatorFor(state).generation;
}

export function availabilityReadCanRetry(
  state: CallState,
  key: string,
): boolean {
  const failed = availabilityCoordinatorFor(state).failed.get(key);
  if (!failed) return true;
  return (
    failed.attempts < 2 &&
    (failed.result.status === "error"
      ? middlewareFailureIsRetryable(failed.result)
      : failed.result.shouldRetrySameSearch)
  );
}

export function invalidateAvailabilityReads(
  state: CallState,
  reason: AvailabilityInvalidationReason,
): boolean {
  const coordinator = availabilityCoordinatorFor(state);
  const invalidated =
    coordinator.completed.size > 0 ||
    coordinator.inFlight.size > 0 ||
    coordinator.failed.size > 0;
  coordinator.generation += 1;
  coordinator.completed.clear();
  coordinator.inFlight.clear();
  coordinator.failed.clear();
  if (invalidated) {
    recordAvailabilityReadEvent(state, {
      operation: "invalidation",
      reason,
    });
  }
  return invalidated;
}

function availabilityCoordinatorFor(state: CallState): AvailabilityCoordinator {
  const sessionState = state as CallStateWithAvailabilityCoordinator;
  const existing = sessionState[coordinatorKey];
  if (existing) return existing;

  const coordinator: AvailabilityCoordinator = {
    completed: new Map(),
    generation: 0,
    inFlight: new Map(),
    failed: new Map(),
  };
  Object.defineProperty(sessionState, coordinatorKey, {
    value: coordinator,
    enumerable: false,
  });
  return coordinator;
}

function discardInFlightAvailabilityResult(
  coordinator: AvailabilityCoordinator,
  key: string,
  result: AvailabilityResult,
): void {
  if (coordinator.inFlight.get(key)?.result === result) {
    coordinator.inFlight.delete(key);
  }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function copyAvailabilityResult(
  result: AvailabilityResult,
): AvailabilityResult {
  return result.status === "error"
    ? { ...result }
    : { ...result, slots: result.slots.map((slot) => ({ ...slot })) };
}

function availabilityResultExpiresAt(
  result: AvailabilityResult,
): number | null {
  if (result.status !== "found") return null;
  const expiresAt = Date.parse(result.bookingTokenExpiresAt ?? "");
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

// Inventory freshness is shorter than signed booking authorization. A selected
// slot is still revalidated by middleware at booking time.
export function availabilitySnapshotExpiresAt(
  result: AvailabilityResult,
  now: Date,
): number {
  return Math.min(
    availabilityResultExpiresAt(result) ?? Infinity,
    now.getTime() + 60_000,
  );
}
