import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { CallFlowState, FlowDecision, ToolOutcome } from "./types.js";

export type CallerIntent =
  | "schedule"
  | "insurance_question"
  | "quick_question"
  | "transfer"
  | "unknown";

export type FlowControllerEvent =
  | {
      type: "caller_intent";
      intent: CallerIntent;
      visitReason?: string;
      insurancePlan?: string;
      coverageType?: InsuranceCoverageType;
    }
  | {
      type: "tool_outcome";
      toolName: string;
      outcome: ToolOutcome;
    };

export interface FlowControllerInput {
  state: CallFlowState;
  event: FlowControllerEvent;
}

export function nextFlowDecision({
  state,
  event,
}: FlowControllerInput): FlowDecision {
  if (event.type === "tool_outcome") {
    return decisionFromToolOutcome(event.outcome);
  }

  if (event.intent === "transfer") {
    return {
      type: "transfer",
      reason: "caller requested a human or named staff member",
    };
  }

  if (event.intent === "unknown") {
    return {
      type: "ask",
      slot: "intent",
      promptHint:
        "Ask whether they are trying to schedule, ask an insurance question, or need something else.",
    };
  }

  if (
    (event.intent === "schedule" || event.intent === "insurance_question") &&
    !event.visitReason &&
    !state.visitType
  ) {
    return {
      type: "ask",
      slot: "visitReason",
      promptHint:
        "Ask whether this is for routine vision, glasses or contacts, or for a medical eye visit.",
    };
  }

  if (event.intent === "schedule" || event.intent === "insurance_question") {
    return {
      type: "call_meta_tool",
      tool: "prepareSchedulingPath",
      args: {
        officeKey: state.officeKey,
        patientStatus: state.patientStatus,
        visitReason: event.visitReason,
        insurancePlan: event.insurancePlan,
        coverageType: event.coverageType,
      },
    };
  }

  return {
    type: "call_tool",
    tool: "lookup_knowledge",
    args: {},
  };
}

function decisionFromToolOutcome(outcome: ToolOutcome): FlowDecision {
  if (outcome.outcome === "route_required") {
    return {
      type: "confirm",
      confirmation: {
        type: "route_office",
        payload: outcome.facts ?? {},
      },
    };
  }

  if (outcome.outcome === "transfer_required") {
    return {
      type: "transfer",
      reason: outcome.speak ?? "flow requires transfer",
    };
  }

  if (outcome.outcome === "needs_clarification") {
    return {
      type: "ask",
      slot: outcome.statePatch?.requiredSlots?.[0] ?? "clarification",
      promptHint: outcome.speak ?? "Ask one focused clarifying question.",
    };
  }

  if (outcome.outcome === "not_allowed") {
    return {
      type: "say",
      instruction: outcome.speak ?? "Explain why that path cannot continue.",
    };
  }

  if (outcome.nextStep === "get_availability") {
    return {
      type: "ask",
      slot: "preferredDate",
      promptHint:
        "Ask what day or general time window works for the appointment.",
    };
  }

  if (outcome.nextStep === "verify_patient") {
    return {
      type: "ask",
      slot: "patientIdentity",
      promptHint: "Ask for the patient's name and date of birth.",
    };
  }

  return {
    type: "say",
    instruction: outcome.speak ?? "Continue with the next step.",
  };
}
