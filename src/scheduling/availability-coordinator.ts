import type {
  AvailabilityInvalidationReason,
  CallState,
} from "../state/call-state.js";
import { recordAvailabilityReadEvent } from "../state/observability.js";
import type { AvailabilityResult } from "./middleware.js";

type AvailabilityCoordinator = {
  completed: Map<string, AvailabilityResult>;
  generation: number;
  inFlight: Map<string, Promise<AvailabilityResult>>;
};

const coordinatorKey = Symbol("availabilityCoordinator");

type CallStateWithAvailabilityCoordinator = CallState & {
  [coordinatorKey]?: AvailabilityCoordinator;
};

export async function coordinatedAvailabilityRead(
  state: CallState,
  key: string,
  read: () => Promise<AvailabilityResult>,
  signal?: AbortSignal,
): Promise<AvailabilityResult> {
  const startedAt = Date.now();
  signal?.throwIfAborted();
  const coordinator = availabilityCoordinatorFor(state);
  const completed = coordinator.completed.get(key);
  if (completed) {
    recordAvailabilityReadEvent(state, {
      operation: "completed_cache_hit",
      durationMs: elapsedMilliseconds(startedAt),
    });
    return completed;
  }

  const existing = coordinator.inFlight.get(key);
  if (existing) {
    try {
      return await existing;
    } finally {
      recordAvailabilityReadEvent(state, {
        operation: "in_flight_join",
        durationMs: elapsedMilliseconds(startedAt),
      });
    }
  }

  const pending = Promise.resolve().then(read);
  coordinator.inFlight.set(key, pending);
  const discard = () => {
    if (coordinator.inFlight.get(key) === pending) {
      invalidateAvailabilityReads(state, "request_cancelled");
    }
  };
  signal?.addEventListener("abort", discard, { once: true });
  try {
    return await pending;
  } catch (error) {
    if (coordinator.inFlight.get(key) === pending) {
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
): void {
  const coordinator = availabilityCoordinatorFor(state);
  coordinator.completed.set(key, copyAvailabilityResult(result));
  coordinator.inFlight.delete(key);
}

export function discardAvailabilityRead(state: CallState, key: string): void {
  availabilityCoordinatorFor(state).inFlight.delete(key);
}

export function availabilityReadGeneration(state: CallState): number {
  return availabilityCoordinatorFor(state).generation;
}

export function invalidateAvailabilityReads(
  state: CallState,
  reason: AvailabilityInvalidationReason,
): boolean {
  const coordinator = availabilityCoordinatorFor(state);
  const invalidated =
    coordinator.completed.size > 0 || coordinator.inFlight.size > 0;
  coordinator.generation += 1;
  coordinator.completed.clear();
  coordinator.inFlight.clear();
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
  };
  Object.defineProperty(sessionState, coordinatorKey, {
    value: coordinator,
    enumerable: false,
  });
  return coordinator;
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
