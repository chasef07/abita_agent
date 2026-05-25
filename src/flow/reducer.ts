import { compileTurnStatePacket } from "./context.js";
import {
  applyPlannerPatch,
  flowDecisionForWorkflowCommand,
  planNextCommand,
  type PlanNextCommandOptions,
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

export type WorkflowEvent =
  | {
      type: "caller_intent_recorded";
      transcript: string;
      understanding: TurnUnderstanding;
      options?: PlanNextCommandOptions;
    }
  | {
      type:
        | "facts_changed"
        | "patient_verified"
        | "appointments_loaded"
        | "appointments_none_found"
        | "availability_offered"
        | "booking_succeeded"
        | "cancel_succeeded";
      options?: PlanNextCommandOptions;
    };

export interface ResolvedMetaDecision {
  tool: "prepareSchedulingPath";
  outcome: ToolOutcome;
}

export interface WorkflowAdvanceResult {
  event: WorkflowEvent["type"];
  update?: TurnUnderstandingStateUpdate;
  decision: FlowDecision;
  turnState: string;
  instruction: string;
  workflowCommand?: WorkflowCommand;
  resolvedMetaDecision?: ResolvedMetaDecision;
}

export function advanceWorkflow(
  flow: CallFlowState,
  event: WorkflowEvent,
): WorkflowAdvanceResult {
  if (event.type === "caller_intent_recorded") {
    const update = applyTurnUnderstandingFromTranscript(
      flow,
      event.transcript,
      event.understanding,
    );
    if (isLowConfidenceNoop(update)) {
      const decision: FlowDecision = {
        type: "ask",
        slot: "clarification",
        promptHint:
          "Ask one short clarifying question before changing workflow state.",
      };
      return {
        event: event.type,
        update,
        decision,
        turnState: compileTurnStatePacket(flow, {
          nextAction: nextActionForFlowDecision(decision),
        }),
        instruction: instructionForFlowDecision(decision),
      };
    }

    return planAndApplyWorkflow(flow, event.type, update, event.options);
  }

  applyEventFacts(flow, event);
  return planAndApplyWorkflow(flow, event.type, undefined, event.options);
}

function applyEventFacts(flow: CallFlowState, event: WorkflowEvent): void {
  switch (event.type) {
    case "booking_succeeded":
      if (flow.schedulingGoal) {
        flow.schedulingGoal = {
          ...flow.schedulingGoal,
          status: "booked",
          updatedAt: Date.now(),
        };
      }
      return;
    case "cancel_succeeded":
      flow.pendingConfirmation = undefined;
      return;
    default:
      return;
  }
}

function planAndApplyWorkflow(
  flow: CallFlowState,
  event: WorkflowEvent["type"],
  update?: TurnUnderstandingStateUpdate,
  options: PlanNextCommandOptions = {},
): WorkflowAdvanceResult {
  const workflowCommand = planNextCommand(flow, {
    ...options,
    pathFactsChanged: update?.pathFactsChanged ?? options.pathFactsChanged,
    preservePreferredWindowOnPathChange:
      options.preservePreferredWindowOnPathChange ??
      Boolean(update?.understanding.scheduling?.preferredWindow),
  });
  applyPlannerPatch(flow, workflowCommand);
  const decision = flowDecisionForWorkflowCommand(workflowCommand);

  return {
    event,
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
