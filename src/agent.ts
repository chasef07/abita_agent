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
import type { OwnedMiddleware } from "./clients/owned-middleware.js";
import type { CallState } from "./state/call-state.js";
import type { VoiceLanguageRuntime } from "./runtime/voice-language.js";
import { getOfficeProfileByPhone } from "./customers/abita/profile.js";
import { buildToolsForTrunk } from "./runtime/tool-registry.js";
import { patientModelProjection } from "./identity/patient-identity.js";
import { activeOfficeKey } from "./state/call-lifecycle.js";
import {
  clinicTimestampMessage,
  systemSchedulingClock,
  type SchedulingClock,
} from "./scheduling/clock.js";
import { availabilityModelProjection } from "./scheduling/availability.js";
import { guardAssistantSpeech } from "./runtime/speech-output-guard.js";
import { greetingAudio } from "./runtime/greeting-audio.js";

type VoiceAgentOptions = {
  ownedMiddleware: OwnedMiddleware;
  onAssistantText?: (text: string, complete: boolean) => void;
  suppressGreeting?: boolean;
  turnClock?: SchedulingClock;
  voiceLanguageRuntime?: VoiceLanguageRuntime;
};

const TURN_CONTEXT_MESSAGE_ID = "runtime_turn_context";

export function createVoiceAgent(
  trunkPhone: string,
  options: VoiceAgentOptions,
) {
  const office = getOfficeProfileByPhone(trunkPhone);
  const greeting = options.suppressGreeting ? "" : office.greeting;
  const registeredTools = buildToolsForTrunk(
    options.ownedMiddleware,
    trunkPhone,
  );
  const turnClock = options.turnClock ?? systemSchedulingClock;
  let modelInputSnapshot:
    | { fingerprint: string; changed: boolean; userMessageId?: string }
    | undefined;

  const agent = LiveKitAgent.create<CallState>({
    instructions: buildPrompt(trunkPhone),
    tools: registeredTools,

    async onEnter(ctx): Promise<void> {
      if (greeting) {
        // Brief delay so the SIP audio path is fully established before speaking
        await new Promise((r) => setTimeout(r, 500));
        const audio =
          ctx.session.output.audio && ctx.session.output.audioEnabled
            ? await greetingAudio(trunkPhone)
            : undefined;
        await ctx.session.say(greeting, { audio, allowInterruptions: false });
      }
    },

    async onUserTurnCompleted(ctx, chatCtx: ChatContext): Promise<void> {
      const state = ctx.session.userData;
      const currentInput = modelTurnInput(state, turnClock);
      // LiveKit compares the hook's context to the speculative request's
      // context. State projected only in llmNode is invisible to that check.
      // Force a fresh request when hydration, scheduling, or the clock changed.
      if (
        modelInputSnapshot !== undefined &&
        (modelInputSnapshot.changed ||
          modelInputSnapshot.fingerprint !== currentInput.fingerprint)
      ) {
        chatCtx.addMessage({
          id: TURN_CONTEXT_MESSAGE_ID,
          role: "system",
          content: currentInput.content,
        });
      }
      modelInputSnapshot = undefined;
    },

    async llmNode(ctx, chatCtx, toolCtx, modelSettings) {
      const state = ctx.session.userData;
      const input = modelTurnInput(state, turnClock);
      const modelChatCtx = chatCtx.copy();
      modelChatCtx.items = modelChatCtx.items.filter(
        (item) => item.id !== TURN_CONTEXT_MESSAGE_ID,
      );
      let latestUserIndex = -1;
      for (let index = modelChatCtx.items.length - 1; index >= 0; index -= 1) {
        const item = modelChatCtx.items[index];
        if (item?.type === "message" && item.role === "user") {
          latestUserIndex = index;
          break;
        }
      }
      // A new question must search the current revision again. Keep current-turn
      // results for tool consumption, but remove earlier call/output pairs from
      // the model request so stale passages cannot act as its reference.
      const priorKnowledge = new Set(
        modelChatCtx.items
          .slice(0, Math.max(0, latestUserIndex))
          .filter(
            (item) =>
              (item.type === "function_call" ||
                item.type === "function_call_output") &&
              item.name === "search_office_knowledge",
          ),
      );
      modelChatCtx.items = modelChatCtx.items.filter(
        (item) => !priorKnowledge.has(item),
      );
      latestUserIndex -= priorKnowledge.size;
      // A request whose user message is already committed belongs to a prior
      // turn. Its snapshot must not invalidate fresh speculation on this turn.
      if (
        modelInputSnapshot?.userMessageId !== undefined &&
        ctx.chatCtx.items.some(
          (item) => item.id === modelInputSnapshot?.userMessageId,
        )
      ) {
        modelInputSnapshot = undefined;
      }
      if (modelInputSnapshot === undefined) {
        modelInputSnapshot = {
          fingerprint: input.fingerprint,
          changed: false,
          userMessageId: modelChatCtx.items[latestUserIndex]?.id,
        };
      } else if (modelInputSnapshot.fingerprint !== input.fingerprint) {
        // An overlapping recovery or tool reply must not mask an earlier
        // speculative request that used stale runtime state.
        modelInputSnapshot.changed = true;
      }
      modelChatCtx.items.splice(
        latestUserIndex < 0 ? modelChatCtx.items.length : latestUserIndex,
        0,
        ChatMessage.create({
          id: TURN_CONTEXT_MESSAGE_ID,
          role: "system",
          content: input.content,
        }),
      );
      return LiveKitAgent.default.llmNode(
        ctx.agent,
        modelChatCtx,
        toolCtx as ToolContext<CallState>,
        modelSettings,
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

function modelTurnInput(state: CallState, clock: SchedulingClock) {
  const content = [
    clinicTimestampMessage(clock.now()),
    "Office factual answers require a fresh search_office_knowledge result for THIS user turn, even if your previous answer already stated the fact. For a short follow-up such as And Saturdays, reconstruct a complete question and search again before answering. Earlier assistant statements are not current knowledge evidence. Use the current turn result after the search; never search again solely because you received its result.",
    patientModelProjection(state),
    availabilityModelProjection(state),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    content,
    fingerprint: JSON.stringify([
      activeOfficeKey(state),
      state.identity.activePatient?.patientId,
      state.identity.transitionVersion,
      content,
    ]),
  };
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

function reportBlockedSpeech(
  output: "transcription" | "tts",
  marker: string,
): void {
  console.warn(
    `[speech_guard] blocked internal model output output=${output} marker=${marker}`,
  );
}
