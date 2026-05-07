import { stt } from "@livekit/agents";
import { ReadableStream } from "node:stream/web";

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
  ttsOptionsByLanguage?: Partial<
    Record<VoiceLanguage, VoiceLanguageTtsOptions>
  >;
};

const LANGUAGE_EVENT_TYPES = new Set<stt.SpeechEventType>([
  stt.SpeechEventType.INTERIM_TRANSCRIPT,
  stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
  stt.SpeechEventType.FINAL_TRANSCRIPT,
]);

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

export class VoiceLanguageRuntime {
  private readonly initialLanguage: VoiceLanguage;
  private currentLanguage: VoiceLanguage;
  private languageSwitches = 0;
  private readonly observedLanguages = new Set<VoiceLanguage>();
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
    this.observedLanguages.add(defaultLanguage);
    this.ttsOptionsByLanguage = {
      en: {},
      es: {},
      ...options.ttsOptionsByLanguage,
    };
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

    if (
      event.type === stt.SpeechEventType.INTERIM_TRANSCRIPT &&
      !requestedLanguage &&
      detectedVoiceLanguage === "en" &&
      this.currentLanguage !== "en"
    ) {
      return this.currentLanguage;
    }

    if (detectedVoiceLanguage)
      this.observedLanguages.add(detectedVoiceLanguage);
    this.observedLanguages.add(voiceLanguage);

    const previousLanguage = this.currentLanguage;
    const languageChanged = voiceLanguage !== previousLanguage;
    if (languageChanged) {
      this.currentLanguage = voiceLanguage;
      this.languageSwitches += 1;
    }

    const ttsOptions = this.ttsOptionsByLanguage[voiceLanguage];
    if (languageChanged && Object.keys(ttsOptions).length > 0) {
      this.tts.updateOptions(ttsOptions);
    }

    if (languageChanged) {
      console.log(
        `[language] voice_language=${voiceLanguage} previous=${previousLanguage} detected=${detectedLanguage}`,
      );
    }

    return voiceLanguage;
  }

  observeSpeechEvents(
    events: ReadableStream<stt.SpeechEvent | string>,
  ): ReadableStream<stt.SpeechEvent | string> {
    return new ReadableStream<stt.SpeechEvent | string>({
      start: (controller) => {
        const reader = events.getReader();

        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }

              if (typeof value !== "string") {
                this.updateFromSpeechEvent(value);
              }
              controller.enqueue(value);
            }
          } catch (err) {
            controller.error(err);
          } finally {
            reader.releaseLock();
          }
        };

        void pump();
      },
      cancel: (reason) => events.cancel(reason),
    });
  }
}
