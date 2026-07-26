import type { StartupOverlapTelemetry } from "../state/call-state.js";

export async function coordinateSessionStartup<
  TLookup,
  TRuntime,
  TState,
>(input: {
  lookup: (signal: AbortSignal) => Promise<TLookup>;
  initializeRuntime: () => Promise<TRuntime>;
  createState: (
    lookup: TLookup,
    runtime: TRuntime,
    telemetry: StartupOverlapTelemetry,
  ) => TState;
  startSession: (state: TState, runtime: TRuntime) => Promise<void>;
  startupIsActive?: () => boolean;
  now?: () => number;
}): Promise<{
  lookup: TLookup;
  runtime: TRuntime;
  state: TState;
  telemetry: StartupOverlapTelemetry;
}> {
  const now = input.now ?? Date.now;
  let runtimeSetupComplete = false;
  let runtimeSetupDurationMs = 0;
  let lookupCompletedBeforeRuntimeSetup = false;
  const lookupController = new AbortController();

  const lookupPromise = startTask(() =>
    input.lookup(lookupController.signal),
  ).then(
    (value) => {
      lookupCompletedBeforeRuntimeSetup = !runtimeSetupComplete;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      lookupCompletedBeforeRuntimeSetup = !runtimeSetupComplete;
      return { ok: false as const, error };
    },
  );
  const runtimeStartedAt = now();
  const runtimePromise = startTask(input.initializeRuntime).finally(() => {
    runtimeSetupDurationMs = Math.max(0, now() - runtimeStartedAt);
    runtimeSetupComplete = true;
  });
  let runtime: TRuntime;
  try {
    runtime = await runtimePromise;
  } catch (error) {
    lookupController.abort();
    throw error;
  }
  const lookupResult = await lookupPromise;
  if (!lookupResult.ok) throw lookupResult.error;
  const lookup = lookupResult.value;
  const telemetry: StartupOverlapTelemetry = {
    overlapped: true,
    lookupCompletedBeforeRuntimeSetup,
    runtimeSetupDurationMs,
  };

  assertStartupActive(input.startupIsActive);

  const state = input.createState(lookup, runtime, telemetry);
  assertStartupActive(input.startupIsActive);
  await input.startSession(state, runtime);
  return {
    lookup,
    runtime,
    state,
    telemetry,
  };
}

function assertStartupActive(startupIsActive: (() => boolean) | undefined) {
  if (startupIsActive?.() === false) {
    throw new Error("Session startup was abandoned");
  }
}

function startTask<T>(task: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(task());
  } catch (error) {
    return Promise.reject(error);
  }
}
