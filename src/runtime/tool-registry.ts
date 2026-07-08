import { beta, type ToolContextEntry } from "@livekit/agents";
import { getOfficeConfigByPhone } from "../customers/profile.js";
import type { CallState } from "../state/call-state.js";
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
  transfer_call,
  update_insurance,
} from "../tools/index.js";

const end_call = beta.createEndCallTool<CallState>({
  // RoomIO owns room cleanup through deleteRoomOnClose for every session close.
  deleteRoom: false,
  endInstructions: "Say a brief goodbye to the caller.",
});

const COMMON_TOOLS = [
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
  end_call,
] as const satisfies readonly ToolContextEntry<CallState>[];

export type AgentTools = typeof COMMON_TOOLS;

export function buildToolsForTrunk(trunkPhone?: string): AgentTools {
  getOfficeConfigByPhone(trunkPhone ?? "");
  return COMMON_TOOLS;
}
