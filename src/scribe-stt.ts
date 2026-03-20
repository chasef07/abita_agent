// scribe-stt.ts — ElevenLabs Scribe STT adapter for LiveKit Agents
// Wraps the ElevenLabs ScribeRealtime WebSocket in LiveKit's STT interface.

import { stt, type LanguageCode } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { APIConnectOptions } from "@livekit/agents";
import {
  ElevenLabsClient,
  RealtimeEvents,
  AudioFormat,
  CommitStrategy,
} from "@elevenlabs/elevenlabs-js";

const SCRIBE_SAMPLE_RATE = 16000;

export interface ScribeSTTOptions {
  apiKey?: string;
  /** Language code (e.g. "en", "es"). Omit for automatic detection. */
  language?: string;
  modelId?: string;
}

export class ScribeSTT extends stt.STT {
  label = "elevenlabs-scribe";
  private apiKey: string;
  private language?: string;
  private modelId: string;

  constructor(opts?: ScribeSTTOptions) {
    super({
      streaming: true,
      interimResults: true,
    });
    this.apiKey = opts?.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
    this.language = opts?.language;
    this.modelId = opts?.modelId ?? "scribe_v2_realtime";
  }

  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error("Use stream() for Scribe STT");
  }

  stream(options?: { connOptions?: APIConnectOptions }): ScribeSpeechStream {
    return new ScribeSpeechStream(this, {
      apiKey: this.apiKey,
      language: this.language,
      modelId: this.modelId,
      connOptions: options?.connOptions,
    });
  }
}

interface ScribeStreamOpts {
  apiKey: string;
  language?: string;
  modelId: string;
  connOptions?: APIConnectOptions;
}

class ScribeSpeechStream extends stt.SpeechStream {
  label = "elevenlabs-scribe";
  private opts: ScribeStreamOpts;

  constructor(sttInstance: ScribeSTT, opts: ScribeStreamOpts) {
    super(sttInstance, SCRIBE_SAMPLE_RATE, opts.connOptions);
    this.opts = opts;
  }

  protected async run(): Promise<void> {
    const client = new ElevenLabsClient({ apiKey: this.opts.apiKey });

    const connection = await client.speechToText.realtime.connect({
      modelId: this.opts.modelId,
      audioFormat: AudioFormat.PCM_16000,
      sampleRate: SCRIBE_SAMPLE_RATE,
      commitStrategy: CommitStrategy.VAD,
      vadSilenceThresholdSecs: 1.5,
      vadThreshold: 0.5,
      minSpeechDurationMs: 200,
      minSilenceDurationMs: 500,
      ...(this.opts.language ? { languageCode: this.opts.language } : {}),
    });

    // Keepalive ping every 15s
    const keepalive = setInterval(() => {
      try {
        const ws = (connection as any).websocket;
        if (ws && ws.readyState === 1) ws.ping();
      } catch { /* ignore */ }
    }, 15_000);

    let ready = false;
    const pendingFrames: Buffer[] = [];

    connection.on(RealtimeEvents.SESSION_STARTED, () => {
      ready = true;
      for (const buf of pendingFrames) {
        connection.send({ audioBase64: buf.toString("base64") });
      }
      pendingFrames.length = 0;
    });

    connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
      if (data.text) {
        this.output.put({
          type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
          alternatives: [{
            text: data.text,
            language: ((data as any).language_code ?? this.opts.language ?? "en") as LanguageCode,
            startTime: 0,
            endTime: 0,
            confidence: 0.5,
          }],
        });
      }
    });

    let lastTranscript = "";
    connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
      if (data.text && data.text !== lastTranscript) {
        lastTranscript = data.text;
        this.output.put({
          type: stt.SpeechEventType.FINAL_TRANSCRIPT,
          alternatives: [{
            text: data.text,
            language: ((data as any).language_code ?? this.opts.language ?? "en") as LanguageCode,
            startTime: 0,
            endTime: 0,
            confidence: 0.95,
          }],
        });
      }
    });

    connection.on(RealtimeEvents.ERROR, (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scribe-stt] Error: ${message}`);
    });

    // Read audio frames from the pipeline and forward to Scribe
    try {
      for await (const frame of this.input) {
        if (this.closed) break;
        if (frame === (stt.SpeechStream as any).FLUSH_SENTINEL) {
          continue;
        }
        const audioFrame = frame as AudioFrame;
        const pcmBuffer = Buffer.from(audioFrame.data.buffer);
        if (ready) {
          connection.send({ audioBase64: pcmBuffer.toString("base64") });
        } else {
          pendingFrames.push(pcmBuffer);
        }
      }
    } finally {
      clearInterval(keepalive);
      connection.close();
    }
  }
}
