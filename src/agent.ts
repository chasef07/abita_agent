// agent.ts — Agent definition
// Instructions loaded from workspace/ files, tools wired below.

import { voice } from "@livekit/agents";
import { buildPrompt } from "./prompt.js";
import { verify_patient, add_patient, get_availability, confirm_appt, cancel_appt, book_appt, check_insurance, lookup_knowledge, transfer_call } from "./tools.js";

export class Agent extends voice.Agent {
  constructor() {
    super({
      instructions: buildPrompt(),
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
  }

  override async onEnter(): Promise<void> {
    await this.session.say("thank you for calling Abita Eye Group, this is David, how can I help you?");
  }
}
