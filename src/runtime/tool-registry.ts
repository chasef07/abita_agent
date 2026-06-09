import type { llm } from "@livekit/agents";
import { getOfficeConfigByPhone } from "../customer/profile.js";
import {
  add_patient,
  book_appt,
  cancel_appt,
  check_insurance,
  confirm_patient_identity,
  get_current_datetime,
  get_availability,
  lookup_knowledge,
  reschedule_appt,
  route_to_spring_hill,
  switch_preloaded_patient,
  transfer_call,
  update_insurance,
} from "../tools/index.js";

const COMMON_TOOLS = {
  get_current_datetime,
  confirm_patient_identity,
  add_patient,
  update_insurance,
  get_availability,
  cancel_appt,
  book_appt,
  reschedule_appt,
  check_insurance,
  lookup_knowledge,
  transfer_call,
} satisfies llm.ToolContext;

const ROUTING_TOOLS = {
  ...COMMON_TOOLS,
  route_to_spring_hill,
} satisfies llm.ToolContext;

const COMMON_TOOLS_WITH_PATIENT_SWITCH = {
  ...COMMON_TOOLS,
  switch_preloaded_patient,
} satisfies llm.ToolContext;

const ROUTING_TOOLS_WITH_PATIENT_SWITCH = {
  ...COMMON_TOOLS_WITH_PATIENT_SWITCH,
  route_to_spring_hill,
} satisfies llm.ToolContext;

type BuildToolsOptions = {
  exposePreloadedPatientSwitch?: boolean;
};

export type AgentTools =
  | typeof COMMON_TOOLS
  | typeof ROUTING_TOOLS
  | typeof COMMON_TOOLS_WITH_PATIENT_SWITCH
  | typeof ROUTING_TOOLS_WITH_PATIENT_SWITCH;

export function buildToolsForTrunk(
  trunkPhone?: string,
  options: BuildToolsOptions = {},
): AgentTools {
  const office = getOfficeConfigByPhone(trunkPhone ?? "");
  if (office.features.routeToSpringHill) {
    return options.exposePreloadedPatientSwitch
      ? ROUTING_TOOLS_WITH_PATIENT_SWITCH
      : ROUTING_TOOLS;
  }
  return options.exposePreloadedPatientSwitch
    ? COMMON_TOOLS_WITH_PATIENT_SWITCH
    : COMMON_TOOLS;
}
