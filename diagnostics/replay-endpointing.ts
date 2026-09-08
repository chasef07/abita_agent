import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { initializeLogger, inference, llm } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { STT as AssemblyAI } from "@livekit/agents-plugin-assemblyai";

// Test-only access to the pinned SDK pipeline; no application monkey-patching.
const sdkEntry = import.meta.resolve("@livekit/agents");
const { AudioRecognition } = await import(
  new URL("./voice/audio_recognition.js", sdkEntry).href
);
const { createEndpointing } = await import(
  new URL("./voice/turn_config/endpointing.js", sdkEntry).href
);
const { setLoggerState } = await import(
  new URL("./log_core.js", sdkEntry).href
);
const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath)
  throw new Error(
    "Usage: replay-endpointing.ts MANIFEST.json PRIVATE_OUTPUT_DIR",
  );
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const root = path.resolve(outputPath);
const repo = fileURLToPath(new URL("../", import.meta.url));
if (root === repo.slice(0, -1) || root.startsWith(repo))
  throw new Error("Store transcripts outside the repository");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);
const realRoot = fs.realpathSync(root);
const realRepo = fs.realpathSync(repo);
if (realRoot === realRepo || realRoot.startsWith(realRepo + path.sep))
  throw new Error("Output resolves inside the repository");
