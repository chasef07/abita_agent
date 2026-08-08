import { beta, ToolContext, type ToolContextEntry } from "@livekit/agents";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import { activePatientId, type CallState } from "../state/call-state.js";
import { productionSchedulingMiddleware } from "../scheduling/middleware.js";
import { lastInsuranceEligibilityCheck } from "../scheduling/state.js";
import { schedulingToolIdsForState } from "../scheduling/tool-availability.js";
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
import type { PatientResolveLookup } from "../identity/promotion.js";

const end_call = beta.createEndCallTool<CallState>({
  // RoomIO owns room cleanup through deleteRoomOnClose for every session close.
  deleteRoom: false,
  endInstructions: "Say a brief goodbye to the caller.",
});

export type AgentTools = readonly ToolContextEntry<CallState>[];

const ALWAYS_AVAILABLE_TOOLS = new Set([
  "check_insurance",
  "create_staff_task",
  "end_call",
  "resolve_patient",
  "transfer_call",
]);

export function toolsForCallState(
  registeredTools: AgentTools,
  state: CallState,
): ToolContext<CallState> {
  const available = new Set([
    ...ALWAYS_AVAILABLE_TOOLS,
    ...schedulingToolIdsForState(state),
  ]);
  const patientIsActive = activePatientId(state) !== null;
  const acceptedInsurance =
    lastInsuranceEligibilityCheck(state)?.accepted === true;

  if (patientIsActive) {
    if (acceptedInsurance) {
      available.add("update_insurance");
    }
  } else if (acceptedInsurance) {
    available.add("add_patient");
  }

  return new ToolContext(
    registeredTools.filter((registeredTool) =>
      available.has(registeredTool.id),
    ),
  );
}

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
  if (office.staffTaskDelivery !== "disabled") {
    return [...commonTools, create_staff_task];
  }
  return commonTools;
}
