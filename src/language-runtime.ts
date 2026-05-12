import { stt } from "@livekit/agents";
import {
  ReadableStream,
  type ReadableStreamDefaultReader,
} from "node:stream/web";

export const DEFAULT_VOICE_LANGUAGE = "en";
export const SUPPORTED_VOICE_LANGUAGES = ["en", "es"] as const;

export type VoiceLanguage = (typeof SUPPORTED_VOICE_LANGUAGES)[number];

export type VoiceLanguageTelemetry = {
  initialLanguage: VoiceLanguage;
  currentLanguage: VoiceLanguage;
  languageSwitches: number;
  observedLanguages: VoiceLanguage[];
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

const ENGLISH_TURNS_TO_SWITCH_BACK = 2;

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

function hasSpanishTextEvidence(text: string): boolean {
  const normalizedText = normalizeSpeechText(text);
  return /\b(hablo|hablar|ingles|espanol|necesito|quiero|puedo|puede|ayuda|cita|seguro|tarjeta|llamar|llamo|nombre|telefono|direccion|nacimiento|gracias|favor|tengo|dolor|ojo|ojos|lentes|receta|medico|clinica|buenos|buenas)\b/.test(
    normalizedText,
  );
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

export class VoiceLanguageRuntime {
  private readonly initialLanguage: VoiceLanguage;
  private currentLanguage: VoiceLanguage;
  private preferredLanguage: VoiceLanguage | null = null;
  private englishEvidenceTurns = 0;
  private languageSwitches = 0;
  private readonly observedLanguages = new Set<VoiceLanguage>();
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
    this.ttsOptionsByLanguage = {
      en: {},
      es: {},
      ...options.ttsOptionsByLanguage,
    };
  }

  private applyTtsOptionsForLanguage(voiceLanguage: VoiceLanguage): void {
    const ttsOptions = this.ttsOptionsByLanguage[voiceLanguage];
    const ttsLanguageChanged = voiceLanguage !== this.appliedTtsLanguage;
    if (ttsLanguageChanged && Object.keys(ttsOptions).length > 0) {
      this.tts.updateOptions(ttsOptions);
      this.appliedTtsLanguage = voiceLanguage;
    }
  }

  private shouldAcceptSwitch(
    nextLanguage: VoiceLanguage,
    text: string,
    eventType: stt.SpeechEventType,
  ): boolean {
    const requestedLanguage = requestedVoiceLanguage(text);
    if (requestedLanguage) {
      this.preferredLanguage = requestedLanguage;
      this.englishEvidenceTurns = 0;
      return nextLanguage === requestedLanguage;
    }

    if (eventType === stt.SpeechEventType.INTERIM_TRANSCRIPT) return false;
    if (isWeakLanguageEvidence(text)) return false;
    if (contradictsDetectedLanguage(nextLanguage, text)) return false;

    if (this.preferredLanguage === "es" && nextLanguage === "en") {
      if (eventType !== stt.SpeechEventType.FINAL_TRANSCRIPT) return false;

      this.englishEvidenceTurns += 1;
      if (this.englishEvidenceTurns < ENGLISH_TURNS_TO_SWITCH_BACK) {
        return false;
      }
      this.preferredLanguage = "en";
      this.englishEvidenceTurns = 0;
      return true;
    }

    this.preferredLanguage = nextLanguage;
    this.englishEvidenceTurns = 0;
    return true;
  }

  private noteCurrentLanguageEvidence(
    currentLanguage: VoiceLanguage,
    detectedLanguage: VoiceLanguage | null,
    text: string,
  ): void {
    const requestedLanguage = requestedVoiceLanguage(text);
    if (requestedLanguage) {
      this.preferredLanguage = requestedLanguage;
      this.englishEvidenceTurns = 0;
      return;
    }

    if (this.preferredLanguage === "es" && detectedLanguage === "es") {
      this.englishEvidenceTurns = 0;
    }

    if (this.preferredLanguage === "en" && currentLanguage === "en") {
      this.englishEvidenceTurns = 0;
    }
  }

  get telemetry(): VoiceLanguageTelemetry {
    return {
      initialLanguage: this.initialLanguage,
      currentLanguage: this.currentLanguage,
      languageSwitches: this.languageSwitches,
      observedLanguages: [...this.observedLanguages],
    };
  }

  updateFromSpeechEvent(event: stt.SpeechEvent): VoiceLanguage | null {
    if (!LANGUAGE_EVENT_TYPES.has(event.type)) return null;

    const alternative = event.alternatives?.[0];
    const detectedLanguage = alternative?.language;
    const detectedVoiceLanguage = toSupportedVoiceLanguage(detectedLanguage);
    const requestedLanguage = requestedVoiceLanguage(alternative?.text ?? "");
    const voiceLanguage = requestedLanguage ?? detectedVoiceLanguage;
    if (!voiceLanguage) return null;
    const text = alternative?.text ?? "";

    if (detectedVoiceLanguage)
      this.observedLanguages.add(detectedVoiceLanguage);
    this.observedLanguages.add(voiceLanguage);

    if (voiceLanguage === this.currentLanguage) {
      this.noteCurrentLanguageEvidence(
        voiceLanguage,
        detectedVoiceLanguage,
        text,
      );
      this.applyTtsOptionsForLanguage(voiceLanguage);
      return voiceLanguage;
    }

    if (!this.shouldAcceptSwitch(voiceLanguage, text, event.type)) {
      return this.currentLanguage;
    }

    const previousLanguage = this.currentLanguage;
    this.currentLanguage = voiceLanguage;
    this.languageSwitches += 1;
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
