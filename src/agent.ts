// agent.ts — Agent definition
// Instructions loaded from workspace files, tools wired below.

import { llm, stt, voice } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { ReadableStream } from "node:stream/web";
import { buildPrompt } from "./prompt.js";
import { type CallState, type PhoneLookupResult } from "./state/call-state.js";
import {
  observeSttLanguage,
  type SttLanguageDecision,
  type SttLanguageDetector,
} from "./stt-language-detector.js";
import { getOfficeConfigByPhone } from "./customer/profile.js";
import { confirmPreCallIdentityFromTranscript } from "./runtime/precall-transcript-confirmation.js";
import { addDurableInternalSystemMessage } from "./runtime/durable-chat-context.js";
import {
  buildToolsForTrunk as buildToolsForTrunkFromRegistry,
  type AgentTools,
} from "./runtime/tool-registry.js";

export { addDurableInternalSystemMessage };

export function buildToolsForTrunk(trunkPhone?: string): AgentTools {
  return buildToolsForTrunkFromRegistry(trunkPhone);
}

export class Agent extends voice.Agent {
  private greeting: string;
  private sttLanguageDetector?: SttLanguageDetector;
  private onLanguageDecision?: (decision: SttLanguageDecision) => void;

  constructor(
    phoneLookup?: PhoneLookupResult,
    trunkPhone?: string,
    options: {
      onLanguageDecision?: (decision: SttLanguageDecision) => void;
      suppressGreeting?: boolean;
      sttLanguageDetector?: SttLanguageDetector;
    } = {},
  ) {
    const office = getOfficeConfigByPhone(trunkPhone ?? "");
    super({
      instructions: buildPrompt(phoneLookup, trunkPhone),
      tools: buildToolsForTrunk(trunkPhone),
    });
    this.greeting = office.greeting;
    this.sttLanguageDetector = options.sttLanguageDetector;
    this.onLanguageDecision = options.onLanguageDecision;
    if (options.suppressGreeting) this.greeting = "";
  }

  override async onEnter(): Promise<void> {
    if (!this.greeting) return;
    // Brief delay so the SIP audio path is fully established before speaking
    await new Promise((r) => setTimeout(r, 500));
    await this.session.say(this.greeting);
  }

  override async onUserTurnCompleted(
    chatCtx: llm.ChatContext,
    newMessage: llm.ChatMessage,
  ): Promise<void> {
    const state = this.session.userData as CallState | undefined;
    const transcript = newMessage.textContent ?? "";
    if (!state || !transcript) return;

    state.runtime.latestUserTranscript = transcript;
    const confirmation = confirmPreCallIdentityFromTranscript({
      state,
      transcript,
      lastAssistantText: latestAssistantText(chatCtx),
    });
    if (confirmation) {
      await addDurableInternalSystemMessage(
        this,
        chatCtx,
        confirmation.systemMessage,
      );
    }
  }

  override async sttNode(
    audio: ReadableStream<AudioFrame>,
    modelSettings: voice.ModelSettings,
  ): Promise<ReadableStream<stt.SpeechEvent | string> | null> {
    const events = await voice.Agent.default.sttNode(
      this,
      audio,
      modelSettings,
    );
    if (!events || !this.sttLanguageDetector) return events;

    return observeSttLanguage(
      events,
      this.sttLanguageDetector,
      this.onLanguageDecision,
    );
  }
}

function latestAssistantText(chatCtx: llm.ChatContext): string | null {
  for (let index = chatCtx.items.length - 1; index >= 0; index -= 1) {
    const item = chatCtx.items[index];
    if (item.type === "message" && item.role === "assistant") {
      return item.textContent ?? null;
    }
  }
  return null;
}
