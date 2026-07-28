import { stt } from "@livekit/agents";
import {
  ReadableStream,
  type ReadableStreamDefaultReader,
} from "node:stream/web";

export const DEFAULT_VOICE_LANGUAGE = "en";
export const SUPPORTED_VOICE_LANGUAGES = ["en", "es"] as const;
export const LANGUAGE_SWITCH_CONFIDENCE_THRESHOLD = 0.6;
const MAX_LANGUAGE_KEEP_EVENTS = 50;

export type VoiceLanguage = (typeof SUPPORTED_VOICE_LANGUAGES)[number];

export type RimeVoiceLanguageOptions = {
  lang: "eng" | "spa";
  speaker: string;
};

export interface RuntimeVoiceLanguageState {
  current: VoiceLanguage;
  ttsProvider: "rime";
  ttsLanguage: RimeVoiceLanguageOptions["lang"];
  speaker: string;
  confidence?: number;
  providerCode?: string;
  updatedAt?: string;
}

export type VoiceLanguageSwitchEvent = {
  confidence?: number;
  createdAt: string;
  from: VoiceLanguage;
  providerCode: string;
  reason: "explicit_request" | "stt_detection";
  to: VoiceLanguage;
};

export type VoiceLanguageKeepEvent = {
  confidence?: number;
  createdAt: string;
  currentLanguage: VoiceLanguage;
  observedLanguage?: VoiceLanguage;
  providerCode?: string;
  reason:
    | "apply_failed"
    | "low_confidence"
    | "missing_confidence"
    | "same_language"
    | "unsupported";
};

export type VoiceLanguageTelemetry = {
  acceptedLanguages: VoiceLanguage[];
  candidateLanguage: VoiceLanguage | null;
  candidateTurns: number;
  currentLanguage: VoiceLanguage;
  initialLanguage: VoiceLanguage;
  keepEvents: VoiceLanguageKeepEvent[];
  languageChanged: boolean;
  languageSwitches: number;
  observedLanguages: VoiceLanguage[];
  switchEvents: VoiceLanguageSwitchEvent[];
};

export type VoiceLanguageSnapshot = {
  language: VoiceLanguageTelemetry;
  voiceLanguage: RuntimeVoiceLanguageState;
};

type TtsLanguageUpdater = {
  updateOptions(options: RimeVoiceLanguageOptions): void;
};

type SpeechAlternative = NonNullable<stt.SpeechEvent["alternatives"]>[number];

const LANGUAGE_TERMS: Record<VoiceLanguage, string> = {
  en: "english|ingles",
  es: "spanish|espanol|castellano",
};
const REQUEST_DIRECT_ACTIONS = "switch|change|continue|respond|answer|reply";
const REQUEST_MODAL_TERMS = "can|could|would|do|will";
const REQUEST_NEGATION = /\b(?:do not|does not|cannot|will not|not|never|no)\b/;
const REQUEST_PREFERENCE_ACTIONS = "speak|talk|use|continue|in|en";
const REQUEST_PREFERENCE_TERMS = "want|need|prefer|would like";
const REQUEST_SPANISH_ACTIONS = "habla|hablar|hable|hablemos";
const REQUEST_SPEECH_ACTIONS = "speak|talk|continue|respond|answer|reply";
const REQUEST_CLAUSE_ACTIONS = `${REQUEST_DIRECT_ACTIONS}|speak|talk|${REQUEST_SPANISH_ACTIONS}`;
const TRANSCRIPT_CLAUSE_SEPARATOR = new RegExp(
  `[.!?;:]+|\\b(?:but|however|pero)\\b|\\b(?:and|then|y)\\s+(?=(?:(?:${REQUEST_MODAL_TERMS})\\s+(?:(?:i|we|you)\\s+)?(?:${REQUEST_CLAUSE_ACTIONS})\\b|(?:i|we)\\s+(?:${REQUEST_PREFERENCE_TERMS})\\b|(?:please\\s+)?(?:${REQUEST_CLAUSE_ACTIONS})\\b))`,
);

export function createRimeVoiceLanguageState(
  language: VoiceLanguage,
  options: RimeVoiceLanguageOptions,
): RuntimeVoiceLanguageState {
  return {
    current: language,
    speaker: options.speaker,
    ttsLanguage: options.lang,
    ttsProvider: "rime",
  };
}

