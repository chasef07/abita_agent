// agent.ts — Agent definition
// Instructions loaded from workspace files, tools wired below.

import {
  Agent as LiveKitAgent,
  ChatContext,
  ChatMessage,
  ToolContext,
  type ModelSettings,
  type stt,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { ReadableStream } from "node:stream/web";
import { buildPrompt } from "./prompt.js";
import { resolvePatientWithOwnedMiddleware } from "./clients/owned-middleware.js";
import type { CallState } from "./state/call-state.js";
import {
  activeOfficeKey,
  recordLatestUserTranscript,
  transferIsAccepted,
  transferStatus,
} from "./state/call-lifecycle.js";
import type { VoiceLanguageRuntime } from "./runtime/voice-language.js";
import {
  getOfficeProfileByPhone,
  type OfficeKey,
} from "./customers/abita/profile.js";
import { confirmPreCallIdentityFromTranscript } from "./runtime/precall-transcript-confirmation.js";
import { buildToolsForTrunk } from "./runtime/tool-registry.js";
import {
  confirmedPatientModelContext,
  type PatientResolveLookup,
} from "./identity/promotion.js";
import {
  officeKnowledgeReference,
  resolveOfficeKnowledge,
} from "./office-knowledge.js";
import { recordOfficeKnowledgeRetrieval } from "./state/observability.js";
import {
  createInitialLookupChatContext,
  type ModelFacingLookupStatus,
} from "./runtime/precall-model-context.js";
import {
  clinicTimestampMessage,
  systemSchedulingClock,
  type SchedulingClock,
} from "./scheduling/availability-when.js";
import { guardAssistantSpeech } from "./runtime/speech-output-guard.js";

type VoiceAgentOptions = {
  identityLookup?: PatientResolveLookup;
  officeKnowledgeResolver?: typeof resolveOfficeKnowledge;
  onAssistantText?: (text: string, complete: boolean) => void;
  suppressGreeting?: boolean;
  turnClock?: SchedulingClock;
  voiceLanguageRuntime?: VoiceLanguageRuntime;
};

const PATIENT_CONTEXT_MESSAGE_ID_PREFIX = "call_state_patient_context:";

export function createVoiceAgent(
  lookupStatus: ModelFacingLookupStatus,
  trunkPhone: string,
  options: VoiceAgentOptions = {},
) {
  const office = getOfficeProfileByPhone(trunkPhone);
  const greeting = options.suppressGreeting ? "" : office.greeting;
  const identityLookup: PatientResolveLookup =
    options.identityLookup ?? resolvePatientWithOwnedMiddleware;

  const agent = LiveKitAgent.create<CallState>({
    instructions: buildPrompt(trunkPhone),
    chatCtx: createInitialLookupChatContext(lookupStatus),
    tools: buildToolsForTrunk(trunkPhone, {
      identityLookup,
    }),

    async onEnter(ctx): Promise<void> {
      if (!greeting) return;
      // Brief delay so the SIP audio path is fully established before speaking
      await new Promise((r) => setTimeout(r, 500));
      await ctx.session.say(greeting);
    },

    async onUserTurnCompleted(
      ctx,
      chatCtx: ChatContext,
      newMessage: ChatMessage,
    ): Promise<void> {
      chatCtx.addMessage({
        role: "system",
        content: clinicTimestampMessage(
          (options.turnClock ?? systemSchedulingClock).now(),
        ),
      });

      const state = ctx.session.userData;
      const transcript = newMessage.textContent ?? "";
      if (!transcript) return;

      recordLatestUserTranscript(state, transcript);
      const confirmation = await confirmPreCallIdentityFromTranscript(
        {
          state,
          transcript,
        },
        identityLookup,
      );
      const patientContext =
        confirmation?.systemMessage ?? confirmedPatientModelContext(state);
      setPatientModelContext(chatCtx, state, patientContext);

      const officeKey = activeOfficeKey(state);
      const startedAt = performance.now();
      try {
        const knowledge = (
          options.officeKnowledgeResolver ?? resolveOfficeKnowledge
        )(officeKey, transcript, recentNaturalLanguageConversation(chatCtx));
        if (knowledge.outcome !== "skipped") {
          chatCtx.addMessage({
            role: "assistant",
            content: officeKnowledgeReference(officeKey, knowledge),
          });
        }
        recordOfficeKnowledgeRetrieval(state, {
          elapsedMs: elapsedMilliseconds(startedAt),
          language: knowledge.language,
          officeKey,
          outcome: knowledge.outcome,
          sectionCount: knowledge.sections.length,
          topic: knowledge.topic,
        });
      } catch {
        recordOfficeKnowledgeRetrieval(state, {
          elapsedMs: elapsedMilliseconds(startedAt),
          language: "unknown",
          officeKey,
          outcome: "failure",
          sectionCount: 0,
          topic: null,
        });
      }
    },

    async llmNode(ctx, chatCtx, toolCtx, modelSettings) {
      refreshPatientModelContext(chatCtx, ctx.session.userData);
      const forceTransferToolChoice = shouldForceDemoTransferToolChoice(
        office.key,
        ctx.session.userData,
        chatCtx,
        modelSettings,
      );
      const effectiveModelSettings = forceTransferToolChoice
        ? {
            ...modelSettings,
            toolChoice: "required" as const,
          }
        : modelSettings;
      const effectiveToolCtx = forceTransferToolChoice
        ? transferOnlyToolContext(toolCtx)
        : toolCtx;
      return LiveKitAgent.default.llmNode(
        ctx.agent,
        chatCtx,
        effectiveToolCtx as unknown as Parameters<
          typeof LiveKitAgent.default.llmNode
        >[2],
        effectiveModelSettings,
      );
    },

    async sttNode(
      ctx,
      audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<stt.SpeechEvent | string> | null> {
      const events = await LiveKitAgent.default.sttNode(
        ctx.agent,
        audio,
        modelSettings,
      );
      if (!events || !options.voiceLanguageRuntime) return events;
      return options.voiceLanguageRuntime.observe(events);
    },

    async ttsNode(ctx, text, modelSettings) {
      const safeText = guardAssistantSpeech(text, {
        language:
          ctx.session.userData.runtime.voiceLanguage?.current ?? undefined,
        transferIsAccepted: () => transferIsAccepted(ctx.session.userData),
        onBlocked: (marker) => {
          reportBlockedSpeech("tts", marker);
        },
      });
      return LiveKitAgent.default.ttsNode(
        ctx.agent,
        options.onAssistantText
          ? observeAssistantText(safeText, options.onAssistantText)
          : safeText,
        modelSettings,
      );
    },

    async transcriptionNode(ctx, text, modelSettings) {
      const safeText = guardAssistantSpeech(text, {
        language:
          ctx.session.userData.runtime.voiceLanguage?.current ?? undefined,
        transferIsAccepted: () => transferIsAccepted(ctx.session.userData),
        onBlocked: (marker) => {
          reportBlockedSpeech("transcription", marker);
        },
      });
      return LiveKitAgent.default.transcriptionNode(
        ctx.agent,
        safeText,
        modelSettings,
      );
    },
  });

  return { agent, office };
}

function setPatientModelContext(
  chatCtx: ChatContext,
  state: CallState,
  content: string | null,
): void {
  let insertionIndex = chatCtx.items.findIndex((item) =>
    item.id.startsWith(PATIENT_CONTEXT_MESSAGE_ID_PREFIX),
  );
  chatCtx.items = chatCtx.items.filter(
    (item) => !item.id.startsWith(PATIENT_CONTEXT_MESSAGE_ID_PREFIX),
  );
  if (!content) return;

  if (insertionIndex < 0) {
    insertionIndex = chatCtx.items.length - 1;
    while (insertionIndex >= 0) {
      const item = chatCtx.items[insertionIndex];
      if (item.type === "message" && item.role === "user") break;
      insertionIndex -= 1;
    }
  }
  if (insertionIndex < 0) insertionIndex = chatCtx.items.length;

  chatCtx.items.splice(
    insertionIndex,
    0,
    ChatMessage.create({
      id: patientContextMessageId(state),
      role: "system",
      content,
    }),
  );
}

function refreshPatientModelContext(
  chatCtx: ChatContext,
  state: CallState,
): void {
  if (chatCtx.getById(patientContextMessageId(state))) return;
  setPatientModelContext(chatCtx, state, confirmedPatientModelContext(state));
}

function patientContextMessageId(state: CallState): string {
  return `${PATIENT_CONTEXT_MESSAGE_ID_PREFIX}${state.identity.transitionVersion}`;
}

export async function* observeAssistantText(
  chunks: AsyncIterable<string>,
  observer: (text: string, complete: boolean) => void,
): AsyncIterable<string> {
  let text = "";

  for await (const chunk of chunks) {
    text += chunk;
    observer(text, false);
    yield chunk;
  }

  observer(text, true);
}

function recentNaturalLanguageConversation(chatCtx: ChatContext): string[] {
  return chatCtx.items
    .flatMap((item) =>
      item.type === "message" &&
      (item.role === "user" || item.role === "assistant") &&
      item.textContent?.trim()
        ? [item.textContent]
        : [],
    )
    .slice(-2);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function reportBlockedSpeech(
  output: "transcription" | "tts",
  marker: string,
): void {
  console.warn(
    `[speech_guard] blocked internal model output output=${output} marker=${marker}`,
  );
}

const DIRECT_TRANSFER_REQUEST_PATTERNS = [
  /\b(?:please\s+)?(?:transfer|connect)\s+me\b/i,
  /\b(?:please\s+)?put\s+me\s+(?:right\s+)?through\b/i,
  /\b(?:por favor\s+)?(?:transfi[eé]rame|con[eé]cteme|p[aá]seme|comun[ií]queme)\b/i,
];
const DIRECT_TRANSFER_DECLINE_PATTERNS = [
  /\b(?:do not|don't|dont|never)\s+(?:(?:want|need)\s+(?:you\s+)?to\s+)?(?:transfer|connect)\s+me\b/i,
  /\b(?:do not|don't|dont|never)\s+(?:(?:want|need)\s+(?:you\s+)?to\s+)?put\s+me\s+(?:right\s+)?through\b/i,
  /\bno\s+me\s+(?:transfiera|conecte|pase|comunique)\b/i,
  /\bno\s+(?:quiero|necesito)\s+que\s+me\s+(?:transfiera|conecte|pase|comunique)\b/i,
];

function transferOnlyToolContext(
  toolCtx: ToolContext<CallState>,
): ToolContext<CallState> {
  const transferTool = toolCtx.getFunctionTool("transfer_call");
  if (!transferTool) {
    throw new Error("transfer_call is missing from the agent tool context");
  }
  return new ToolContext<CallState>([transferTool]);
}

function shouldForceDemoTransferToolChoice(
  officeKey: OfficeKey,
  state: CallState,
  chatCtx: ChatContext,
  modelSettings: ModelSettings,
): boolean {
  if (
    officeKey !== "dev" ||
    transferStatus(state) !== "idle" ||
    modelSettings.toolChoice === "none" ||
    !state.runtime.latestUserTranscript ||
    toolAlreadyRanForLatestUserTurn(chatCtx)
  ) {
    return false;
  }
  const transcript = normalizeTransferRequest(
    state.runtime.latestUserTranscript,
  );
  const declines = matchesForPatterns(
    DIRECT_TRANSFER_DECLINE_PATTERNS,
    transcript,
  );
  const requests = matchesForPatterns(
    DIRECT_TRANSFER_REQUEST_PATTERNS,
    transcript,
  ).filter(
    (request) =>
      !declines.some(
        (decline) =>
          request.index >= decline.index && request.index < decline.end,
      ),
  );
  return (requests.at(-1)?.index ?? -1) > (declines.at(-1)?.index ?? -1);
}

function normalizeTransferRequest(transcript: string): string {
  return transcript.normalize("NFKC").replace(/[‘’]/g, "'").toLowerCase();
}

function matchesForPatterns(
  patterns: RegExp[],
  transcript: string,
): Array<{ end: number; index: number }> {
  return patterns
    .flatMap((pattern) => {
      const matches: Array<{ end: number; index: number }> = [];
      const matcher = new RegExp(pattern.source, `${pattern.flags}g`);
      for (const match of transcript.matchAll(matcher)) {
        const index = match.index;
        matches.push({ end: index + match[0].length, index });
      }
      return matches;
    })
    .sort((left, right) => left.index - right.index);
}

function toolAlreadyRanForLatestUserTurn(chatCtx: ChatContext): boolean {
  let latestUserIndex = chatCtx.items.length - 1;
  while (latestUserIndex >= 0) {
    const item = chatCtx.items[latestUserIndex];
    if (item.type === "message" && item.role === "user") break;
    latestUserIndex -= 1;
  }
  if (latestUserIndex < 0) return false;
  return chatCtx.items
    .slice(latestUserIndex + 1)
    .some(
      (item) =>
        item.type === "function_call" || item.type === "function_call_output",
    );
}
