import { AudioByteStream } from "@livekit/agents";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import { getRimeTtsOptions } from "../tts-config.js";

export function greetingAudioPath(trunkPhone: string): string {
  const text = getOfficeProfileByPhone(trunkPhone).greeting;
  const tts = getRimeTtsOptions({ trunkPhone });
  // A text or voice change requires a new asset. Identical greetings share one.
  const key = createHash("sha256")
    .update(JSON.stringify({ text, tts }))
    .digest("hex");
  return fileURLToPath(
    new URL(`../../assets/greetings/${key}.wav`, import.meta.url),
  );
}

export async function greetingAudio(trunkPhone: string) {
  const wav = await readFile(greetingAudioPath(trunkPhone));
  return decodeGreetingWav(wav, getRimeTtsOptions({ trunkPhone }).sampleRate);
}

export function decodeGreetingWav(wav: Buffer, sampleRate: number) {
  // Only accept the fixed PCM format written by scripts/generate-greetings.ts.
  // LiveKit 1.8's FFmpeg file helper drops the first 1024 samples of these WAVs.
  if (
    wav.length <= 44 ||
    (wav.length - 44) % 2 !== 0 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.readUInt32LE(4) !== wav.length - 8 ||
    wav.toString("ascii", 8, 16) !== "WAVEfmt " ||
    wav.readUInt32LE(16) !== 16 ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt32LE(24) !== sampleRate ||
    wav.readUInt32LE(28) !== sampleRate * 2 ||
    wav.readUInt16LE(32) !== 2 ||
    wav.readUInt16LE(34) !== 16 ||
    wav.toString("ascii", 36, 40) !== "data" ||
    wav.readUInt32LE(40) !== wav.length - 44
  ) {
    throw new Error(
      "Invalid packaged greeting WAV; run pnpm greetings:generate",
    );
  }
  const decoder = new AudioByteStream(sampleRate, 1, sampleRate / 50);
  const frames = [...decoder.write(wav.subarray(44)), ...decoder.flush()];
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  });
}
