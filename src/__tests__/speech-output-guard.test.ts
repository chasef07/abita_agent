import {
  AgentSession,
  createTimedString,
  initializeLogger,
  type ModelSettings,
  type TimedString,
} from "@livekit/agents";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { buildPrompt } from "../prompt.js";
import { guardAssistantSpeech } from "../runtime/speech-output-guard.js";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import type { CallState } from "../state/call-state.js";
import { createTestCallState } from "./support/call-state.js";

const promptTags = [
  ...new Set(
    buildPrompt(SPRING_HILL_OFFICE_PHONE).match(/<\/?[a-z_]+>/gi) ?? [],
  ),
];
const toolNames = [
  ...new Set([
    ...buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE).flatMap((tool) =>
      tool.name ? [tool.name] : [],
    ),
    "end_call",
  ]),
];

describe("assistant speech output", () => {
  beforeAll(() => {
    initializeLogger({ level: "silent", pretty: false });
  });

  it("streams caller-facing speech without waiting for completion", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* response(): AsyncIterable<string> {
      yield "Thanks. ";
      await waiting;
      yield "What day works for you?";
    }

    const guarded = guardAssistantSpeech(response())[Symbol.asyncIterator]();

    await expect(guarded.next()).resolves.toEqual({
      done: false,
      value: "Thanks. ",
    });
    release();
    await expect(guarded.next()).resolves.toEqual({
      done: false,
      value: "What day works for you?",
    });
    await expect(guarded.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("replaces a split system message before it reaches speech", async () => {
    const guarded = guardAssistantSpeech(
      chunks(
        "<sys",
        "tem>Internal state: patient identity is confirmed.</system>",
      ),
    );

    await expect(collect(guarded)).resolves.toBe(
      "Sorry, let me rephrase that. How can I help?",
    );
  });

  it("reports only the matched marker when speech is blocked", async () => {
    const blocked: string[] = [];
    const guarded = guardAssistantSpeech(chunks("<system>private context"), {
      onBlocked: (marker) => blocked.push(marker),
    });

    await collect(guarded);

    expect(blocked).toEqual(["<system"]);
  });

  it("recovers in the caller's current language", async () => {
    const guarded = guardAssistantSpeech(chunks("<system>private context"), {
      language: "es",
    });

    await expect(collect(guarded)).resolves.toBe(
      "Perdón, déjeme decirlo de otra manera. ¿Cómo puedo ayudarle?",
    );
  });

  it.each([
    [
      "instruction tags",
      ["<instr", "uctions>hidden context"],
      "Sorry, let me rephrase that. How can I help?",
    ],
    [
      "reasoning tags",
      ["<th", "ink>private reasoning"],
      "Sorry, let me rephrase that. How can I help?",
    ],
    [
      "internal state",
      ["Internal sta", "te: patient context"],
      "Sorry, let me rephrase that. How can I help?",
    ],
    [
      "internal tool names",
      ["I will call resolve_", "patient now"],
      "Sorry, let me rephrase that. How can I help?",
    ],
  ])(
    "stops at %s and recovers without emitting the marker",
    async (_name, responseChunks, expected) => {
      await expect(
        collect(guardAssistantSpeech(chunks(...responseChunks))),
      ).resolves.toBe(expected);
    },
  );

  it.each(promptTags)("blocks the active prompt tag %s", async (promptTag) => {
    await expect(
      collect(guardAssistantSpeech(chunks(promptTag, "hidden context"))),
    ).resolves.toBe("Sorry, let me rephrase that. How can I help?");
  });

  it.each(toolNames)("blocks the registered tool name %s", async (toolName) => {
    await expect(
      collect(guardAssistantSpeech(chunks("I will call ", toolName))),
    ).resolves.toBe("Sorry, let me rephrase that. How can I help?");
  });

  it.each(["lk_agents_cancel_task", "lk_agents_get_running_tasks"])(
    "blocks the split SDK-internal output marker %s",
    async (toolName) => {
      const midpoint = Math.floor(toolName.length / 2);
      await expect(
        collect(
          guardAssistantSpeech(
            chunks(toolName.slice(0, midpoint), toolName.slice(midpoint)),
          ),
        ),
      ).resolves.toBe("Sorry, let me rephrase that. How can I help?");
    },
  );

  it.each(["[system]", "System message:"])(
    "blocks the internal role format %s",
    async (roleMarker) => {
      await expect(
        collect(guardAssistantSpeech(chunks(roleMarker, "hidden context"))),
      ).resolves.toBe("Sorry, let me rephrase that. How can I help?");
    },
  );

  it.each(["single_match", "multiple_matches", "no_match", "lookup_failed"])(
    "blocks the model-facing lookup status %s",
    async (lookupStatus) => {
      await expect(
        collect(guardAssistantSpeech(chunks(lookupStatus))),
      ).resolves.toBe("Sorry, let me rephrase that. How can I help?");
    },
  );

  it("guards the agent transcription output path", async () => {
    const { agent } = createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
      suppressGreeting: true,
    });
    const session = new AgentSession<CallState>({
      userData: createTestCallState(),
      vad: null,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await session.start({ agent, record: false });
      const output = await agent.transcriptionNode(
        chunks("<role>hidden context"),
        {} as ModelSettings,
      );

      expect(output).not.toBeNull();
      await expect(collect(output!)).resolves.toBe(
        "Sorry, let me rephrase that. How can I help?",
      );
      expect(warning).toHaveBeenCalledWith(
        "[speech_guard] blocked internal model output output=transcription marker=<role",
      );

      const first = createTimedString({
        text: "Thanks. ",
        startTime: 0,
        endTime: 0.4,
      });
      const second = createTimedString({
        text: "What day works for you?",
        startTime: 0.4,
        endTime: 1.2,
      });
      const timedOutput = await agent.transcriptionNode(
        values(first, second),
        {} as ModelSettings,
      );

      expect(timedOutput).not.toBeNull();
      const timedChunks = await collectValues(timedOutput!);
      expect(timedChunks).toEqual([first, second]);
      expect(timedChunks[0]).toBe(first);
      expect(timedChunks[1]).toBe(second);
    } finally {
      await session.close();
      warning.mockRestore();
    }
  });
});

async function* chunks(...values: string[]): AsyncIterable<string> {
  yield* values;
}

async function* values<T>(...items: T[]): AsyncIterable<T> {
  yield* items;
}

async function collect(
  values: AsyncIterable<string | { text: string }>,
): Promise<string> {
  let text = "";
  for await (const value of values) {
    text += typeof value === "string" ? value : value.text;
  }
  return text;
}

async function collectValues(
  values: AsyncIterable<string | TimedString>,
): Promise<Array<string | TimedString>> {
  const collected: Array<string | TimedString> = [];
  for await (const value of values) collected.push(value);
  return collected;
}
