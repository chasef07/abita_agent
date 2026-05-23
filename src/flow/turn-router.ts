import { nextFlowDecision } from "./controller.js";
import { compileTurnStatePacket } from "./context.js";
import { prepareSchedulingPath } from "./scheduling.js";
import { applyFlowStatePatch } from "./state.js";
import {
  applyTurnUnderstandingFromTranscript,
  type TurnUnderstanding,
  type TurnUnderstandingStateUpdate,
} from "./understanding.js";
import type { CallFlowState, FlowDecision, ToolOutcome } from "./types.js";

export interface ResolvedMetaDecision {
  tool: "prepareSchedulingPath";
  outcome: ToolOutcome;
}

export interface FlowTurnAdvanceResult {
  update: TurnUnderstandingStateUpdate;
  decision: FlowDecision;
  turnState: string;
  instruction: string;
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
  const initialDecision = nextFlowDecision({
    state: flow,
    event: {
      type: "caller_intent",
      intent: update.inferred.activeIntent,
      visitReason: update.inferred.visitReason,
      insurancePlan: update.inferred.insurancePlan,
      coverageType: update.inferred.coverageType,
    },
  });
  const resolved = resolveMetaDecision(flow, initialDecision);
  const decision = resolved.decision;

  return {
    update,
    decision,
    turnState: compileTurnStatePacket(flow, {
      nextAction: nextActionForFlowDecision(decision),
    }),
    instruction: instructionForFlowDecision(decision),
    ...(resolved.meta ? { resolvedMetaDecision: resolved.meta } : {}),
  };
}

export function resolveMetaDecision(
  flow: CallFlowState,
  decision: FlowDecision,
): { decision: FlowDecision; meta?: ResolvedMetaDecision } {
  if (decision.type !== "call_meta_tool") return { decision };
  if (decision.tool !== "prepareSchedulingPath") return { decision };

  const args =
    decision.args && typeof decision.args === "object"
      ? (decision.args as Parameters<typeof prepareSchedulingPath>[0])
      : {
          officeKey: flow.officeKey,
          patientStatus: flow.patientStatus,
        };
  const outcome = prepareSchedulingPath({
    ...args,
    officeKey: args.officeKey ?? flow.officeKey,
    patientStatus: args.patientStatus ?? flow.patientStatus,
  });
  applyFlowStatePatch(flow, outcome.statePatch);

  return {
    decision: nextFlowDecision({
      state: flow,
      event: {
        type: "tool_outcome",
        toolName: decision.tool,
        outcome,
      },
    }),
    meta: {
      tool: "prepareSchedulingPath",
      outcome,
    },
  };
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
      return "confirm_side_effect_action";
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
