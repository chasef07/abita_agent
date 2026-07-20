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
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import type { PatientResolveLookup } from "../identity/promotion.js";

const end_call = beta.createEndCallTool<CallState>({
  // RoomIO owns room cleanup through deleteRoomOnClose for every session close.
  deleteRoom: false,
  endInstructions: "Say a brief goodbye to the caller.",
});

export type AgentTools = readonly ToolContextEntry<CallState>[];

export function buildToolsForTrunk(
  trunkPhone?: string,
  options: { identityLookup?: PatientResolveLookup } = {},
): AgentTools {
  const coreTools = [
    get_current_datetime,
    options.identityLookup
      ? createResolvePatientTool(options.identityLookup)
      : resolve_patient,
    add_patient,
    update_insurance,
    get_availability,
    cancel_appointment,
    book_appointment,
    reschedule_appointment,
    check_insurance,
    lookup_knowledge,
  ] as const satisfies readonly ToolContextEntry<CallState>[];
  const commonTools = [...coreTools, transfer_call, end_call] as const;
  const office = getOfficeProfileByPhone(trunkPhone ?? "");
  if (office.staffTaskCapture) return [...commonTools, create_staff_task];
  return commonTools;
}
