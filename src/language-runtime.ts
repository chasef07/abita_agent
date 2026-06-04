import { stt } from "@livekit/agents";
import {
  ReadableStream,
  type ReadableStreamDefaultReader,
} from "node:stream/web";

export const DEFAULT_VOICE_LANGUAGE = "en";
export const SUPPORTED_VOICE_LANGUAGES = ["en", "es"] as const;
export const LANGUAGE_SWITCH_CONFIDENCE_THRESHOLD = 0.8;
export const CONSECUTIVE_TURNS_TO_SWITCH_LANGUAGE = 2;

export type VoiceLanguage = (typeof SUPPORTED_VOICE_LANGUAGES)[number];

export type VoiceLanguageSwitchReason =
  | "explicit_request"
  | "strong_text_evidence"
  | "stt_detection";

export type VoiceLanguageSwitchEvent = {
  createdAt: string;
  detectedLanguage?: string;
  from: VoiceLanguage;
  languageConfidence?: number;
  reason: VoiceLanguageSwitchReason;
  to: VoiceLanguage;
};

export type VoiceLanguageTelemetry = {
  acceptedLanguages: VoiceLanguage[];
  initialLanguage: VoiceLanguage;
  currentLanguage: VoiceLanguage;
  languageChanged: boolean;
  languageSwitches: number;
  observedLanguages: VoiceLanguage[];
  switchEvents: VoiceLanguageSwitchEvent[];
};

export type VoiceLanguageTtsOptions = Record<
  string,
  string | number | boolean | undefined
>;

export type TtsLanguageUpdater = {
  updateOptions(options: VoiceLanguageTtsOptions): void;
};

type VoiceLanguageRuntimeOptions = {
  defaultLanguage?: VoiceLanguage;
  appliedTtsLanguage?: VoiceLanguage;
  ttsOptionsByLanguage?: Partial<
    Record<VoiceLanguage, VoiceLanguageTtsOptions>
  >;
};

const LANGUAGE_EVENT_TYPES = new Set<stt.SpeechEventType>([
  stt.SpeechEventType.INTERIM_TRANSCRIPT,
  stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
  stt.SpeechEventType.FINAL_TRANSCRIPT,
]);

type SpeechAlternative = NonNullable<stt.SpeechEvent["alternatives"]>[number];

function toSupportedVoiceLanguage(
  language?: string | null,
): VoiceLanguage | null {
  if (!language) return null;

  const baseLanguage = language.toLowerCase().split("-")[0];
  return SUPPORTED_VOICE_LANGUAGES.includes(baseLanguage as VoiceLanguage)
    ? (baseLanguage as VoiceLanguage)
    : null;
}

function normalizeSpeechText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readMetadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | null {
  if (!metadata) return null;
  return toFiniteNumber(metadata[key]);
}

function getLanguageConfidence(alternative?: SpeechAlternative): number | null {
  if (!alternative) return null;

  const metadata = alternative.metadata;
  const directConfidence =
    readMetadataNumber(metadata, "languageConfidence") ??
    readMetadataNumber(metadata, "language_confidence");
  if (directConfidence !== null) return directConfidence;

  const assemblyai = metadata?.assemblyai;
  if (isRecord(assemblyai)) {
    return (
      toFiniteNumber(assemblyai.languageConfidence) ??
      toFiniteNumber(assemblyai.language_confidence)
    );
  }

  return null;
}

function requestedVoiceLanguage(text: string): VoiceLanguage | null {
  const normalizedText = normalizeSpeechText(text);

  if (
    /\b(no hablo ingles|i don t speak english|i do not speak english)\b/.test(
      normalizedText,
    )
  ) {
    return "es";
  }

  if (
    /\b(no hablo espanol|no hablo spanish|i don t speak spanish|i do not speak spanish)\b/.test(
      normalizedText,
    )
  ) {
    return "en";
  }

  if (
    /\b(do you speak spanish|can you speak spanish|could you speak spanish|speak spanish|spanish please|in spanish|habla espanol|hablas espanol|puede hablar espanol|podemos hablar espanol|prefiero hablar en espanol|en espanol)\b/.test(
      normalizedText,
    )
  ) {
    return "es";
  }

  if (
    /\b(do you speak english|can you speak english|could you speak english|speak english|english please|in english|habla ingles|hablas ingles|puede hablar ingles|podemos hablar ingles|prefiero hablar en ingles|en ingles)\b/.test(
      normalizedText,
    )
  ) {
    return "en";
  }

  return null;
}

function isWeakLanguageEvidence(text: string): boolean {
  const normalizedText = normalizeSpeechText(text);
  if (!normalizedText || normalizedText.length < 8) return true;

  if (
    /^(yes|yeah|yep|ok|okay|mm hmm|mhm|uh huh|si|no|huh|uh|um|ah|eh)\b/.test(
      normalizedText,
    )
  ) {
    return true;
  }

  if (/^[\d\s,.-]+$/.test(normalizedText)) return true;

  const compactText = normalizedText.replace(/[^a-z0-9]/g, "");
  if (/\d/.test(compactText) && compactText.length <= 20) return true;

  const words = normalizedText.split(/\s+/).filter(Boolean);
  return words.length <= 2 && normalizedText.length < 18;
}

