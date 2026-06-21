import { stt } from "@livekit/agents";
import {
  ReadableStream,
  type ReadableStreamDefaultReader,
} from "node:stream/web";

export const DEFAULT_VOICE_LANGUAGE = "en";
export const SUPPORTED_VOICE_LANGUAGES = ["en", "es"] as const;
export const LANGUAGE_SWITCH_CONFIDENCE_THRESHOLD = 0.6;
export const CONSECUTIVE_ENGLISH_TURNS_TO_SWITCH_BACK = 2;
const MAX_LANGUAGE_KEEP_EVENTS = 50;

export type VoiceLanguage = (typeof SUPPORTED_VOICE_LANGUAGES)[number];
export type SttLanguageSwitchReason = "explicit_request" | "stt_detection";

export type SttLanguageKeepReason =
  | "non_final"
  | "unsupported"
  | "missing_confidence"
  | "low_confidence"
  | "same_language"
  | "sticky_window";

export type SttLanguageSwitchEvent = {
  confidence?: number;
  createdAt: string;
  from: VoiceLanguage;
  providerCode: string;
  reason: SttLanguageSwitchReason;
  to: VoiceLanguage;
};

export type SttLanguageKeepEvent = {
  candidateLanguage?: VoiceLanguage;
  candidateTurns?: number;
  confidence?: number;
  createdAt: string;
  currentLanguage: VoiceLanguage;
  observedLanguage?: VoiceLanguage;
  providerCode?: string;
  reason: SttLanguageKeepReason;
};

export type SttLanguageDecision =
  | {
      action: "keep";
      currentLanguage: VoiceLanguage;
      reason: SttLanguageKeepReason;
      candidateLanguage?: VoiceLanguage;
      candidateTurns?: number;
      confidence?: number;
      observedLanguage?: VoiceLanguage;
      providerCode?: string;
    }
  | {
      action: "switch";
      confidence?: number;
      from: VoiceLanguage;
      providerCode: string;
      reason: SttLanguageSwitchReason;
      to: VoiceLanguage;
    };

export type SttLanguageTelemetry = {
  acceptedLanguages: VoiceLanguage[];
  candidateLanguage: VoiceLanguage | null;
  candidateTurns: number;
  currentLanguage: VoiceLanguage;
  initialLanguage: VoiceLanguage;
  keepEvents: SttLanguageKeepEvent[];
  languageChanged: boolean;
  languageSwitches: number;
  observedLanguages: VoiceLanguage[];
  switchEvents: SttLanguageSwitchEvent[];
};

type SpeechAlternative = NonNullable<stt.SpeechEvent["alternatives"]>[number];

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

export function normalizeVoiceLanguage(
  language?: string | null,
): VoiceLanguage | null {
  if (!language) return null;

  const baseLanguage = language.toLowerCase().split("-")[0];
  return SUPPORTED_VOICE_LANGUAGES.includes(baseLanguage as VoiceLanguage)
    ? (baseLanguage as VoiceLanguage)
    : null;
}

export function readAssemblyAiLanguageConfidence(
  alternative?: SpeechAlternative,
): number | null {
  const assemblyai = alternative?.metadata?.assemblyai;
  if (!isRecord(assemblyai)) return null;

  return (
    toFiniteNumber(assemblyai.languageConfidence) ??
    toFiniteNumber(assemblyai.language_confidence)
  );
}

const LANGUAGE_REQUEST_TERMS: Record<VoiceLanguage, string> = {
  en: "english|ingles",
  es: "spanish|espanol|castellano",
};

