import { createSearchOfficeKnowledgeTool } from "../tools/search-office-knowledge.js";
import { withMiddlewareToolDiagnostics } from "./middleware-tool-diagnostics.js";
import { withNewTampaDemoTools } from "../customers/abita/new-tampa-demo.js";
import { beta, type ToolContextEntry } from "@livekit/agents";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import type { CallState } from "../state/call-state.js";
import type { OwnedMiddleware } from "../clients/owned-middleware.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import {
  check_insurance,
  createAddPatientTool,
  transfer_call,
  createUpdateInsuranceTool,
} from "../tools/index.js";
import { createStaffTaskTool } from "../tools/create-staff-task.js";
import { createResolvePatientTool } from "../tools/resolve-patient.js";

const end_call = beta.createEndCallTool<CallState>({
  // RoomIO owns room cleanup through deleteRoomOnClose for every session close.
  deleteRoom: false,
  endInstructions: "Say a brief goodbye to the caller.",
});

export type AgentTools = readonly ToolContextEntry<CallState>[];

function buildUnobservedToolsForTrunk(
  middleware: OwnedMiddleware,
  trunkPhone?: string,
  staffTaskFetch?: typeof fetch,
): AgentTools {
  const office = getOfficeProfileByPhone(trunkPhone ?? "");
  const availabilityOfficeMode =
    office.availabilityOfficeFor().status === "blocked"
      ? "required"
      : "omitted";
  const {
    book_appointment,
    cancel_appointment,
    list_available_appointments,
    reschedule_appointment,
  } = createSchedulingTools(middleware, undefined, {
    availabilityOfficeMode,
  });
  const coreTools = [
    createResolvePatientTool(middleware),
    createAddPatientTool(middleware),
    createUpdateInsuranceTool(middleware),
    list_available_appointments,
    cancel_appointment,
    book_appointment,
    reschedule_appointment,
    check_insurance,
  ] as const satisfies readonly ToolContextEntry<CallState>[];
  const create_staff_task = createStaffTaskTool(staffTaskFetch);
  const commonTools = [
    ...coreTools,
    createSearchOfficeKnowledgeTool(),
    transfer_call,
    end_call,
  ] as const;
  if (office.key === "new-tampa-demo") {
    return withNewTampaDemoTools(
      [...commonTools, create_staff_task],
      middleware,
    );
  }
  if (office.staffTaskEnabled) {
    return [...commonTools, create_staff_task];
  }
  return commonTools;
}

export function buildToolsForTrunk(
  middleware: OwnedMiddleware,
  trunkPhone?: string,
  staffTaskFetch?: typeof fetch,
): AgentTools {
  return buildUnobservedToolsForTrunk(
    middleware,
    trunkPhone,
    staffTaskFetch,
  ).map(withMiddlewareToolDiagnostics);
}
