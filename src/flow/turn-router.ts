import { compileTurnStatePacket } from "./context.js";
import {
  applyPlannerPatch,
  flowDecisionForWorkflowCommand,
  planNextCommand,
} from "./plans/task-planner.js";
import {
  applyTurnUnderstandingFromTranscript,
  type TurnUnderstanding,
  type TurnUnderstandingStateUpdate,
} from "./understanding.js";
import type {
  CallFlowState,
  FlowDecision,
  ToolOutcome,
  WorkflowCommand,
} from "./types.js";

export interface ResolvedMetaDecision {
  tool: "prepareSchedulingPath";
  outcome: ToolOutcome;
}

export interface FlowTurnAdvanceResult {
  update: TurnUnderstandingStateUpdate;
  decision: FlowDecision;
  turnState: string;
  instruction: string;
  workflowCommand?: WorkflowCommand;
  resolvedMetaDecision?: ResolvedMetaDecision;
}

export function advanceFlowForTurn({
  flow,
  transcript,
  understanding,
}: {
  flow: CallFlowState;
  transcript: string;
  understanding: TurnUnderstanding;
}): FlowTurnAdvanceResult {
  const update = applyTurnUnderstandingFromTranscript(
    flow,
    transcript,
    understanding,
  );
  if (isLowConfidenceNoop(update)) {
    const decision: FlowDecision = {
      type: "ask",
      slot: "clarification",
      promptHint:
        "Ask one short clarifying question before changing workflow state.",
    };
    return {
      update,
      decision,
      turnState: compileTurnStatePacket(flow, {
        nextAction: nextActionForFlowDecision(decision),
      }),
      instruction: instructionForFlowDecision(decision),
    };
  }
  const workflowCommand = planNextCommand(flow, {
    pathFactsChanged: update.pathFactsChanged,
    preservePreferredWindowOnPathChange: Boolean(
      update.understanding.scheduling?.preferredWindow,
    ),
  });
  applyPlannerPatch(flow, workflowCommand);
  const decision = flowDecisionForWorkflowCommand(workflowCommand);

  return {
    update,
    decision,
    turnState: compileTurnStatePacket(flow, {
      nextAction: nextActionForFlowDecision(decision),
    }),
    instruction: instructionForFlowDecision(decision),
    workflowCommand,
    ...(workflowCommand.resolvedMetaDecision
      ? { resolvedMetaDecision: workflowCommand.resolvedMetaDecision }
      : {}),
  };
}

function isLowConfidenceNoop(update: TurnUnderstandingStateUpdate): boolean {
  return update.inferred.activeIntent === "unclear" && !update.changed;
}

export function instructionForFlowDecision(decision: FlowDecision): string {
  switch (decision.type) {
    case "ask":
      return decision.promptHint;
    case "call_tool":
      return `Call ${decision.tool} next using the current turn_state and caller-provided details.`;
    case "call_meta_tool":
      return `Resolve internal controller step ${decision.tool} before choosing a user-facing action.`;
    case "confirm":
      return `Read back the ${decision.confirmation.type} details and get explicit confirmation before submitting the side effect.`;
    case "say":
      return decision.instruction;
    case "transfer":
      return `Follow the transfer confirmation path before transfer_call. Reason: ${decision.reason}.`;
    case "end_call":
      return `End the call only after a natural closeout. Reason: ${decision.reason}.`;
  }
}

export function nextActionForFlowDecision(decision: FlowDecision): string {
  switch (decision.type) {
    case "ask":
      return askActionForSlot(decision.slot);
    case "call_tool":
    case "call_meta_tool":
      return decision.tool;
    case "confirm":
      return `confirm_${decision.confirmation.type}`;
    case "say":
      return "respond";
    case "transfer":
      return "transfer_call";
    case "end_call":
      return "end_call";
  }
}

function askActionForSlot(slot: string): string {
  switch (slot) {
    case "bookingConfirmation":
      return "ask_booking_confirmation";
    case "insurancePlan":
      return "ask_insurance_plan";
    case "intent":
    case "clarification":
      return "ask_clarifying_question";
    case "patientIdentity":
      return "ask_patient_name";
    case "preferredDate":
      return "ask_preferred_date";
    case "visitReason":
      return "ask_visit_reason";
    default:
      return `ask_${slot}`;
  }
}
