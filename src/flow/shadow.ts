import { compileFlowContextPacket } from "./context.js";
import {
  applyTurnUnderstanding,
  turnUnderstandingToInferredIntent,
  type TurnUnderstanding,
} from "./understanding.js";
import type { CallFlowState, FlowDecision, IntentKind } from "./types.js";
import {
  flowDecisionForWorkflowCommand,
  planNextCommand,
} from "./plans/task-planner.js";

export interface FlowShadowDecisionSummary {
  type: FlowDecision["type"];
  tool?: string;
  slot?: string;
  confirmationType?: string;
}

export interface FlowShadowPrediction {
  type: "flow_shadow_prediction";
  createdAt: number;
  source: {
    intent: IntentKind;
    hasVisitReason: boolean;
    hasInsurancePlan: boolean;
    coverageType?: "medical" | "routine_vision";
  };
  flowState: {
    activeFlow: CallFlowState["activeFlow"];
    activeIntent: CallFlowState["activeIntent"];
    step: CallFlowState["step"];
    patientStatus: CallFlowState["patientStatus"];
    visitType?: CallFlowState["visitType"];
    officeKey: CallFlowState["officeKey"];
  };
  contextPacket: string;
  expectedDecision: FlowShadowDecisionSummary;
}

export interface FlowShadowToolObservation {
  type: "flow_shadow_tool_observation";
  createdAt: number;
  toolName: string;
  expectedDecision: FlowShadowDecisionSummary | null;
  match: "match" | "mismatch" | "not_applicable";
  mismatchReason?: string;
}

export type FlowShadowEvent = FlowShadowPrediction | FlowShadowToolObservation;

export function createFlowShadowPrediction(
  flow: CallFlowState,
  understanding: TurnUnderstanding,
  createdAt: number = Date.now(),
): FlowShadowPrediction {
  const shadowFlow = cloneFlowState(flow);
  const update = applyTurnUnderstanding(shadowFlow, understanding);
  const command = planNextCommand(shadowFlow, {
    pathFactsChanged: update.pathFactsChanged,
    preservePreferredWindowOnPathChange: Boolean(
      update.understanding.scheduling?.preferredWindow,
    ),
  });
  const expectedDecision = flowDecisionForWorkflowCommand(command);
  const inferred = turnUnderstandingToInferredIntent(understanding);

  return {
    type: "flow_shadow_prediction",
    createdAt,
    source: {
      intent: inferred.activeIntent,
      hasVisitReason: Boolean(inferred.visitReason),
      hasInsurancePlan: Boolean(inferred.insurancePlan),
      coverageType: inferred.coverageType,
    },
    flowState: {
      activeFlow: flow.activeFlow,
      activeIntent: flow.activeIntent,
      step: flow.step,
      patientStatus: flow.patientStatus,
      visitType: flow.visitType,
      officeKey: flow.officeKey,
    },
    contextPacket: compileFlowContextPacket(flow),
    expectedDecision: summarizeDecision(expectedDecision),
  };
}

export function observeFlowToolExecution(
  latestPrediction: FlowShadowPrediction | undefined,
  toolName: string,
  createdAt: number = Date.now(),
): FlowShadowToolObservation {
  if (!latestPrediction) {
    return {
      type: "flow_shadow_tool_observation",
      createdAt,
      toolName,
      expectedDecision: null,
      match: "not_applicable",
      mismatchReason: "no prior final user transcript",
    };
  }

  const expected = latestPrediction.expectedDecision;
  if (expected.type === "call_tool") {
    return {
      type: "flow_shadow_tool_observation",
      createdAt,
      toolName,
      expectedDecision: expected,
      match: expected.tool === toolName ? "match" : "mismatch",
      mismatchReason:
        expected.tool === toolName
          ? undefined
          : `expected ${expected.tool}, got ${toolName}`,
    };
  }

  if (expected.type === "call_meta_tool") {
    return {
      type: "flow_shadow_tool_observation",
      createdAt,
      toolName,
      expectedDecision: expected,
      match: "not_applicable",
      mismatchReason: "expected internal meta-tool decision",
    };
  }

  return {
    type: "flow_shadow_tool_observation",
    createdAt,
    toolName,
    expectedDecision: expected,
    match: "mismatch",
    mismatchReason: `expected ${expected.type}, got tool ${toolName}`,
  };
}

function cloneFlowState(flow: CallFlowState): CallFlowState {
  return structuredClone(flow) as CallFlowState;
}

function summarizeDecision(decision: FlowDecision): FlowShadowDecisionSummary {
  switch (decision.type) {
    case "call_tool":
    case "call_meta_tool":
      return { type: decision.type, tool: decision.tool };
    case "ask":
      return { type: decision.type, slot: decision.slot };
    case "confirm":
      return {
        type: decision.type,
        confirmationType: decision.confirmation.type,
      };
    default:
      return { type: decision.type };
  }
}
