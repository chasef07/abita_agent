import { compileTurnStatePacket } from "./context.js";
import {
  callerTurnMeaningEvent,
  nextFlowEventId,
  type CallerTurnMeaningEvent,
} from "./events.js";
import { reduceFlowEvent } from "./event-reducer.js";
import {
  planNextCommand,
  type PlanNextCommandOptions,
} from "./plans/task-planner.js";
import { type TurnUnderstanding } from "./understanding.js";
import { type TurnUnderstandingStateUpdate } from "./turn-state-reducer.js";
import type {
  CallFlowState,
  ConfirmationType,
  ToolOutcome,
  WorkflowCommand,
  WorkflowCommandAction,
  WorkflowToolName,
} from "./types.js";

export type WorkflowEvent =
  | {
      type: "caller_intent_recorded";
      transcript: string;
      understanding: TurnUnderstanding;
      source?: CallerTurnMeaningEvent["source"];
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
  action: WorkflowCommandAction;
  nextAction: string;
  slot?: string;
  tool?: WorkflowToolName;
  args?: unknown;
  confirmationType?: ConfirmationType;
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
    const reduced = reduceFlowEvent(
      flow,
      callerTurnMeaningEvent({
        transcript: event.transcript,
        understanding: event.understanding,
        flow,
        source: event.source ?? "deterministic_understanding",
      }),
    );
    const update = reduced.update;
    if (!update) {
      throw new Error("caller turn event did not produce a state update");
    }
    if (isLowConfidenceNoop(update)) {
      const nextAction = askActionForSlot("clarification");
      const instruction =
        "Ask one short clarifying question before changing workflow state.";
      return {
        event: event.type,
        update,
        action: "ask",
        nextAction,
        slot: "clarification",
        turnState: compileTurnStatePacket(
          flow,
          {
            nextAction,
          },
          null,
        ),
        instruction,
      };
    }

    return planAndApplyWorkflow(flow, event.type, update, event.options);
  }

  reduceFlowEvent(flow, {
    id: nextFlowEventId("workflow_fact"),
    type: "workflow_fact_event",
    source: "system",
    createdAt: Date.now(),
    workflowEventType: event.type,
  });
  return planAndApplyWorkflow(flow, event.type, undefined, event.options);
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
  reduceFlowEvent(flow, {
    id: nextFlowEventId("planner_command"),
    type: "planner_command_applied",
    source: "planner",
    createdAt: Date.now(),
    command: workflowCommand,
  });
  const nextAction = nextActionForWorkflowCommand(workflowCommand);

  return {
    event,
    update,
    action: workflowCommand.nextAction,
    nextAction,
    ...(workflowCommand.slot ? { slot: workflowCommand.slot } : {}),
    ...(workflowCommand.tool ? { tool: workflowCommand.tool } : {}),
    ...(workflowCommand.args ? { args: workflowCommand.args } : {}),
    ...(workflowCommand.confirmationType
      ? { confirmationType: workflowCommand.confirmationType }
      : {}),
    turnState: compileTurnStatePacket(
      flow,
      {
        nextAction,
      },
      workflowCommand,
    ),
    instruction: instructionForWorkflowCommand(workflowCommand),
    workflowCommand,
    ...(workflowCommand.resolvedMetaDecision
      ? { resolvedMetaDecision: workflowCommand.resolvedMetaDecision }
      : {}),
  };
}

function isLowConfidenceNoop(update: TurnUnderstandingStateUpdate): boolean {
  return update.inferred.activeIntent === "unclear" && !update.changed;
}

export function nextActionForWorkflowCommand(command: WorkflowCommand): string {
  switch (command.nextAction) {
    case "ask":
      return askActionForSlot(
        command.slot ?? command.missingFacts[0]?.key ?? "clarification",
      );
    case "call_tool":
      return command.tool ?? command.suggestedTool ?? "lookup_knowledge";
    case "confirm":
      return `confirm_${command.confirmationType ?? "reschedule"}`;
    case "respond":
    case "complete":
      return "respond";
  }
}

function instructionForWorkflowCommand(command: WorkflowCommand): string {
  switch (command.nextAction) {
    case "ask":
    case "respond":
    case "complete":
      return command.instruction;
    case "call_tool":
      return `Call ${command.tool ?? command.suggestedTool ?? "the selected tool"} next using the current turn_state and caller-provided details.`;
    case "confirm":
      return `Read back the ${command.confirmationType ?? "reschedule"} details and get explicit confirmation before submitting the side effect.`;
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
