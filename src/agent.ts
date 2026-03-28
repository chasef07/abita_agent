// agent.ts — Agent definition
// Instructions loaded from workspace/ files, tools wired below.

import { voice } from "@livekit/agents";
import { buildPrompt } from "./prompt.js";
import type { PhoneLookupResult } from "./tools.js";
import { verify_patient, add_patient, get_availability, confirm_appt, cancel_appt, book_appt, check_insurance, lookup_knowledge, transfer_call } from "./tools.js";

/** Greeting keyed by trunk phone number. Default = Spring Hill. */
const GREETINGS: Record<string, string> = {
  "+13523202007": "Hi there... thank you for calling Eye Radiance powered by Abeeta Eye Group. How can I help you?",
  "+16182265883": "Hi there... thank you for calling Eye Radiance powered by Abeeta Eye Group. How can I help you?",
};
const DEFAULT_GREETING = "thank you for calling Abita Eye Group, this is David, how can I help you?";

export class Agent extends voice.Agent {
  private greeting: string;

  constructor(phoneLookup?: PhoneLookupResult, trunkPhone?: string) {
    super({
      instructions: buildPrompt(phoneLookup),
      tools: {
        verify_patient,
        add_patient,
        get_availability,
        confirm_appt,
        cancel_appt,
        book_appt,
        check_insurance,
        lookup_knowledge,
        transfer_call,
      },
    });
    this.greeting = GREETINGS[trunkPhone ?? ""] ?? DEFAULT_GREETING;
  }

  override async onEnter(): Promise<void> {
    await this.session.say(this.greeting);
  }
}
