// agent.ts — Agent definition
// Instructions loaded from workspace/ files, tools wired below.

import { voice } from "@livekit/agents";
import { buildPrompt } from "./prompt.js";
import type { PhoneLookupResult } from "./tools.js";
import { verify_patient, add_patient, update_insurance, get_availability, confirm_appt, cancel_appt, book_appt, check_insurance, lookup_knowledge, route_to_spring_hill, transfer_call } from "./tools.js";
import { getOfficeConfigByPhone } from "./offices.js";

type AgentTools = {
  verify_patient: typeof verify_patient;
  add_patient: typeof add_patient;
  update_insurance: typeof update_insurance;
  get_availability: typeof get_availability;
  confirm_appt: typeof confirm_appt;
  cancel_appt: typeof cancel_appt;
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
    book_appt,
    check_insurance,
    lookup_knowledge,
    ...(office.features.routeToSpringHill ? { route_to_spring_hill } : {}),
    transfer_call,
  };
}

export class Agent extends voice.Agent {
  private greeting: string;

  constructor(phoneLookup?: PhoneLookupResult, trunkPhone?: string) {
    const office = getOfficeConfigByPhone(trunkPhone ?? "");
    super({
      instructions: buildPrompt(phoneLookup, trunkPhone),
      tools: buildToolsForTrunk(trunkPhone),
    });
    this.greeting = office.greeting;
  }

  override async onEnter(): Promise<void> {
    // Brief delay so the SIP audio path is fully established before speaking
    await new Promise((r) => setTimeout(r, 500));
    await this.session.say(this.greeting);
  }
}
