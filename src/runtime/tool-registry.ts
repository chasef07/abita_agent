import { beta, type ToolContextEntry } from "@livekit/agents";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import type { CallState } from "../state/call-state.js";
import { productionSchedulingMiddleware } from "../scheduling/middleware.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import {
  add_patient,
  check_insurance,
  create_staff_task,
  resolve_patient,
  transfer_call,
  update_insurance,
} from "../tools/index.js";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import type { PatientResolveLookup } from "../identity/patient-identity.js";

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
  const office = getOfficeProfileByPhone(trunkPhone ?? "");
  const availabilityOfficeMode =
    office.availabilityOfficeFor().status === "blocked"
      ? "required"
      : "omitted";
  const {
    book_appointment,
    cancel_appointment,
    get_availability,
    reschedule_appointment,
  } = createSchedulingTools(productionSchedulingMiddleware, undefined, {
    availabilityOfficeMode,
  });
  const coreTools = [
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
  ] as const satisfies readonly ToolContextEntry<CallState>[];
  const commonTools = [...coreTools, transfer_call, end_call] as const;
  if (office.staffTaskEnabled) {
    return [...commonTools, create_staff_task];
  }
  return commonTools;
}