const SPANISH_TEXT_EVIDENCE_PATTERN =
  /\b(hablo|hablar|ingles|espanol|necesito|quiero|puedo|puede|ayuda|cita|seguro|tarjeta|llamar|llamo|nombre|telefono|direccion|nacimiento|gracias|favor|tengo|dolor|ojo|ojos|lentes|receta|medico|clinica|buenos|buenas)\b/g;

function countSpanishTextEvidence(text: string): number {
  const normalizedText = normalizeSpeechText(text);
  return [...normalizedText.matchAll(SPANISH_TEXT_EVIDENCE_PATTERN)].length;
}

function hasSpanishTextEvidence(text: string): boolean {
  return countSpanishTextEvidence(text) > 0;
}

function hasStrongSpanishTextEvidence(text: string): boolean {
  return countSpanishTextEvidence(text) >= 2;
}

function hasEnglishTextEvidence(text: string): boolean {
  const normalizedText = normalizeSpeechText(text);
  return /\b(i|i m|need|help|schedule|appointment|insurance|english|can|could|would|please|my|the|to|call|name|phone|birth|date|address|glasses|contacts|eye|eyes)\b/.test(
    normalizedText,
  );
}

function contradictsDetectedLanguage(
  detectedLanguage: VoiceLanguage,
  text: string,
): boolean {
  if (detectedLanguage === "es") {
    return hasEnglishTextEvidence(text) && !hasSpanishTextEvidence(text);
  }

  return hasSpanishTextEvidence(text) && !hasEnglishTextEvidence(text);
}

function inferVoiceLanguageFromText(text: string): VoiceLanguage | null {
  if (hasStrongSpanishTextEvidence(text)) return "es";
  if (isWeakLanguageEvidence(text)) return null;

  if (hasEnglishTextEvidence(text) && !hasSpanishTextEvidence(text))
    return "en";

  return null;
}

export class VoiceLanguageRuntime {
  private readonly initialLanguage: VoiceLanguage;
  private currentLanguage: VoiceLanguage;
  private pendingLanguage: VoiceLanguage | null = null;
  private pendingLanguageTurns = 0;
  private languageSwitches = 0;
  private readonly observedLanguages = new Set<VoiceLanguage>();
  private readonly acceptedLanguages: VoiceLanguage[];
  private readonly switchEvents: VoiceLanguageSwitchEvent[] = [];
  private appliedTtsLanguage: VoiceLanguage | null;
  private readonly ttsOptionsByLanguage: Record<
    VoiceLanguage,
    VoiceLanguageTtsOptions
  >;

  constructor(
    private readonly tts: TtsLanguageUpdater,
    options: VoiceLanguageRuntimeOptions = {},
  ) {
    const defaultLanguage = options.defaultLanguage ?? DEFAULT_VOICE_LANGUAGE;
    this.initialLanguage = defaultLanguage;
    this.currentLanguage = defaultLanguage;
    this.appliedTtsLanguage = options.appliedTtsLanguage ?? null;
    this.observedLanguages.add(defaultLanguage);
    this.acceptedLanguages = [defaultLanguage];
    this.ttsOptionsByLanguage = {
      en: {},
      es: {},
      ...options.ttsOptionsByLanguage,
    };
  }

  private resetPendingLanguage(): void {
    this.pendingLanguage = null;
    this.pendingLanguageTurns = 0;
  }

  private applyTtsOptionsForLanguage(voiceLanguage: VoiceLanguage): void {
    const ttsOptions = this.ttsOptionsByLanguage[voiceLanguage];
    const ttsLanguageChanged = voiceLanguage !== this.appliedTtsLanguage;
    if (ttsLanguageChanged && Object.keys(ttsOptions).length > 0) {
      this.tts.updateOptions(ttsOptions);
      this.appliedTtsLanguage = voiceLanguage;
      const providerLanguage = ttsOptions.language ?? ttsOptions.lang ?? "";
      const providerVoice = ttsOptions.voice ?? ttsOptions.speaker ?? "";
      console.log(
        `[language] applied_tts_options voice_language=${voiceLanguage} tts_language=${String(providerLanguage)} voice=${String(providerVoice)}`,
      );
    }
  }

