import {
  DEFAULT_VOICE_LANGUAGE,
  type VoiceLanguage,
} from "./voice-language.js";

const PROMPT_MARKERS = [
  "<system",
  "</system",
  "<instructions",
  "</instructions",
  "<think",
  "</think",
  "<role",
  "</role",
  "<voice",
  "</voice",
  "<caller_identity_policy",
  "</caller_identity_policy",
  "internal state:",
  "[system]",
  "system message:",
  "single_match",
  "multiple_matches",
  "no_match",
  "lookup_failed",
];
const TOOL_MARKERS = [
  "resolve_patient",
  "add_patient",
  "update_insurance",
  "get_availability",
  "cancel_appointment",
  "book_appointment",
  "reschedule_appointment",
  "check_insurance",
  "transfer_call",
  "end_call",
  "create_staff_task",
  "lk_agents_cancel_task",
  "lk_agents_get_running_tasks",
];
const BLOCKED_MARKERS = [...PROMPT_MARKERS, ...TOOL_MARKERS];
const SAFE_RECOVERY: Record<VoiceLanguage, string> = {
  en: "Sorry, let me rephrase that. How can I help?",
  es: "Perdón, déjeme decirlo de otra manera. ¿Cómo puedo ayudarle?",
};

type AssistantTextChunk = string | { text: string };

type SpeechOutputGuardOptions = {
  language?: VoiceLanguage;
  onBlocked?: (marker: string) => void;
};

export async function* guardAssistantSpeech<T extends AssistantTextChunk>(
  chunks: AsyncIterable<T>,
  options: SpeechOutputGuardOptions = {},
): AsyncIterable<T | string> {
  const pending: Array<T | string> = [];
  let pendingText = "";

  for await (const chunk of chunks) {
    pending.push(chunk);
    pendingText += textFromChunk(chunk);
    const marker = blockedMarker(pendingText);
    if (marker) {
      options.onBlocked?.(marker);
      yield SAFE_RECOVERY[options.language ?? DEFAULT_VOICE_LANGUAGE];
      return;
    }

    const validatedLength =
      pendingText.length - possibleMarkerPrefixLength(pendingText);
    let readyLength = completeSentencePrefixLength(
      pendingText.slice(0, validatedLength),
    );
    while (readyLength > 0 && pending.length > 0) {
      const ready = pending[0];
      const readyText = textFromChunk(ready);
      if (readyText.length <= readyLength) {
        pending.shift();
        pendingText = pendingText.slice(readyText.length);
        readyLength -= readyText.length;
        yield ready;
        continue;
      }
      if (typeof ready === "string") {
        yield ready.slice(0, readyLength);
        pending[0] = ready.slice(readyLength);
        pendingText = pendingText.slice(readyLength);
      }
      break;
    }
  }

  yield* pending;
}

function textFromChunk(chunk: AssistantTextChunk): string {
  return typeof chunk === "string" ? chunk : chunk.text;
}

function completeSentencePrefixLength(text: string): number {
  const boundaries = text.matchAll(/[.!?](?:["')\]]+)?(?:\s+|$)/g);
  let readyLength = 0;
  for (const boundary of boundaries) {
    readyLength = (boundary.index ?? 0) + boundary[0].length;
  }
  return readyLength;
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
