import type { CallFlowState, WorkflowCommand } from "../types.js";
import { planCancel } from "./appointment/cancel.js";
import { planConfirm } from "./appointment/confirm.js";
import { planReschedule } from "./appointment/reschedule.js";
import {
  isSchedulingOrInsuranceIntent,
  planScheduling,
  type PlanSchedulingOptions,
} from "./scheduling.js";
import {
  planIntentTriage,
  planKnowledgeAnswer,
  planTransfer,
} from "./simple.js";

export type PlanNextCommandOptions = PlanSchedulingOptions;

export function planNextCommand(
  flow: CallFlowState,
  options: PlanNextCommandOptions = {},
): WorkflowCommand {
  if (flow.activeIntent === "existing_appointment_reschedule") {
    return planReschedule(flow);
  }
  if (flow.activeIntent === "existing_appointment_confirm") {
    return planConfirm(flow);
  }
  if (flow.activeIntent === "existing_appointment_cancel") {
    return planCancel(flow);
  }
  if (flow.activeIntent === "faq") {
    return planKnowledgeAnswer(flow);
  }
  if (flow.activeIntent === "transfer_request") {
    return planTransfer(flow);
  }
  if (isSchedulingOrInsuranceIntent(flow.activeIntent)) {
    return planScheduling(flow, options);
  }
  if (
    flow.activeFlow === "scheduling" ||
    flow.currentTask?.kind === "schedule"
  ) {
    return planScheduling(flow, options);
  }
  if (
    flow.activeFlow === "insurance" ||
    flow.currentTask?.kind === "insurance"
  ) {
    return planScheduling(flow, options);
  }
  if (
    flow.activeFlow === "appointment_management" &&
    flow.schedulingGoal?.appointmentAction === "cancel"
  ) {
    return planCancel(flow);
  }
  return planIntentTriage(flow);
}

export { compactWorkflowCommand } from "./common.js";
