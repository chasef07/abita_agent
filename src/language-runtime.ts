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

    const detectedLanguage = event.alternatives?.[0]?.language;
    const voiceLanguage = toSupportedVoiceLanguage(detectedLanguage);
    if (!voiceLanguage) return null;

    this.observedLanguages.add(voiceLanguage);
    if (voiceLanguage === this.currentLanguage) return voiceLanguage;

    const previousLanguage = this.currentLanguage;
    this.currentLanguage = voiceLanguage;
    this.languageSwitches += 1;
    const ttsOptions = this.ttsOptionsByLanguage[voiceLanguage];
    if (Object.keys(ttsOptions).length > 0) {
      this.tts.updateOptions(ttsOptions);
    }

    console.log(
      `[language] voice_language=${voiceLanguage} previous=${previousLanguage} detected=${detectedLanguage}`,
    );

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
