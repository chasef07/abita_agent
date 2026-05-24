import type { InsuranceCoverageType } from "../insurance-rules.js";
import type {
  CallFlowState,
  FlowDecision,
  IntentKind,
  ToolOutcome,
  VisitType,
} from "./types.js";
import { classifyVisitType } from "./scheduling.js";
import { completeCurrentTaskAndResume } from "./state.js";

export type FlowControllerEvent =
  | {
      type: "caller_intent";
      intent: IntentKind;
      visitReason?: string;
      visitType?: VisitType;
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

  const intent =
    event.intent === "unclear" && state.activeIntent
      ? state.activeIntent
      : event.intent;

  if (intent === "transfer_request") {
    if (shouldPushBackTransferDuringScheduling(state)) {
      state.completedSteps.push("transfer_pushback_offered");
      resumeSchedulingAfterTransferPushback(state);
      return {
        type: "say",
        instruction:
          "Acknowledge the request, explain you can help finish scheduling, and continue the scheduling path. Transfer only if they ask again.",
      };
    }

    return {
      type: "transfer",
      reason: "caller requested a human or named staff member",
    };
  }

  if (intent === "unclear") {
    return {
      type: "ask",
      slot: "intent",
      promptHint:
        "Ask whether they are trying to schedule, ask an insurance question, or need something else.",
    };
  }

  if (intent === "faq") {
    return {
      type: "call_tool",
      tool: "lookup_knowledge",
      args: {},
    };
  }

  if (intent === "existing_appointment_confirm") {
    return decisionForAppointmentLookup(state);
  }

  if (intent === "existing_appointment_cancel") {
    return decisionForCancellation(state);
  }

  if (intent === "existing_appointment_reschedule") {
    return decisionForReschedule(state);
  }

  const activeSchedulingDecision = decisionForActiveSchedulingStep(
    state,
    event,
  );
  if (isSchedulingOrInsuranceIntent(intent) && activeSchedulingDecision) {
    return activeSchedulingDecision;
  }

  if (
    isSchedulingOrInsuranceIntent(intent) &&
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

  if (isSchedulingOrInsuranceIntent(intent)) {
    const visitType =
      event.visitType ?? (event.visitReason ? undefined : state.visitType);
    const coverageType =
      event.coverageType ??
      coverageTypeForVisitReason(event.visitReason) ??
      (event.visitReason ? undefined : state.coverageType);
    return {
      type: "call_meta_tool",
      tool: "prepareSchedulingPath",
      args: {
        officeKey: state.officeKey,
        patientStatus: state.patientStatus,
        visitReason: event.visitReason ?? state.schedulingGoal?.visitReason,
        visitType,
        insurancePlan:
          event.insurancePlan ??
          storedInsurancePlanForCoverage(state, coverageType),
        coverageType,
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

function decisionForActiveSchedulingStep(
  state: CallFlowState,
  event: Extract<FlowControllerEvent, { type: "caller_intent" }>,
): FlowDecision | undefined {
  if (state.activeFlow !== "scheduling") return undefined;
  const hasNewPathFacts = hasNewSchedulingPathFacts(event);

  if (hasNewPathFacts) {
    clearStaleBookingSelection(state);
  }

  if (
    state.schedulingGoal?.bookingConfirmed === true &&
    state.schedulingGoal.selectedSlotId &&
    !hasNewPathFacts
  ) {
    return {
      type: "call_tool",
      tool: "book_appt",
      args: { slotId: state.schedulingGoal.selectedSlotId },
    };
  }

  if (
    state.step === "get_availability" &&
    state.schedulingGoal?.preferredWindow &&
    !state.schedulingGoal.selectedSlotId &&
    !hasNewPathFacts
  ) {
    return {
      type: "call_tool",
      tool: "get_availability",
      args: {},
    };
  }

  if (state.step === "confirm_booking" && !hasNewPathFacts) {
    if (state.schedulingGoal?.bookingConfirmed === true) {
      return {
        type: "call_tool",
        tool: "book_appt",
        args: state.schedulingGoal.selectedSlotId
          ? { slotId: state.schedulingGoal.selectedSlotId }
          : {},
      };
    }

    if (state.schedulingGoal?.bookingConfirmed === false) {
      moveSchedulingBackToAvailability(state);
      if (state.schedulingGoal.preferredWindow) {
        return {
          type: "call_tool",
          tool: "get_availability",
          args: {},
        };
      }
      return {
        type: "ask",
        slot: "preferredDate",
        promptHint:
          "Ask what day or general time window works instead of the rejected slot.",
      };
    }

    return {
      type: "ask",
      slot: "bookingConfirmation",
      promptHint:
        "Ask whether they want the exact appointment slot that was just offered.",
    };
  }

  if (state.step === "book") {
    return {
      type: "call_tool",
      tool: "book_appt",
      args: {},
    };
  }

  return undefined;
}

function clearStaleBookingSelection(state: CallFlowState): void {
  if (!state.schedulingGoal?.selectedSlotId) return;
  delete state.schedulingGoal.selectedSlotId;
  delete state.schedulingGoal.bookingConfirmed;
  if (state.schedulingGoal.status === "confirming_booking") {
    state.schedulingGoal.status = "ready_for_availability";
  }
}

function hasNewSchedulingPathFacts(
  event: Extract<FlowControllerEvent, { type: "caller_intent" }>,
): boolean {
  return Boolean(
    event.visitReason || event.insurancePlan || event.coverageType,
  );
}

function coverageTypeForVisitReason(
  visitReason?: string,
): InsuranceCoverageType | undefined {
  const visitType = classifyVisitType(visitReason);
  if (visitType === "routine_vision") return "routine_vision";
  if (visitType === "medical" || visitType === "urgent") return "medical";
  return undefined;
}

function storedInsurancePlanForCoverage(
  state: CallFlowState,
  coverageType?: InsuranceCoverageType,
): string | undefined {
  const insurance = activePatient(state)?.insurance;
  if (!insurance || !coverageType || insurance.coverageType !== coverageType) {
    return undefined;
  }
  return insurance.canonicalPlan ?? insurance.plan?.value;
}

function moveSchedulingBackToAvailability(state: CallFlowState): void {
  state.step = "get_availability";
  if (state.currentTask?.kind === "schedule") {
    state.currentTask.step = "get_availability";
  }
  if (state.schedulingGoal) {
    state.schedulingGoal.status = "ready_for_availability";
    delete state.schedulingGoal.selectedSlotId;
  }
}

function shouldPushBackTransferDuringScheduling(state: CallFlowState): boolean {
  return (
    !state.completedSteps.includes("transfer_pushback_offered") &&
    hasRecoverableSchedulingTask(state)
  );
}

function hasRecoverableSchedulingTask(state: CallFlowState): boolean {
  if (
    state.activeFlow === "scheduling" ||
    state.currentTask?.kind === "schedule"
  ) {
    return true;
  }
  if (
    state.currentTask?.kind === "transfer" &&
    state.currentTask.returnTo &&
    state.taskStack.some(
      (task) =>
        task.id === state.currentTask?.returnTo && task.kind === "schedule",
    )
  ) {
    return true;
  }
  return false;
}

function resumeSchedulingAfterTransferPushback(state: CallFlowState): void {
  if (state.currentTask?.kind === "transfer") {
    completeCurrentTaskAndResume(state);
  }
  if (state.currentTask?.kind === "schedule") {
    state.activeIntent = "new_appointment";
  }
}

function hasVerifiedAppointmentManagementPatient(
  state: CallFlowState,
): boolean {
  return (
    state.patientStatus === "verified" || state.patientStatus === "created"
  );
}

function decisionForAppointmentLookup(state: CallFlowState): FlowDecision {
  if (!hasVerifiedAppointmentManagementPatient(state)) {
    return askForAppointmentManagementPatient();
  }

  return {
    type: "call_tool",
    tool: "confirm_appt",
    args: {},
  };
}

function decisionForCancellation(state: CallFlowState): FlowDecision {
  if (!hasVerifiedAppointmentManagementPatient(state)) {
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
  if (!hasVerifiedAppointmentManagementPatient(state)) {
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
