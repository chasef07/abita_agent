import type { llm } from "@livekit/agents";
import { getOfficeConfigByPhone } from "../customer/profile.js";
import {
  add_patient,
  book_appointment,
  cancel_appointment,
  check_insurance,
  get_current_datetime,
  get_availability,
  lookup_knowledge,
  resolve_patient,
  reschedule_appointment,
  route_to_spring_hill,
  transfer_call,
  update_insurance,
} from "../tools/index.js";

const COMMON_TOOLS = {
  get_current_datetime,
  resolve_patient,
  add_patient,
  update_insurance,
  get_availability,
  cancel_appointment,
  book_appointment,
  reschedule_appointment,
  check_insurance,
  lookup_knowledge,
  transfer_call,
} satisfies llm.ToolContext;

const ROUTING_TOOLS = {
  ...COMMON_TOOLS,
  route_to_spring_hill,
} satisfies llm.ToolContext;

export type AgentTools = typeof COMMON_TOOLS | typeof ROUTING_TOOLS;

export function buildToolsForTrunk(trunkPhone?: string): AgentTools {
  const office = getOfficeConfigByPhone(trunkPhone ?? "");
  if (office.features.routeToSpringHill) {
    return ROUTING_TOOLS;
  }
  return COMMON_TOOLS;
}