function normalizeVoiceLanguage(
  language?: string | null,
): VoiceLanguage | null {
  if (!language) return null;
  const baseLanguage = language.toLowerCase().split("-")[0];
  return SUPPORTED_VOICE_LANGUAGES.includes(baseLanguage as VoiceLanguage)
    ? (baseLanguage as VoiceLanguage)
    : null;
}

function readLanguageConfidence(
  alternative?: SpeechAlternative,
): number | null {
  const metadata = alternative?.metadata;
  if (!metadata || typeof metadata !== "object") return null;

  for (const source of [metadata.assemblyai, metadata]) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["languageConfidence", "language_confidence"]) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
}

function normalizeTranscriptClauses(text?: string): string[] {
  return (text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bdon['’]?t\b/g, "do not")
    .replace(/\bcan['’]?t\b/g, "cannot")
    .replace(/\bdoesn['’]?t\b/g, "does not")
    .replace(/\bwon['’]?t\b/g, "will not")
    .split(TRANSCRIPT_CLAUSE_SEPARATOR)
    .map((clause) =>
      clause
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

function requestedVoiceLanguage(text?: string): VoiceLanguage | null {
  const requested = new Set<VoiceLanguage>();
  for (const clause of normalizeTranscriptClauses(text)) {
    if (
      /\b(?:i|we) (?:do not|cannot) (?:speak|understand) (?:english|ingles)\b/.test(
        clause,
      ) ||
      /\bno hablo (?:english|ingles)\b/.test(clause)
    ) {
      requested.add("es");
    }
    if (
      /\b(?:i|we) (?:do not|cannot) (?:speak|understand) (?:spanish|espanol|castellano)\b/.test(
        clause,
      ) ||
      /\bno hablo (?:spanish|espanol|castellano)\b/.test(clause)
    ) {
      requested.add("en");
    }
    if (REQUEST_NEGATION.test(clause)) continue;

    for (const language of SUPPORTED_VOICE_LANGUAGES) {
      const terms = LANGUAGE_TERMS[language];
      const matchesRequest = [
        `^(?:${terms})(?: please| por favor)?$`,
        `\\b(?:${terms})\\s+(?:please|por favor)\\b`,
        `\\b(?:${REQUEST_DIRECT_ACTIONS})\\b.{0,80}\\b(?:in|en)?\\s*(?:${terms})\\b`,
        `\\b(?:${REQUEST_MODAL_TERMS})\\b.{0,80}\\b(?:${REQUEST_SPEECH_ACTIONS})\\b.{0,80}\\b(?:${terms})\\b`,
        `\\b(?:i|we)\\s+(?:${REQUEST_PREFERENCE_TERMS})\\b.{0,80}\\b(?:${REQUEST_PREFERENCE_ACTIONS})?\\b.{0,40}\\b(?:${terms})\\b`,
        `\\b(?:${REQUEST_SPANISH_ACTIONS})\\b.{0,80}\\b(?:${terms})\\b`,
      ].some((pattern) => new RegExp(pattern).test(clause));
      if (matchesRequest) requested.add(language);
    }
  }

  return requested.size === 1 ? [...requested][0] : null;
}

export class VoiceLanguageRuntime {
  private readonly acceptedLanguages: VoiceLanguage[];
  private readonly initialLanguage: VoiceLanguage;
  private readonly keepEvents: VoiceLanguageKeepEvent[] = [];
  private languageSwitches = 0;
  private readonly observedLanguages = new Set<VoiceLanguage>();
  private readonly optionsByLanguage: Record<
    VoiceLanguage,
    RimeVoiceLanguageOptions
  >;
  private readonly state: RuntimeVoiceLanguageState;
  private readonly switchEvents: VoiceLanguageSwitchEvent[] = [];
  private readonly tts: TtsLanguageUpdater;

  constructor(input: {
    optionsByLanguage: Record<VoiceLanguage, RimeVoiceLanguageOptions>;
    state: RuntimeVoiceLanguageState;
    tts: TtsLanguageUpdater;
  }) {
    this.acceptedLanguages = [input.state.current];
    this.initialLanguage = input.state.current;
    this.observedLanguages.add(input.state.current);
    this.optionsByLanguage = input.optionsByLanguage;
    this.state = input.state;
    this.tts = input.tts;
  }

  observe(
    events: ReadableStream<stt.SpeechEvent | string>,
  ): ReadableStream<stt.SpeechEvent | string> {
    let reader: ReadableStreamDefaultReader<stt.SpeechEvent | string> | null =
      null;
    let cancelled = false;
    let upstreamDone = false;

    return new ReadableStream<stt.SpeechEvent | string>({
      start: (controller) => {
        const activeReader = events.getReader();
        reader = activeReader;
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await activeReader.read();
              if (done) {
                upstreamDone = true;
                if (!cancelled) controller.close();
                return;
              }
              if (typeof value !== "string") this.observeSpeechEvent(value);
              controller.enqueue(value);
            }
          } catch (error) {
            if (!cancelled) controller.error(error);
          } finally {
            activeReader.releaseLock();
            if (reader === activeReader) reader = null;
          }
        };
        void pump();
      },
      cancel: async (reason) => {
        cancelled = true;
        if (reader) {
          await reader.cancel(reason);
          return;
        }
        if (!upstreamDone) await events.cancel(reason);
      },
    });
  }

  snapshot(): VoiceLanguageSnapshot {
    return {
      language: {
        acceptedLanguages: [...this.acceptedLanguages],
        candidateLanguage: null,
        candidateTurns: 0,
        currentLanguage: this.state.current,
        initialLanguage: this.initialLanguage,
        keepEvents: [...this.keepEvents],
        languageChanged: this.languageSwitches > 0,
        languageSwitches: this.languageSwitches,
        observedLanguages: [...this.observedLanguages],
        switchEvents: [...this.switchEvents],
      },
      voiceLanguage: { ...this.state },
    };
  }

  private observeSpeechEvent(event: stt.SpeechEvent): void {
    if (event.type !== stt.SpeechEventType.FINAL_TRANSCRIPT) return;

    const alternative = event.alternatives?.[0];
    const providerCode = alternative?.language ?? "";
    const requestedLanguage = requestedVoiceLanguage(alternative?.text);
    const observedLanguage = normalizeVoiceLanguage(providerCode);
    const language = requestedLanguage ?? observedLanguage;
    const confidence = readLanguageConfidence(alternative);
    if (!language) {
      this.keep("unsupported", {
        ...(providerCode ? { providerCode } : {}),
      });
      return;
    }
    this.observedLanguages.add(language);
    if (!requestedLanguage && confidence === null) {
      this.keep("missing_confidence", {
        observedLanguage: language,
        providerCode,
      });
      return;
    }
    if (
      !requestedLanguage &&
      confidence !== null &&
      confidence < LANGUAGE_SWITCH_CONFIDENCE_THRESHOLD
    ) {
      this.keep("low_confidence", {
        confidence,
        observedLanguage: language,
        providerCode,
      });
      return;
    }
    if (language === this.state.current) {
      this.keep("same_language", {
        ...(confidence !== null ? { confidence } : {}),
        observedLanguage: language,
        ...(providerCode ? { providerCode } : {}),
      });
      return;
    }

    const previousLanguage = this.state.current;
    const options = this.optionsByLanguage[language];
    try {
      this.tts.updateOptions(options);
    } catch {
      this.keep("apply_failed", {
        ...(confidence !== null ? { confidence } : {}),
        observedLanguage: language,
        providerCode,
      });
      console.warn("[language] TTS language update failed");
      return;
    }
    Object.assign(this.state, {
      ...createRimeVoiceLanguageState(language, options),
      providerCode,
      updatedAt: new Date().toISOString(),
    });
    if (confidence === null) {
      delete this.state.confidence;
    } else {
      this.state.confidence = confidence;
    }
    this.languageSwitches += 1;
    this.acceptedLanguages.push(language);
    const switchEvent: VoiceLanguageSwitchEvent = {
      createdAt: this.state.updatedAt!,
      from: previousLanguage,
      providerCode,
      reason: requestedLanguage ? "explicit_request" : "stt_detection",
      to: language,
    };
    if (confidence !== null) switchEvent.confidence = confidence;
    this.switchEvents.push(switchEvent);
    console.log(
      `[language] applied_tts_options provider=rime voice_language=${language} tts_language=${options.lang} speaker=${options.speaker}`,
    );
  }

  private keep(
    reason: VoiceLanguageKeepEvent["reason"],
    details: Omit<
      VoiceLanguageKeepEvent,
      "createdAt" | "currentLanguage" | "reason"
    > = {},
  ): void {
    this.keepEvents.push({
      createdAt: new Date().toISOString(),
      currentLanguage: this.state.current,
      reason,
      ...details,
    });
    if (this.keepEvents.length > MAX_LANGUAGE_KEEP_EVENTS) {
      this.keepEvents.splice(
        0,
        this.keepEvents.length - MAX_LANGUAGE_KEEP_EVENTS,
      );
    }
  }
}
