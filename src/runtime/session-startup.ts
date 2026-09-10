export async function coordinateSessionStartup<
  TLookup,
  TRuntime,
  TPrepared,
>(input: {
  lookup: (signal: AbortSignal) => Promise<TLookup>;
  initializeRuntime: () => Promise<TRuntime>;
  prepareSession: (lookup: TLookup, runtime: TRuntime) => TPrepared;
  startSession: (prepared: TPrepared, runtime: TRuntime) => Promise<void>;
  startupIsActive?: () => boolean;
}): Promise<void> {
  const lookupController = new AbortController();

  const lookupPromise = startTask(() =>
    input.lookup(lookupController.signal),
  ).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let runtime: TRuntime;
  try {
    runtime = await startTask(input.initializeRuntime);
  } catch (error) {
    lookupController.abort();
    throw error;
  }
  const lookup = await lookupPromise;
  if (!lookup.ok) throw lookup.error;

  assertStartupActive(input.startupIsActive);
  const prepared = input.prepareSession(lookup.value, runtime);
  assertStartupActive(input.startupIsActive);
  await input.startSession(prepared, runtime);
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
