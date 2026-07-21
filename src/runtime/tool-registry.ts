import { beta, type ToolContextEntry } from "@livekit/agents";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import type { CallState } from "../state/call-state.js";
import {
  add_patient,
  book_appointment,
  cancel_appointment,
  check_insurance,
  create_staff_task,
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

const CORE_TOOLS = [
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
] as const satisfies readonly ToolContextEntry<CallState>[];

const COMMON_TOOLS = [
  ...CORE_TOOLS,
  transfer_call,
  end_call,
] as const satisfies readonly ToolContextEntry<CallState>[];

const STAFF_TASK_TOOLS = [
  ...COMMON_TOOLS,
  create_staff_task,
] as const satisfies readonly ToolContextEntry<CallState>[];

export type AgentTools = typeof COMMON_TOOLS | typeof STAFF_TASK_TOOLS;

export function buildToolsForTrunk(trunkPhone?: string): AgentTools {
  const office = getOfficeProfileByPhone(trunkPhone ?? "");
  if (office.staffTaskCapture) return STAFF_TASK_TOOLS;
  return COMMON_TOOLS;
}