initializeLogger({ pretty: false, level: "silent" });
const sdkLogs = new AsyncLocalStorage<any[]>();
const pino = createRequire(sdkEntry)("pino");
setLoggerState(
  pino(
    { level: "warn" },
    {
      write(line: string) {
        // Full SDK warnings stay in private artifacts; never forward them to stdout.
        sdkLogs.getStore()?.push(JSON.parse(line));
      },
    },
  ),
  { pretty: false, level: "warn" },
);
let currentCase: string | null = null;
let currentStage = "manifest";
const results: any[] = [];
const noop = () => {};
function save(name: string, data: unknown) {
  const file = path.join(root, name);
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function run(clip: any, arm: any) {
  currentStage = "initialize";
  const file = clip.file;
  const original = fs.readFileSync(file);
  const bytes = original.subarray(
    0,
    Math.min(original.length, clip.seconds * 32000),
  );
  const input = new Int16Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  );
  const endpointingConfig = arm.endpointing;
  const endpointing = createEndpointing(endpointingConfig);
  const detector = new inference.TurnDetector({
    version: "v1",
    unlikelyThreshold: arm.unlikelyThreshold,
  });
  const vad = new inference.VAD({
    activationThreshold: 0.3,
    deactivationThreshold: 0.15,
    minSilenceDuration: 250,
  });
  const sttOptions = arm.stt.options;
  if (JSON.stringify(sttOptions).match(/api.?key|token|secret/i))
    throw new Error(
      "Credentials belong in environment variables, not manifests",
    );
  const stt =
    arm.stt.provider === "assemblyai"
      ? new AssemblyAI({
          ...sttOptions,
          apiKey: process.env.ASSEMBLYAI_API_KEY,
        })
      : arm.stt.provider === "inference"
        ? new inference.STT(sttOptions)
        : (() => {
            throw new Error("Unknown STT provider");
          })();
  const events: any[] = [];
  const errors: string[] = [];
  const warnings = sdkLogs.getStore()!;
  const agentMarkers = clip.agentMarkers ?? [];
  let markerIndex = 0;
  let started = 0;
  let sttStream: any;
  let stopFeeding = false;
  let recognitionClosed = false;
  let feedCompletedAtMs = 0;
  let maxPacingDriftMs = 0;
  const now = () => Date.now() - started;
  const ctx = llm.ChatContext.empty();
  const record = (type: string, extra: object = {}) =>
    events.push({ type, atMs: now(), ...extra });
  stt.on("error", () => errors.push("stt_error"));
  const recognition = new AudioRecognition({
    vad,
    turnDetector: detector,
    endpointing,
    sttModel: stt.model,
    sttProvider: stt.provider,
    transcriptionTimeout: 3500,
    stt: async (audio: ReadableStream<AudioFrame>) => {
      sttStream = stt.stream();
      sttStream.updateInputStream(audio);
      const iterator = sttStream[Symbol.asyncIterator]();
      return new ReadableStream({
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel() {
          sttStream.detachInputStream();
          sttStream.close();
        },
      });
    },
    recognitionHooks: {
      onInterruption: noop,
      onBackchannelConfirmed: noop,
      onVADInferenceDone: noop,
      onStartOfSpeech: () => record("speech_start"),
      onEndOfSpeech: (ev: any) =>
        record("speech_end", {
          speechDurationMs: ev?.speechDuration,
          silenceMs: ev?.silenceDuration,
          inferenceMs: ev?.inferenceDuration,
          effectiveMinMs: endpointing.minDelay,
        }),
      onInterimTranscript: noop,
      onFinalTranscript: (ev: any) =>
        record("stt_final", {
          text: ev.alternatives?.[0]?.text,
          language: ev.alternatives?.[0]?.language,
        }),
      onTranscriptionTimeout: (speechDuration: number) =>
        record("transcription_timeout", { speechDurationMs: speechDuration }),
      onEndOfTurn: async (info: any) => {
        record("commit", {
          text: info.newTranscript,
          speechEndAtMs:
            info.stoppedSpeakingAt === undefined
              ? null
              : info.stoppedSpeakingAt - started,
          transcriptionDelayMs: info.transcriptionDelay,
          commitDelayMs: info.endOfUtteranceDelay,
          effectiveMinMs: endpointing.minDelay,
        });
        ctx.addMessage({ role: "user", content: info.newTranscript });
        return true;
      },
      onEotPrediction: (ev: any) =>
        record("prediction", {
          probability: ev.probability,
          unlikelyThreshold: ev.threshold,
          model: detector.model,
          inferenceDurationMs: ev.inferenceDurationMs,
          detectionDelayMs: ev.delayMs,
        }),
      onAgentBackchannelOpportunity: noop,
      onPreemptiveGeneration: noop,
      onUserTurnExceeded: noop,
      retrieveChatCtx: () => ctx,
    },
  });
  try {
    currentStage = "recognition_start";
    await recognition.start();
    currentStage = "audio_feed";
    started = Date.now();
    // Paced PCM with unchanged internal pauses and five seconds of trailing silence.
    const samples = input.length + 5 * 16000;
    let offset = 0;
    let resolveFeed: () => void;
    const fed = new Promise<void>((resolve) => {
      resolveFeed = resolve;
    });
    recognition.setInputAudioStream(
      new ReadableStream({
        async pull(controller) {
          if (stopFeeding || offset >= samples) {
            feedCompletedAtMs = now();
            resolveFeed();
            controller.close();
            return;
          }
          await sleep(Math.max(0, started + offset / 16 - Date.now()));
          if (stopFeeding) {
            controller.close();
            return;
          }
          maxPacingDriftMs = Math.max(maxPacingDriftMs, now() - offset / 16);
          while (
            markerIndex < agentMarkers.length &&
            agentMarkers[markerIndex].atMs <= offset / 16
          ) {
            const marker = agentMarkers[markerIndex++];
            if (marker.type === "start")
              endpointing.onStartOfAgentSpeech(started + marker.atMs);
            else endpointing.onEndOfAgentSpeech(started + marker.atMs);
            record(`recorded_agent_${marker.type}`, {
              sourceAtMs: marker.atMs,
            });
          }
          const frame = new Int16Array(320);
          frame.set(input.subarray(offset, offset + 320));
          offset += 320;
          controller.enqueue(new AudioFrame(frame, 16000, 1, 320));
        },
      }),
    );
    const deadline = setTimeout(
      () => {
        stopFeeding = true;
        resolveFeed();
        errors.push("feed_timeout");
      },
      samples / 16 + 15000,
    );
    try {
      await fed;
    } finally {
      clearTimeout(deadline);
    }
    if (offset < samples) errors.push("incomplete_audio_feed");
    await sleep(1500);
    await recognition.waitForEndOfTurnTask();
    currentStage = "close_and_validate";
    record("closing");
    await recognition.close();
    recognitionClosed = true;
    if (maxPacingDriftMs > 100) errors.push("excessive_pacing_drift");
    if (warnings.some((e) => e.level >= 50)) errors.push("sdk_error");
    const predictions = events.filter((e) => e.type === "prediction");
    if (detector.model !== "turn-detector-v1")
      errors.push("audio_model_fell_back");
    if (!predictions.length) errors.push("no_audio_predictions");
    if (!events.some((e) => e.type === "stt_final"))
      errors.push("no_final_transcript");
    if (!events.some((e) => e.type === "commit"))
      errors.push("no_committed_turn");
    const result = {
      clip: clip.id,
      arm,
      seconds: input.length / 16000,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      audio: clip.processing,
      fixture: clip,
      endpointingConfig,
      sttOptions,
      detectorModel: detector.model,
      thresholds: detector.thresholds,
      events: structuredClone(events),
      errors,
      warnings,
      feedCompletedAtMs,
      maxPacingDriftMs,
      sourceTruncated: bytes.length < original.length,
      agentMarkerCount: markerIndex,
      scope:
        "Real STT, VAD, audio EOT and SDK turn commits. Historical agent activity markers inform endpointing learning on natural calls; they are energy-derived, not human labels or interactive responses. No LLM/TTS, adaptive interruptions, backend, or prompt-based profile changes. Exclude natural commits after source cutoff from latency summaries.",
    };
    save(`${clip.id}-${arm.name}.json`, result);
    results.push(result);
    console.log(
      JSON.stringify({
        clip: clip.id,
        arm: arm.name,
        commits: events.filter((e) => e.type === "commit").length,
        predictions: predictions.length,
        errors,
      }),
    );
  } finally {
    stopFeeding = true;
    if (!recognitionClosed) await recognition.close();
    sttStream?.close();
    await vad.close();
    await detector.aclose();
    await stt.close();
  }
}

