import type { InsuranceCoverageType } from "../insurance-rules.js";
import type {
  CallFlowState,
  FlowDecision,
  IntentKind,
  ToolOutcome,
} from "./types.js";

export type FlowControllerEvent =
  | {
      type: "caller_intent";
      intent: IntentKind;
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

  if (event.intent === "transfer_request") {
    return {
      type: "transfer",
      reason: "caller requested a human or named staff member",
    };
  }

  if (event.intent === "unclear") {
    return {
      type: "ask",
      slot: "intent",
      promptHint:
        "Ask whether they are trying to schedule, ask an insurance question, or need something else.",
    };
  }

  if (event.intent === "faq") {
    return {
      type: "call_tool",
      tool: "lookup_knowledge",
      args: {},
    };
  }

  if (event.intent === "existing_appointment_confirm") {
    return decisionForAppointmentLookup(state);
  }

  if (event.intent === "existing_appointment_cancel") {
    return decisionForCancellation(state);
  }

  if (event.intent === "existing_appointment_reschedule") {
    return decisionForReschedule(state);
  }

  if (
    isSchedulingOrInsuranceIntent(event.intent) &&
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

  if (isSchedulingOrInsuranceIntent(event.intent)) {
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

function isSchedulingOrInsuranceIntent(intent: IntentKind): boolean {
  return (
    intent === "new_appointment" ||
    intent === "new_patient_registration" ||
    intent === "insurance_question"
  );
}

function hasAppointmentManagementPatient(state: CallFlowState): boolean {
  return (
    state.patientStatus === "matched" ||
    state.patientStatus === "verified" ||
    state.patientStatus === "created"
  );
}

function decisionForAppointmentLookup(state: CallFlowState): FlowDecision {
  if (!hasAppointmentManagementPatient(state)) {
    return askForAppointmentManagementPatient();
  }

  return {
    type: "call_tool",
    tool: "confirm_appt",
    args: {},
  };
}

function decisionForCancellation(state: CallFlowState): FlowDecision {
  if (!hasAppointmentManagementPatient(state)) {
    return askForAppointmentManagementPatient();
  }

  if (!hasLoadedAppointments(state)) {
    return {
      type: "call_tool",
      tool: "confirm_appt",
      args: {},
    };
  }

  return {
    type: "confirm",
    confirmation: {
      type: "cancel",
      payload: {
        patientRef: state.activePatientRef ?? "caller",
        appointmentCount: activePatient(state)?.appointments.length ?? 0,
      },
    },
  };
}

function decisionForReschedule(state: CallFlowState): FlowDecision {
  if (!hasAppointmentManagementPatient(state)) {
    return askForAppointmentManagementPatient();
  }

  if (!hasLoadedAppointments(state)) {
    return {
      type: "call_tool",
      tool: "confirm_appt",
      args: {},
    };
  }

  return {
    type: "ask",
    slot: "preferredDate",
    promptHint:
      "Confirm which existing appointment they want to move, then ask what day or time window works for the new appointment.",
  };
}

function askForAppointmentManagementPatient(): FlowDecision {
  return {
    type: "ask",
    slot: "patientIdentity",
    promptHint:
      "Ask for the patient's name and date of birth before managing an existing appointment.",
  };
}

function hasLoadedAppointments(state: CallFlowState): boolean {
  return (activePatient(state)?.appointments.length ?? 0) > 0;
}

function activePatient(state: CallFlowState) {
  const patientRef = state.activePatientRef ?? "caller";
  return state.patients[patientRef];
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
