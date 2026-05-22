import { compileFlowContextPacket } from "./context.js";
import { type FlowControllerEvent, nextFlowDecision } from "./controller.js";
import { inferCallerIntentFromTranscript } from "./intent.js";
import type { CallFlowState, FlowDecision, IntentKind } from "./types.js";

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
  transcript: string,
  createdAt: number = Date.now(),
): FlowShadowPrediction {
  const event = inferFlowControllerEvent(transcript);
  const expectedDecision = nextFlowDecision({ state: flow, event });

  return {
    type: "flow_shadow_prediction",
    createdAt,
    source: {
      intent: event.intent,
      hasVisitReason: Boolean(event.visitReason),
      hasInsurancePlan: Boolean(event.insurancePlan),
      coverageType: event.coverageType,
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

function inferFlowControllerEvent(
  transcript: string,
): Extract<FlowControllerEvent, { type: "caller_intent" }> {
  const inferred = inferCallerIntentFromTranscript(transcript);

  return {
    type: "caller_intent",
    intent: inferred.activeIntent,
    ...(inferred.visitReason ? { visitReason: inferred.visitReason } : {}),
    ...(inferred.insurancePlan
      ? { insurancePlan: inferred.insurancePlan }
      : {}),
    ...(inferred.coverageType ? { coverageType: inferred.coverageType } : {}),
  };
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