  private shouldAcceptSwitch(
    nextLanguage: VoiceLanguage,
    text: string,
    eventType: stt.SpeechEventType,
    languageConfidence: number | null,
  ): boolean {
    if (eventType !== stt.SpeechEventType.FINAL_TRANSCRIPT) return false;

    const requestedLanguage = requestedVoiceLanguage(text);
    if (requestedLanguage) {
      this.resetPendingLanguage();
      return nextLanguage === requestedLanguage;
    }

    const strongSpanishSwitch =
      nextLanguage === "es" && hasStrongSpanishTextEvidence(text);

    if (
      (languageConfidence !== null &&
        languageConfidence < LANGUAGE_SWITCH_CONFIDENCE_THRESHOLD) ||
      (isWeakLanguageEvidence(text) && !strongSpanishSwitch) ||
      contradictsDetectedLanguage(nextLanguage, text)
    ) {
      this.resetPendingLanguage();
      return false;
    }

    if (
      this.currentLanguage === "en" &&
      nextLanguage === "es" &&
      strongSpanishSwitch
    ) {
      this.resetPendingLanguage();
      return true;
    }

    if (this.pendingLanguage === nextLanguage) {
      this.pendingLanguageTurns += 1;
    } else {
      this.pendingLanguage = nextLanguage;
      this.pendingLanguageTurns = 1;
    }

    if (this.pendingLanguageTurns < CONSECUTIVE_TURNS_TO_SWITCH_LANGUAGE)
      return false;

    this.resetPendingLanguage();
    return true;
  }

  private noteCurrentLanguageEvidence(
    currentLanguage: VoiceLanguage,
    detectedLanguage: VoiceLanguage | null,
    text: string,
    eventType: stt.SpeechEventType,
  ): void {
    const requestedLanguage = requestedVoiceLanguage(text);
    if (requestedLanguage) {
      this.resetPendingLanguage();
      return;
    }

    if (
      eventType === stt.SpeechEventType.FINAL_TRANSCRIPT &&
      detectedLanguage === currentLanguage
    ) {
      this.resetPendingLanguage();
    }
  }

  get telemetry(): VoiceLanguageTelemetry {
    return {
      acceptedLanguages: [...this.acceptedLanguages],
      initialLanguage: this.initialLanguage,
      currentLanguage: this.currentLanguage,
      languageChanged: this.languageSwitches > 0,
      languageSwitches: this.languageSwitches,
      observedLanguages: [...this.observedLanguages],
      switchEvents: [...this.switchEvents],
    };
  }

  updateFromSpeechEvent(event: stt.SpeechEvent): VoiceLanguage | null {
    if (!LANGUAGE_EVENT_TYPES.has(event.type)) return null;

    const alternative = event.alternatives?.[0];
    const detectedLanguage = alternative?.language;
    const detectedVoiceLanguage = toSupportedVoiceLanguage(detectedLanguage);
    const text = alternative?.text ?? "";
    const requestedLanguage = requestedVoiceLanguage(text);
    const inferredVoiceLanguage = inferVoiceLanguageFromText(text);
    const voiceLanguage =
      requestedLanguage ??
      detectedVoiceLanguage ??
      (detectedLanguage ? null : inferredVoiceLanguage);
    if (!voiceLanguage) return null;
    const languageConfidence = getLanguageConfidence(alternative);
    const switchReason: VoiceLanguageSwitchReason = requestedLanguage
      ? "explicit_request"
      : voiceLanguage === "es" && hasStrongSpanishTextEvidence(text)
        ? "strong_text_evidence"
        : inferredVoiceLanguage === voiceLanguage && !detectedVoiceLanguage
          ? "strong_text_evidence"
          : "stt_detection";

    if (detectedVoiceLanguage)
      this.observedLanguages.add(detectedVoiceLanguage);
    this.observedLanguages.add(voiceLanguage);

    if (voiceLanguage === this.currentLanguage) {
      this.noteCurrentLanguageEvidence(
        voiceLanguage,
        detectedVoiceLanguage,
        text,
        event.type,
      );
      if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT)
        this.applyTtsOptionsForLanguage(voiceLanguage);
      return voiceLanguage;
    }

    if (
      !this.shouldAcceptSwitch(
        voiceLanguage,
        text,
        event.type,
        languageConfidence,
      )
    ) {
      return this.currentLanguage;
    }

    const previousLanguage = this.currentLanguage;
    this.currentLanguage = voiceLanguage;
    this.languageSwitches += 1;
    this.acceptedLanguages.push(voiceLanguage);
    this.switchEvents.push({
      createdAt: new Date().toISOString(),
      ...(detectedLanguage ? { detectedLanguage } : {}),
      from: previousLanguage,
      ...(languageConfidence !== null ? { languageConfidence } : {}),
      reason: switchReason,
      to: voiceLanguage,
    });
    this.applyTtsOptionsForLanguage(voiceLanguage);

    console.log(
      `[language] voice_language=${voiceLanguage} previous=${previousLanguage} detected=${detectedLanguage}`,
    );

    return voiceLanguage;
  }

  observeSpeechEvents(
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

              if (typeof value !== "string") {
                this.updateFromSpeechEvent(value);
              }
              controller.enqueue(value);
            }
          } catch (err) {
            if (!cancelled) controller.error(err);
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
}
