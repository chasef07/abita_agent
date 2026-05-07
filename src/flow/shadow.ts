import { compileFlowContextPacket } from "./context.js";
import {
  type CallerIntent,
  type FlowControllerEvent,
  nextFlowDecision,
} from "./controller.js";
import type { CallFlowState, FlowDecision } from "./types.js";

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
    intent: CallerIntent;
    hasVisitReason: boolean;
    hasInsurancePlan: boolean;
    coverageType?: "medical" | "routine_vision";
  };
  flowState: {
    activeFlow: CallFlowState["activeFlow"];
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

const TRANSFER_PATTERNS = [
  /\bhuman\b/,
  /\brepresentative\b/,
  /\bperson\b/,
  /\bsomeone\b/,
  /\bfront desk\b/,
  /\bcall back\b/,
  /\btransfer\b/,
];

const SCHEDULING_PATTERNS = [
  /\bschedule\b/,
  /\bappointment\b/,
  /\bbook\b/,
  /\bseen\b/,
  /\bexam\b/,
  /\bfollow[ -]?up\b/,
  /\bcancel\b/,
  /\breschedule\b/,
  /\bcita\b/,
];

const INSURANCE_PATTERNS = [
  /\binsurance\b/,
  /\bcoverage\b/,
  /\bplan\b/,
  /\bdo you take\b/,
  /\baccept\b/,
  /\bseguro\b/,
  /\baceptan\b/,
];

const QUICK_QUESTION_PATTERNS = [
  /\bhours\b/,
  /\baddress\b/,
  /\blocation\b/,
  /\bfax\b/,
  /\bphone\b/,
  /\bopen\b/,
  /\bdireccion\b/,
  /\bhorario\b/,
];

const ROUTINE_PATTERNS = [
  /\broutine\b/,
  /\bannual\b/,
  /\beye exam\b/,
  /\bvision\b/,
  /\bglasses\b/,
  /\bcontacts?\b/,
  /\bexamen de la vista\b/,
  /\blentes\b/,
  /\bcontactos\b/,
];

const MEDICAL_PATTERNS = [
  /\bglaucoma\b/,
  /\bcataract\b/,
  /\bretina\b/,
  /\bpost[ -]?op\b/,
  /\breferral\b/,
  /\bflashes\b/,
  /\bfloaters\b/,
  /\beye pain\b/,
  /\bcatarata\b/,
  /\bdolor\b.*\bojo\b/,
];

const COMMON_PLAN_PATTERNS = [
  /\bvsp\b/i,
  /\beyemed\b/i,
  /\bhumana\b/i,
  /\baetna\b/i,
  /\bcigna\b/i,
  /\bcare ?plus\b/i,
  /\bflorida blue\b/i,
  /\bblue cross\b/i,
  /\bunited\b/i,
  /\bmedicare\b/i,
  /\bmedicaid\b/i,
  /\bambetter\b/i,
  /\boscar\b/i,
  /\btricare\b/i,
];

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
  const text = transcript.trim();
  const normalized = text.toLowerCase();
  const intent = inferIntent(normalized);
  const coverageType = inferCoverageType(normalized);
  const visitReason = inferVisitReason(text, normalized);
  const insurancePlan = inferInsurancePlan(text);

  return {
    type: "caller_intent",
    intent,
    ...(visitReason ? { visitReason } : {}),
    ...(insurancePlan ? { insurancePlan } : {}),
    ...(coverageType ? { coverageType } : {}),
  };
}

function inferIntent(normalized: string): CallerIntent {
  if (TRANSFER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "transfer";
  }
  if (SCHEDULING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "schedule";
  }
  if (INSURANCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "insurance_question";
  }
  if (QUICK_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "quick_question";
  }
  return "unknown";
}

function inferCoverageType(
  normalized: string,
): "medical" | "routine_vision" | undefined {
  if (ROUTINE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "routine_vision";
  }
  if (MEDICAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "medical";
  }
  return undefined;
}

function inferVisitReason(
  transcript: string,
  normalized: string,
): string | undefined {
  if (
    ROUTINE_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    MEDICAL_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return transcript;
  }
  return undefined;
}

function inferInsurancePlan(transcript: string): string | undefined {
  for (const pattern of COMMON_PLAN_PATTERNS) {
    const match = transcript.match(pattern);
    if (match?.[0]) return match[0];
  }
  return undefined;
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
