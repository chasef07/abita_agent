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
import {
  officeKnowledgeReference,
  resolveOfficeKnowledge,
} from "./office-knowledge.js";
import { activeOfficeKey } from "./state/call-lifecycle.js";
import {
  clinicTimestampMessage,
  systemSchedulingClock,
  type SchedulingClock,
} from "./scheduling/clock.js";
import { greetingAudio } from "./runtime/greeting-audio.js";
import { preCallLookupHint } from "./runtime/precall-bootstrap.js";

type VoiceAgentOptions = {
  ownedMiddleware: OwnedMiddleware;
  officeKnowledgeResolver?: typeof resolveOfficeKnowledge;
  onAssistantText?: (text: string, complete: boolean) => void;
  suppressGreeting?: boolean;
  turnClock?: SchedulingClock;
  voiceLanguageRuntime?: VoiceLanguageRuntime;
};

const CLINIC_TIME_MESSAGE_ID = "clinic_time";
const PRECALL_LOOKUP_HINT_MESSAGE_ID = "precall_lookup_hint";

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

    async onUserTurnCompleted(
      ctx,
      chatCtx: ChatContext,
      newMessage: ChatMessage,
    ): Promise<void> {
      const state = ctx.session.userData;
      const transcript = newMessage.textContent ?? "";
      if (!transcript) return;
      const officeKey = activeOfficeKey(state);
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
      } catch {
        console.warn(`[office_knowledge] retrieval failed office=${officeKey}`);
      }
    },

    async llmNode(ctx, chatCtx, toolCtx, modelSettings) {
      const modelChatCtx = chatCtx.copy();
      modelChatCtx.items = modelChatCtx.items.filter(
        (item) =>
          item.id !== CLINIC_TIME_MESSAGE_ID &&
          item.id !== PRECALL_LOOKUP_HINT_MESSAGE_ID,
      );
      const context = [
        ChatMessage.create({
          id: CLINIC_TIME_MESSAGE_ID,
          role: "system",
          content: clinicTimestampMessage(turnClock.now()),
        }),
      ];
      const hint = preCallLookupHint(ctx.session.userData);
      if (hint)
        context.push(
          ChatMessage.create({
            id: PRECALL_LOOKUP_HINT_MESSAGE_ID,
            role: "system",
            content: hint,
          }),
        );
      let latestUserIndex = -1;
      for (let index = modelChatCtx.items.length - 1; index >= 0; index -= 1) {
        const item = modelChatCtx.items[index];
        if (item?.type === "message" && item.role === "user") {
          latestUserIndex = index;
          break;
        }
      }
      modelChatCtx.items.splice(
        latestUserIndex < 0 ? modelChatCtx.items.length : latestUserIndex,
        0,
        ...context,
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
      return LiveKitAgent.default.ttsNode(
        ctx.agent,
        options.onAssistantText
          ? observeAssistantText(text, options.onAssistantText)
          : text,
        modelSettings,
      );
    },
  });

  return { agent, office };
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
