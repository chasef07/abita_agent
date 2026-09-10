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
];
const TOOL_MARKERS = [
  "resolve_patient",
  "add_patient",
  "update_insurance",
  "list_available_appointments",
  "cancel_appointment",
  "book_appointment",
  "reschedule_appointment",
  "check_insurance",
  "search_office_knowledge",
  "transfer_call",
  "end_call",
  "create_staff_task",
];
// Filter-only vocabulary from LiveKit's internal task prompts.
// These strings do not register or invoke tools.
const SDK_INTERNAL_OUTPUT_MARKERS = [
  "lk_agents_cancel_task",
  "lk_agents_get_running_tasks",
];
const BLOCKED_MARKERS = [
  ...PROMPT_MARKERS,
  ...TOOL_MARKERS,
  ...SDK_INTERNAL_OUTPUT_MARKERS,
];
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

    // Hold only a suffix that could become an internal marker in the next chunk.
    let readyLength =
      pendingText.length - possibleMarkerPrefixLength(pendingText);
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
      // Keep timed chunks intact when their suffix is still ambiguous.
      break;
    }
  }

  yield* pending;
}

function textFromChunk(chunk: AssistantTextChunk): string {
  return typeof chunk === "string" ? chunk : chunk.text;
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
