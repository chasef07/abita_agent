// agent.ts — Agent definition
// Instructions loaded from workspace/ files, tools wired below.

import { llm, stt, voice } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { ReadableStream } from "node:stream/web";
import { buildPrompt } from "./prompt.js";
import type { CallState, PhoneLookupResult } from "./tools.js";
import type { VoiceLanguageRuntime } from "./language-runtime.js";
import { compileTurnStatePacket } from "./flow/index.js";
import {
  record_turn_understanding,
  verify_patient,
  add_patient,
  update_insurance,
  get_availability,
  confirm_appt,
  cancel_appt,
  add_patient_note,
  confirm_side_effect_action,
  confirm_booking_action,
  book_appt,
  check_insurance,
  lookup_knowledge,
  route_to_spring_hill,
  transfer_call,
} from "./tools.js";
import { getOfficeConfigByPhone } from "./offices.js";

type AgentTools = {
  record_turn_understanding: typeof record_turn_understanding;
  verify_patient: typeof verify_patient;
  add_patient: typeof add_patient;
  update_insurance: typeof update_insurance;
  get_availability: typeof get_availability;
  confirm_appt: typeof confirm_appt;
  cancel_appt: typeof cancel_appt;
  add_patient_note: typeof add_patient_note;
  confirm_side_effect_action: typeof confirm_side_effect_action;
  confirm_booking_action: typeof confirm_booking_action;
  book_appt: typeof book_appt;
  check_insurance: typeof check_insurance;
  lookup_knowledge: typeof lookup_knowledge;
  route_to_spring_hill?: typeof route_to_spring_hill;
  transfer_call: typeof transfer_call;
};

export function buildToolsForTrunk(trunkPhone?: string): AgentTools {
  const office = getOfficeConfigByPhone(trunkPhone ?? "");
  return {
    record_turn_understanding,
    verify_patient,
    add_patient,
    update_insurance,
    get_availability,
    confirm_appt,
    cancel_appt,
    add_patient_note,
    confirm_side_effect_action,
    confirm_booking_action,
    book_appt,
    check_insurance,
    lookup_knowledge,
    ...(office.features.routeToSpringHill ? { route_to_spring_hill } : {}),
    transfer_call,
  };
}

export class Agent extends voice.Agent {
  private greeting: string;
  private languageRuntime?: VoiceLanguageRuntime;

  constructor(
    phoneLookup?: PhoneLookupResult,
    trunkPhone?: string,
    options: {
      languageRuntime?: VoiceLanguageRuntime;
    } = {},
  ) {
    const office = getOfficeConfigByPhone(trunkPhone ?? "");
    super({
      instructions: buildPrompt(phoneLookup, trunkPhone),
      tools: buildToolsForTrunk(trunkPhone),
    });
    this.greeting = office.greeting;
    this.languageRuntime = options.languageRuntime;
  }

  override async onEnter(): Promise<void> {
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
    if (!state?.flow || !transcript) return;

    state.latestUserTranscript = transcript;
    state.turnUnderstandingAppliedForTranscript = null;
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
