// agent.ts — Agent definition
// Instructions loaded from workspace/ files, tools wired below.

import { llm, stt, voice } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { ReadableStream } from "node:stream/web";
import { buildPrompt } from "./prompt.js";
import type { CallState, PhoneLookupResult } from "./tooling/call-state.js";
import type { VoiceLanguageRuntime } from "./language-runtime.js";
import { compileTurnStatePacket } from "./flow/index.js";
import { getOfficeConfigByPhone } from "./customer/profile.js";
import {
  buildToolsForTrunk as buildToolsForTrunkFromRegistry,
  refreshAgentToolsForSession,
  type AgentTools,
} from "./tooling/tool-registry.js";

export function buildToolsForTrunk(trunkPhone?: string): AgentTools {
  return buildToolsForTrunkFromRegistry(trunkPhone);
}

export class Agent extends voice.Agent {
  private greeting: string;
  private languageRuntime?: VoiceLanguageRuntime;

  constructor(
    phoneLookup?: PhoneLookupResult,
    trunkPhone?: string,
    options: {
      languageRuntime?: VoiceLanguageRuntime;
      suppressGreeting?: boolean;
    } = {},
  ) {
    const office = getOfficeConfigByPhone(trunkPhone ?? "");
    super({
      instructions: buildPrompt(phoneLookup, trunkPhone),
      tools: buildToolsForTrunk(trunkPhone),
    });
    this.greeting = office.greeting;
    this.languageRuntime = options.languageRuntime;
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
    if (!state?.flowHarnessEnabled || !state.flow || !transcript) return;

    state.latestUserTranscript = transcript;
    state.turnUnderstandingAppliedForTranscript = null;
    await refreshAgentToolsForSession(this.session, "turn_update_pending");
    chatCtx.addMessage({
      role: "system",
      content: [
        compileTurnStatePacket(state.flow),
        "",
        "<state_update_required>",
        "Before answering the caller or calling any other tool for this user turn, call record_turn_understanding exactly once with the structured semantic update for the latest caller message. After it returns, continue from the updated turn_state.",
        "</state_update_required>",
      ].join("\n"),
      id: `flow_turn_state_${newMessage.id}`,
      createdAt: newMessage.createdAt + 1,
    });
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
    if (!events || !this.languageRuntime) return events;

    return this.languageRuntime.observeSpeechEvents(events);
  }
}
