import {
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
  tts as livekitTts,
} from "@livekit/agents";
import * as rime from "@livekit/agents-plugin-rime";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getOfficeProfiles } from "../src/customers/abita/profile.js";
import { greetingAudioPath } from "../src/runtime/greeting-audio.js";
import { getRimeTtsOptions } from "../src/tts-config.js";

initializeLogger({ level: "silent", pretty: false });
if (!process.env.RIME_API_KEY) throw new Error("RIME_API_KEY is required");

const generated = new Set<string>();
for (const office of getOfficeProfiles()) {
  const trunkPhone = office.trunkPhones[0]!;
  const path = greetingAudioPath(trunkPhone);
  if (generated.has(path)) continue;
  const options = getRimeTtsOptions({ trunkPhone });
  const tts = new rime.TTS(options);
  let failed = false;
  let complete = false;
  tts.on("error", () => {
    failed = true;
  });
  // Never append a retried synthesis to an already received audio prefix.
  const stream = tts.stream({
    connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 },
  });
  const chunks: Buffer[] = [];
  try {
    stream.pushText(office.greeting);
    stream.endInput();
    for await (const event of stream) {
      if (event === livekitTts.SynthesizeStream.END_OF_STREAM) continue;
      const { frame } = event;
      complete = event.final;
      if (frame.sampleRate !== options.samplingRate || frame.channels !== 1) {
        throw new Error(`Unexpected greeting audio format: ${office.key}`);
      }
      chunks.push(
        Buffer.from(
          frame.data.buffer,
          frame.data.byteOffset,
          frame.data.byteLength,
        ),
      );
    }
  } finally {
    stream.close();
    await tts.close();
  }
  const pcm = Buffer.concat(chunks);
  if (
    failed ||
    !complete ||
    pcm.length < options.samplingRate * 2 ||
    pcm.length % 2 !== 0
  ) {
    throw new Error(`Incomplete greeting audio: ${office.key}`);
  }
  // PCM WAV: signed 16-bit little-endian, mono, matching the live Rime voice.
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(options.samplingRate, 24);
  header.writeUInt32LE(options.samplingRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.concat([header, pcm]));
  generated.add(path);
  console.log(
    `${office.key}: ${(pcm.length / (options.samplingRate * 2)).toFixed(2)}s -> ${path}`,
  );
}
