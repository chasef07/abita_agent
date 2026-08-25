import { beta, type ToolContextEntry } from "@livekit/agents";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import type { CallState } from "../state/call-state.js";
import { bindSchedulingMiddleware } from "../scheduling/middleware.js";
import type { OwnedMiddleware } from "../clients/owned-middleware.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import {
  check_insurance,
  createAddPatientTool,
  create_staff_task,
  transfer_call,
  createUpdateInsuranceTool,
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
  middleware: OwnedMiddleware,
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
  } = createSchedulingTools(bindSchedulingMiddleware(middleware), undefined, {
    availabilityOfficeMode,
  });
  const identityLookup =
    options.identityLookup ??
    ((office, identity) => middleware.resolvePatient({ office, identity }));
  const coreTools = [
    createResolvePatientTool(identityLookup),
    createAddPatientTool(middleware),
    createUpdateInsuranceTool(middleware),
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
