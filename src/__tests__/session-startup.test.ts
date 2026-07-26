import { describe, expect, it, vi } from "vitest";
import { coordinateSessionStartup } from "../runtime/session-startup.js";

describe("session startup coordination", () => {
  it("overlaps lookup with runtime setup and waits for both before state and first turn", async () => {
    const lookup = deferred<string>();
    const runtime = deferred<string>();
    const events: string[] = [];
    const createState = vi.fn(
      (lookupResult: string, runtimeResult: string) =>
        `${lookupResult}:${runtimeResult}:complete-state`,
    );
    let now = 100;
    const startSession = vi.fn(async (state: string) => {
      expect(state).toBe("lookup-result:runtime-result:complete-state");
      events.push("session:start");
    });

    const starting = coordinateSessionStartup({
      lookup: () => {
        events.push("lookup:start");
        return lookup.promise;
      },
      initializeRuntime: () => {
        events.push("runtime:start");
        return runtime.promise;
      },
      createState,
      startSession,
      now: () => now,
    });

    expect(events).toEqual(["lookup:start", "runtime:start"]);
    expect(createState).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();

    now = 140;
    runtime.resolve("runtime-result");
    await Promise.resolve();
    expect(createState).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();

    now = 1_000;
    lookup.resolve("lookup-result");
    await expect(starting).resolves.toMatchObject({
      lookup: "lookup-result",
      runtime: "runtime-result",
      state: "lookup-result:runtime-result:complete-state",
      telemetry: {
        overlapped: true,
        lookupCompletedBeforeRuntimeSetup: false,
        runtimeSetupDurationMs: 40,
      },
    });
    expect(createState).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["lookup:start", "runtime:start", "session:start"]);
  });

  it("abandons lookup promptly when runtime setup fails", async () => {
    const lookup = deferred<string>();
    const runtime = deferred<string>();
    const createState = vi.fn(() => "state");
    const startSession = vi.fn(async () => undefined);
    let lookupSignal: AbortSignal | undefined;
    const starting = coordinateSessionStartup({
      lookup: (signal) => {
        lookupSignal = signal;
        return lookup.promise;
      },
      initializeRuntime: () => runtime.promise,
      createState,
      startSession,
    });

    runtime.reject(new Error("runtime setup failed"));
    await expect(starting).rejects.toThrow("runtime setup failed");
    expect(lookupSignal?.aborted).toBe(true);
    expect(createState).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();

    lookup.resolve("late lookup result");
    await Promise.resolve();
    expect(createState).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("lets runtime registration finish before surfacing lookup failure", async () => {
    const runtime = deferred<string>();
    const createState = vi.fn(() => "state");
    const startSession = vi.fn(async () => undefined);
    const starting = coordinateSessionStartup({
      lookup: async () => {
        throw new Error("lookup failed");
      },
      initializeRuntime: () => runtime.promise,
      createState,
      startSession,
    });
    let settled = false;
    void starting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);

    runtime.resolve("runtime registered");
    await expect(starting).rejects.toThrow("lookup failed");
    expect(createState).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("discards a late lookup after the call startup is abandoned", async () => {
    const lookup = deferred<string>();
    const createState = vi.fn(() => "state");
    const startSession = vi.fn(async () => undefined);
    let startupActive = true;
    const starting = coordinateSessionStartup({
      lookup: () => lookup.promise,
      initializeRuntime: async () => "runtime",
      startupIsActive: () => startupActive,
      createState,
      startSession,
    });

    startupActive = false;
    lookup.resolve("late lookup result");

    await expect(starting).rejects.toThrow("Session startup was abandoned");
    expect(createState).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
