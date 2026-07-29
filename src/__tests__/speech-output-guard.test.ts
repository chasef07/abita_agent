import { describe, expect, it } from "vitest";
import { guardAssistantSpeech } from "../runtime/speech-output-guard.js";

describe("assistant speech output", () => {
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
      "I will call Sorry, let me rephrase that. How can I help?",
    ],
  ])(
    "stops at %s and recovers without emitting the marker",
    async (_name, responseChunks, expected) => {
      await expect(
        collect(guardAssistantSpeech(chunks(...responseChunks))),
      ).resolves.toBe(expected);
    },
  );
});

async function* chunks(...values: string[]): AsyncIterable<string> {
  yield* values;
}

async function collect(values: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const value of values) text += value;
  return text;
}