function normalizeTranscriptText(text?: string): string {
  return (text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasNegatedLanguageMention(
  normalizedText: string,
  language: VoiceLanguage,
): boolean {
  const terms = LANGUAGE_REQUEST_TERMS[language];
  return new RegExp(
    `\\b(?:do not|dont|does not|doesnt|cannot|cant|not|never|no)\\b.{0,30}\\b(?:speak|talk|want|need|prefer|use|continue|respond|answer|reply)?\\b.{0,30}\\b(?:${terms})\\b`,
  ).test(normalizedText);
}

function isExplicitLanguageRequest(
  normalizedText: string,
  language: VoiceLanguage,
): boolean {
  if (!normalizedText || hasNegatedLanguageMention(normalizedText, language)) {
    return false;
  }

  const terms = LANGUAGE_REQUEST_TERMS[language];
  const requestPatterns = [
    `^(?:${terms})(?: please| por favor)?$`,
    `\\b(?:${terms})\\s+(?:please|por favor)\\b`,
    `\\b(?:in|en)\\s+(?:${terms})\\s+(?:please|por favor)\\b`,
    `\\b(?:switch|change|continue|respond|answer|reply)\\b.{0,80}\\b(?:in|en)?\\s*(?:${terms})\\b`,
    `\\b(?:can|could|would|do|will)\\b.{0,80}\\b(?:speak|talk|continue|respond|answer|reply)\\b.{0,80}\\b(?:${terms})\\b`,
    `\\b(?:i|we)\\s+(?:want|need|prefer|would like)\\b.{0,80}\\b(?:speak|talk|use|continue|in|en)?\\b.{0,40}\\b(?:${terms})\\b`,
    `\\b(?:habla|hablar|hable|hablemos)\\b.{0,80}\\b(?:${terms})\\b`,
  ];

  return requestPatterns.some((pattern) =>
    new RegExp(pattern).test(normalizedText),
  );
}

function requestedVoiceLanguage(text?: string): VoiceLanguage | null {
  const normalizedText = normalizeTranscriptText(text);
  const requestedLanguages = SUPPORTED_VOICE_LANGUAGES.filter((language) =>
    isExplicitLanguageRequest(normalizedText, language),
  );

  return requestedLanguages.length === 1 ? requestedLanguages[0] : null;
}

function requiredTurnsToSwitchLanguage(
  from: VoiceLanguage,
  to: VoiceLanguage,
): number {
  if (from === "en" && to === "es") return 1;
  return CONSECUTIVE_ENGLISH_TURNS_TO_SWITCH_BACK;
}

export class SttLanguageDetector {
  private readonly initialLanguage: VoiceLanguage;
  private currentLanguage: VoiceLanguage;
  private candidateLanguage: VoiceLanguage | null = null;
  private candidateTurns = 0;
  private languageSwitches = 0;
  private readonly observedLanguages = new Set<VoiceLanguage>();
  private readonly acceptedLanguages: VoiceLanguage[];
  private readonly switchEvents: SttLanguageSwitchEvent[] = [];
  private readonly keepEvents: SttLanguageKeepEvent[] = [];

  constructor(
    options: {
      defaultLanguage?: VoiceLanguage;
    } = {},
  ) {
    const defaultLanguage = options.defaultLanguage ?? DEFAULT_VOICE_LANGUAGE;
    this.initialLanguage = defaultLanguage;
    this.currentLanguage = defaultLanguage;
    this.observedLanguages.add(defaultLanguage);
    this.acceptedLanguages = [defaultLanguage];
  }

  get telemetry(): SttLanguageTelemetry {
    return {
      acceptedLanguages: [...this.acceptedLanguages],
      candidateLanguage: this.candidateLanguage,
      candidateTurns: this.candidateTurns,
      currentLanguage: this.currentLanguage,
      initialLanguage: this.initialLanguage,
      keepEvents: [...this.keepEvents],
      languageChanged: this.languageSwitches > 0,
      languageSwitches: this.languageSwitches,
      observedLanguages: [...this.observedLanguages],
      switchEvents: [...this.switchEvents],
    };
  }

  private resetCandidate(): void {
    this.candidateLanguage = null;
    this.candidateTurns = 0;
  }

  private keepLanguage(
    input: Omit<SttLanguageKeepEvent, "createdAt" | "currentLanguage">,
  ): Extract<SttLanguageDecision, { action: "keep" }> {
    const decision: Extract<SttLanguageDecision, { action: "keep" }> = {
      action: "keep",
      currentLanguage: this.currentLanguage,
      reason: input.reason,
      ...(input.candidateLanguage !== undefined
        ? { candidateLanguage: input.candidateLanguage }
        : {}),
      ...(input.candidateTurns !== undefined
        ? { candidateTurns: input.candidateTurns }
        : {}),
      ...(input.confidence !== undefined
        ? { confidence: input.confidence }
        : {}),
      ...(input.observedLanguage !== undefined
        ? { observedLanguage: input.observedLanguage }
        : {}),
      ...(input.providerCode ? { providerCode: input.providerCode } : {}),
    };

    if (input.reason !== "non_final") {
      const keepEvent: SttLanguageKeepEvent = {
        reason: input.reason,
        createdAt: new Date().toISOString(),
        currentLanguage: this.currentLanguage,
        ...(input.candidateLanguage !== undefined
          ? { candidateLanguage: input.candidateLanguage }
          : {}),
        ...(input.candidateTurns !== undefined
          ? { candidateTurns: input.candidateTurns }
          : {}),
        ...(input.confidence !== undefined
          ? { confidence: input.confidence }
          : {}),
        ...(input.observedLanguage !== undefined
          ? { observedLanguage: input.observedLanguage }
          : {}),
        ...(input.providerCode ? { providerCode: input.providerCode } : {}),
      };

      this.keepEvents.push(keepEvent);
      if (this.keepEvents.length > MAX_LANGUAGE_KEEP_EVENTS) {
        this.keepEvents.splice(
          0,
          this.keepEvents.length - MAX_LANGUAGE_KEEP_EVENTS,
        );
      }
    }

    return decision;
  }

  updateFromSpeechEvent(event: stt.SpeechEvent): SttLanguageDecision {
    if (event.type !== stt.SpeechEventType.FINAL_TRANSCRIPT) {
      return this.keepLanguage({ reason: "non_final" });
    }

    const alternative = event.alternatives?.[0];
    const providerCode = alternative?.language ?? "";
    const confidence = readAssemblyAiLanguageConfidence(alternative);
    const requestedLanguage = requestedVoiceLanguage(alternative?.text);
    if (requestedLanguage) {
      this.observedLanguages.add(requestedLanguage);
      if (requestedLanguage === this.currentLanguage) {
        this.resetCandidate();
        return this.keepLanguage({
          observedLanguage: requestedLanguage,
          ...(providerCode ? { providerCode } : {}),
          reason: "same_language",
        });
      }

      return this.switchLanguage({
        confidence,
        providerCode,
        reason: "explicit_request",
        to: requestedLanguage,
      });
    }

    const observedLanguage = normalizeVoiceLanguage(providerCode);
    if (!observedLanguage) {
      this.resetCandidate();
      return this.keepLanguage({
        reason: "unsupported",
        ...(providerCode ? { providerCode } : {}),
      });
    }
    this.observedLanguages.add(observedLanguage);

    if (confidence === null) {
      this.resetCandidate();
      return this.keepLanguage({
        observedLanguage,
        providerCode,
        reason: "missing_confidence",
      });
    }

    if (confidence < LANGUAGE_SWITCH_CONFIDENCE_THRESHOLD) {
      this.resetCandidate();
      return this.keepLanguage({
        confidence,
        observedLanguage,
        providerCode,
        reason: "low_confidence",
      });
    }

    if (observedLanguage === this.currentLanguage) {
      this.resetCandidate();
      return this.keepLanguage({
        confidence,
        observedLanguage,
        providerCode,
        reason: "same_language",
      });
    }

    if (this.candidateLanguage === observedLanguage) {
      this.candidateTurns += 1;
    } else {
      this.candidateLanguage = observedLanguage;
      this.candidateTurns = 1;
    }

    const requiredTurns = requiredTurnsToSwitchLanguage(
      this.currentLanguage,
      observedLanguage,
    );
    if (this.candidateTurns < requiredTurns) {
      return this.keepLanguage({
        candidateLanguage: this.candidateLanguage,
        candidateTurns: this.candidateTurns,
        confidence,
        observedLanguage,
        providerCode,
        reason: "sticky_window",
      });
    }

    return this.switchLanguage({
      confidence,
      providerCode,
      reason: "stt_detection",
      to: observedLanguage,
    });
  }

  private switchLanguage(input: {
    confidence: number | null;
    providerCode: string;
    reason: SttLanguageSwitchReason;
    to: VoiceLanguage;
  }): Extract<SttLanguageDecision, { action: "switch" }> {
    const previousLanguage = this.currentLanguage;
    this.currentLanguage = input.to;
    this.languageSwitches += 1;
    this.acceptedLanguages.push(input.to);
    const switchEvent: SttLanguageSwitchEvent = {
      createdAt: new Date().toISOString(),
      from: previousLanguage,
      providerCode: input.providerCode,
      reason: input.reason,
      to: input.to,
    };
    if (input.confidence !== null) switchEvent.confidence = input.confidence;
    this.switchEvents.push(switchEvent);
    this.resetCandidate();

    return {
      action: "switch",
      from: previousLanguage,
      providerCode: input.providerCode,
      reason: input.reason,
      to: input.to,
      ...(input.confidence !== null ? { confidence: input.confidence } : {}),
    };
  }
}

export function observeSttLanguage(
  events: ReadableStream<stt.SpeechEvent | string>,
  detector: SttLanguageDetector,
  onDecision?: (decision: SttLanguageDecision) => void,
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
              const decision = detector.updateFromSpeechEvent(value);
              try {
                onDecision?.(decision);
              } catch (err) {
                console.warn("[language] decision handler failed:", err);
              }
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
