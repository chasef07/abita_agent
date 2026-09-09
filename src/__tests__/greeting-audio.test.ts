import {
  AgentSession,
  AgentSessionEventTypes,
  initializeLogger,
  voice,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { getOfficeProfiles } from "../customers/abita/profile.js";
import {
  decodeGreetingWav,
  greetingAudio,
  greetingAudioPath,
} from "../runtime/greeting-audio.js";
import { getRimeTtsOptions } from "../tts-config.js";
import { createTestCallState } from "./support/call-state.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

beforeAll(() => initializeLogger({ level: "silent", pretty: false }));

describe("packaged greetings", () => {
  it("rejects damaged or mismatched audio before playback", async () => {
    const trunk = getOfficeProfiles()[0]!.trunkPhones[0]!;
    const wav = await readFile(greetingAudioPath(trunk));
    expect(() => decodeGreetingWav(wav, 24000)).toThrow(
      "Invalid packaged greeting",
    );
    expect(() =>
      decodeGreetingWav(wav.subarray(0, wav.length - 2), 16000),
    ).toThrow("Invalid packaged greeting");
    expect(() => decodeGreetingWav(Buffer.alloc(0), 16000)).toThrow(
      "Invalid packaged greeting",
    );
  });
  it.each(getOfficeProfiles())(
    "$key has decodable audio matching its current text and voice",
    async (office) => {
      const trunk = office.trunkPhones[0]!;
      const wav = await readFile(greetingAudioPath(trunk));
      const sampleRate = getRimeTtsOptions({ trunkPhone: trunk }).samplingRate;
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(sampleRate);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
      let samples = 0;
      let peak = 0;
      const decoded: Buffer[] = [];
      for await (const frame of await greetingAudio(trunk)) {
        expect(frame.sampleRate).toBe(sampleRate);
        expect(frame.channels).toBe(1);
        samples += frame.samplesPerChannel;
        decoded.push(
          Buffer.from(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength,
          ),
        );
        for (const sample of frame.data)
          peak = Math.max(peak, Math.abs(sample));
      }
      expect(samples).toBe((wav.length - 44) / 2);
      expect(Buffer.concat(decoded).equals(wav.subarray(44))).toBe(true);
      expect(samples / sampleRate).toBeGreaterThan(1);
      expect(samples / sampleRate).toBeLessThan(30);
      expect(peak).toBeGreaterThan(100);
    },
  );

  it("plays the greeting without TTS and commits its text exactly once", async () => {
    const office = getOfficeProfiles()[0]!;
    const { agent } = createVoiceAgent(office.trunkPhones[0]!, {
      ownedMiddleware: new InMemoryOwnedMiddleware(),
    });
    const ttsNode = vi.spyOn(agent, "ttsNode");
    const session = new AgentSession({
      vad: null,
      userData: createTestCallState(),
    });
    const output = new CapturedAudio();
    session.output.audio = output;
    const committed = new Promise<void>((resolve) => {
      session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
        if (event.item.type === "message" && event.item.role === "assistant")
          resolve();
      });
    });
    try {
      await session.start({ agent, record: false });
      await committed;
      expect(ttsNode).not.toHaveBeenCalled();
      expect(output.duration).toBeGreaterThan(1);
      const greetings = session.history.items.filter(
        (item) =>
          item.type === "message" &&
          item.role === "assistant" &&
          item.textContent === office.greeting,
      );
      expect(greetings).toHaveLength(1);
    } finally {
      await session.close();
      ttsNode.mockRestore();
    }
  });
});

class CapturedAudio extends voice.AudioOutput {
  duration = 0;
  async captureFrame(frame: AudioFrame) {
    await super.captureFrame(frame);
    this.duration += frame.samplesPerChannel / frame.sampleRate;
  }
  flush() {
    super.flush();
    this.onPlaybackFinished({
      playbackPosition: this.duration,
      interrupted: false,
    });
  }
  clearBuffer() {
    this.onPlaybackFinished({
      playbackPosition: this.duration,
      interrupted: true,
    });
  }
}
