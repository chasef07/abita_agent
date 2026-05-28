import type { CallFlowState, WorkflowCommand } from "../flow/index.js";

export type FlowDecision =
  | { type: "ask"; slot: string; promptHint: string }
  | { type: "call_tool"; tool: string; args: unknown }
  | {
      type: "confirm";
      confirmation: NonNullable<CallFlowState["pendingConfirmation"]>;
    }
  | { type: "say"; instruction: string };

export function flowDecisionForWorkflowCommand(
  command: WorkflowCommand,
): FlowDecision {
  switch (command.nextAction) {
    case "ask":
      return {
        type: "ask",
        slot: command.slot ?? command.missingFacts[0]?.key ?? "clarification",
        promptHint: command.instruction,
      };
    case "call_tool":
      return {
        type: "call_tool",
        tool: command.tool ?? "lookup_knowledge",
        args: command.args ?? {},
      };
    case "confirm":
      return {
        type: "confirm",
        confirmation: {
          type: command.confirmationType ?? "reschedule",
          payload: {
            taskId: command.taskId,
            patientRef: command.patientRef,
          },
        },
      };
    case "complete":
    case "respond":
      return {
        type: "say",
        instruction: command.instruction,
      };
  }
}
