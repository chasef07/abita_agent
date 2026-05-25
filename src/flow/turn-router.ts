import { advanceWorkflow } from "./reducer.js";
import type { TurnUnderstanding } from "./understanding.js";
import type { CallFlowState } from "./types.js";
import type { WorkflowAdvanceResult } from "./reducer.js";

export function advanceFlowForTurn({
  flow,
  transcript,
  understanding,
}: {
  flow: CallFlowState;
  transcript: string;
  understanding: TurnUnderstanding;
}): WorkflowAdvanceResult {
  return advanceWorkflow(flow, {
    type: "caller_intent_recorded",
    transcript,
    understanding,
  });
}

export {
  instructionForFlowDecision,
  nextActionForFlowDecision,
  type WorkflowAdvanceResult as FlowTurnAdvanceResult,
  type ResolvedMetaDecision,
} from "./reducer.js";
