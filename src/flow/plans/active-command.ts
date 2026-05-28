import type { CallFlowState, WorkflowCommand } from "../types.js";

export function activeWorkflowCommandForState(
  flow: CallFlowState,
): WorkflowCommand | undefined {
  const command = flow.lastWorkflowCommand;
  if (!command) return undefined;
  if (flow.activeTaskPlanId && command.taskId !== flow.activeTaskPlanId) {
    return undefined;
  }
  return command;
}