try {
  if (!Array.isArray(manifest.cases) || !manifest.cases.length)
    throw new Error("Manifest needs cases");
  const names = new Set();
  for (const { clip, arm } of manifest.cases) {
    for (const name of [clip.id, arm.name]) {
      if (!/^[a-z0-9-]+$/.test(name))
        throw new Error(
          "Case IDs must use lowercase letters, numbers and hyphens",
        );
    }
    const name = `${clip.id}-${arm.name}`;
    if (names.has(name)) throw new Error("Duplicate case ID");
    names.add(name);
    if (!Number.isFinite(clip.seconds) || clip.seconds <= 0)
      throw new Error("Invalid clip duration");
    currentCase = name;
    await sdkLogs.run([], () => run(clip, arm));
    if (results.at(-1).errors.length)
      throw new Error("Replay validation failed");
  }
  save(
    "summary.json",
    results.map(({ events, warnings, ...r }) => ({
      ...r,
      sdkWarningCount: warnings.length,
      commits: events
        .filter((e: any) => e.type === "commit")
        .map((event: any) => {
          const e = { ...event };
          delete e.text;
          return { ...e, eligibleForTiming: e.atMs < r.seconds * 1000 };
        }),
      predictionCount: events.filter((e: any) => e.type === "prediction")
        .length,
      transcriptionTimeoutCount: events.filter(
        (e: any) => e.type === "transcription_timeout",
      ).length,
    })),
  );
} catch (error) {
  let message = String(error);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /key|token|secret|password/i.test(name))
      message = message.split(value).join("[redacted]");
  }
  save("failure.json", { case: currentCase, stage: currentStage, message });
  console.error(
    "Replay failed; inspect private artifacts. No transcript is printed here.",
  );
  process.exitCode = 1;
}
