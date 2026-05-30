// agent.ts — Agent definition
// Instructions loaded from workspace/ files, tools wired below.

import { llm, stt, voice } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { ReadableStream } from "node:stream/web";
import { buildPrompt } from "./prompt.js";
import { type CallState, type PhoneLookupResult } from "./state/call-state.js";
import type { VoiceLanguageRuntime } from "./language-runtime.js";
import { getOfficeConfigByPhone } from "./customer/profile.js";
import {
  buildToolsForTrunk as buildToolsForTrunkFromRegistry,
  type AgentTools,
} from "./runtime/tool-registry.js";

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
    if (!state || !transcript) return;

    state.runtime.latestUserTranscript = transcript;
    chatCtx.addMessage({
      role: "system",
      content: renderCallMode(state),
      id: `call_state_${newMessage.id}`,
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

function renderCallMode(state: CallState): string {
  const patientStatus = state.patient.identityConfirmed
    ? "verified"
    : state.patient.patientId
      ? "preloaded_not_confirmed"
      : state.patient.status;
  const appointments =
    state.patient.appointments.length > 0
      ? `${state.patient.appointments.length} loaded`
      : (state.patient.appointmentsStatus ?? "none");
  const insurance =
    state.checkedInsurance.canonicalPlan ??
    state.patient.insurance?.canonicalPlan ??
    "unknown";
  const route = state.scheduling.routing ?? "unknown";

  return [
    "<call_state>",
    `patient: ${patientStatus}`,
    `appointments: ${appointments}`,
    `insurance: ${insurance}`,
    `routing: ${route}`,
    `office: ${state.officeKey}`,
    `availabilitySlots: ${state.scheduling.availabilitySlots.length}`,
    "rules:",
    "- Use tool descriptions for schemas and prerequisites.",
    "- Ask one concise clarifying question when required state is missing.",
    "</call_state>",
  ].join("\n");
}
