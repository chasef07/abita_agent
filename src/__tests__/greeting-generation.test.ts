import { AudioFrame } from "@livekit/rtc-node";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";

const state = vi.hoisted(() => ({
  final: false,
  failure: false,
  onError: () => {},
  streamOptions: vi.fn(),
}));

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  writeFile: vi.fn(),
}));

vi.mock("@livekit/agents-plugin-rime", () => ({
  TTS: class {
    on(_event: string, callback: () => void) {
      state.onError = callback;
    }
    async close() {}
    stream(options: unknown) {
      state.streamOptions(options);
      return {
        pushText() {},
        endInput() {},
        close() {},
        async *[Symbol.asyncIterator]() {
          // Enough audio to pass a duration-only check, followed by provider failure.
          yield {
            frame: new AudioFrame(new Int16Array(32000), 16000, 1, 32000),
            final: state.final,
          };
          if (state.failure) state.onError();
        },
      };
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("RIME_API_KEY", "test-key");
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  { name: "missing completion", final: false, failure: false },
  { name: "provider error", final: true, failure: true },
])("does not package partial audio after $name", async ({ final, failure }) => {
  state.final = final;
  state.failure = failure;
  await expect(import("../../scripts/generate-greetings.js")).rejects.toThrow(
    "Incomplete greeting audio",
  );
  expect(writeFile).not.toHaveBeenCalled();
  expect(state.streamOptions).toHaveBeenCalledWith({
    connOptions: expect.objectContaining({ maxRetry: 0 }),
  });
});
