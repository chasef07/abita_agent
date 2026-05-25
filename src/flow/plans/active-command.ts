import type { CallFlowState, WorkflowCommand } from "../types.js";
import { planNextCommand } from "./task-planner.js";

export function activeWorkflowCommandForState(
  flow: CallFlowState,
): WorkflowCommand | undefined {
  if (!hasPlannerContext(flow)) return undefined;

  const command = planNextCommand(flow);
  if (flow.activeTaskPlanId && command.taskId !== flow.activeTaskPlanId) {
    return undefined;
  }

  return {
    ...command,
    statePatch: undefined,
  };
}

function hasPlannerContext(flow: CallFlowState): boolean {
  return Boolean(
    flow.activeTaskPlanId || flow.activeIntent || flow.currentTask,
  );
}
