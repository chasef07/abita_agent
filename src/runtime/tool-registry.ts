import type { llm } from "@livekit/agents";
import { getOfficeConfigByPhone } from "../customer/profile.js";
import {
  add_patient,
  book_appt,
  cancel_appt,
  check_insurance,
  get_availability,
  lookup_knowledge,
  route_to_spring_hill,
  transfer_call,
  update_insurance,
  verify_patient,
} from "../tools/index.js";

const COMMON_TOOLS = {
  verify_patient,
  add_patient,
  update_insurance,
  get_availability,
  cancel_appt,
  book_appt,
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
  return office.features.routeToSpringHill ? ROUTING_TOOLS : COMMON_TOOLS;
}
