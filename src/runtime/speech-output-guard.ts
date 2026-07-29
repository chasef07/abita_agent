import {
  DEFAULT_VOICE_LANGUAGE,
  type VoiceLanguage,
} from "./voice-language.js";

const BLOCKED_MARKERS = [
  "<system",
  "</system",
  "<instructions",
  "</instructions",
  "<think",
  "</think",
  "internal state:",
  "resolve_patient",
];
const SAFE_RECOVERY: Record<VoiceLanguage, string> = {
  en: "Sorry, let me rephrase that. How can I help?",
  es: "Perdón, déjeme decirlo de otra manera. ¿Cómo puedo ayudarle?",
};

type SpeechOutputGuardOptions = {
  language?: VoiceLanguage;
  onBlocked?: (marker: string) => void;
};

export async function* guardAssistantSpeech(
  chunks: AsyncIterable<string>,
  options: SpeechOutputGuardOptions = {},
): AsyncIterable<string> {
  let pending = "";

  for await (const chunk of chunks) {
    pending += chunk;
    const marker = blockedMarker(pending);
    if (marker) {
      options.onBlocked?.(marker);
      yield SAFE_RECOVERY[options.language ?? DEFAULT_VOICE_LANGUAGE];
      return;
    }

    const held = possibleMarkerPrefixLength(pending);
    const ready = pending.slice(0, pending.length - held);
    pending = pending.slice(pending.length - held);
    if (ready) yield ready;
  }

  if (pending) yield pending;
}

function blockedMarker(text: string): string | undefined {
  const normalized = text.toLowerCase();
  return BLOCKED_MARKERS.find((marker) => normalized.includes(marker));
}

function possibleMarkerPrefixLength(text: string): number {
  const normalized = text.toLowerCase();
  const maxLength = Math.min(
    normalized.length,
    Math.max(...BLOCKED_MARKERS.map((marker) => marker.length - 1)),
  );

  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = normalized.slice(-length);
    if (BLOCKED_MARKERS.some((marker) => marker.startsWith(suffix))) {
      return length;
    }
  }
  return 0;
}
