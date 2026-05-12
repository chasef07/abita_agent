// agent.ts — Agent definition
// Instructions loaded from workspace/ files, tools wired below.

import { stt, voice } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { ReadableStream } from "node:stream/web";
import { buildPrompt } from "./prompt.js";
import type { PhoneLookupResult } from "./tools.js";
import type { VoiceLanguageRuntime } from "./language-runtime.js";
import {
  verify_patient,
  add_patient,
  update_insurance,
  get_availability,
  confirm_appt,
  cancel_appt,
  add_patient_note,
  book_appt,
  check_insurance,
  lookup_knowledge,
  route_to_spring_hill,
  transfer_call,
} from "./tools.js";
import { getOfficeConfigByPhone } from "./offices.js";

type AgentTools = {
  verify_patient: typeof verify_patient;
  add_patient: typeof add_patient;
  update_insurance: typeof update_insurance;
  get_availability: typeof get_availability;
  confirm_appt: typeof confirm_appt;
  cancel_appt: typeof cancel_appt;
  add_patient_note: typeof add_patient_note;
  book_appt: typeof book_appt;
  check_insurance: typeof check_insurance;
  lookup_knowledge: typeof lookup_knowledge;
  route_to_spring_hill?: typeof route_to_spring_hill;
  transfer_call: typeof transfer_call;
};

export function buildToolsForTrunk(trunkPhone?: string): AgentTools {
  const office = getOfficeConfigByPhone(trunkPhone ?? "");
  return {
    verify_patient,
    add_patient,
    update_insurance,
    get_availability,
    confirm_appt,
    cancel_appt,
    add_patient_note,
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
    options: { languageRuntime?: VoiceLanguageRuntime } = {},
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
