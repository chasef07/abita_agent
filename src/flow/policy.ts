import {
  findConsumedBookingAction,
  findInvalidatedBookingAction,
  findPendingBookingAction,
  type BookingAttemptRecordInput,
} from "./availability.js";
import {
  findConsumedSideEffectAction,
  findInvalidatedSideEffectAction,
  findPendingSideEffectAction,
  nextStepForSideEffectAction,
  sideEffectActionTypeForTool,
  type SideEffectToolName,
} from "./pending-actions.js";
import { guardToolCall } from "./guards.js";
import type {
  GuardObservation,
  GuardObservationReason,
  GuardedToolName,
  GuardToolCallInput,
} from "./guards.js";
import type { CallFlowState, ToolOutcome } from "./types.js";

export interface FlowPolicyInput {
  flow: CallFlowState;
  toolName: GuardedToolName;
  args?: unknown;
  stateFacts?: GuardToolCallInput["stateFacts"];
  booking?: Omit<BookingAttemptRecordInput, "spokenSummary">;
  createdAt?: number;
}

export interface FlowPolicyDecision {
  allowed: boolean;
  observation: GuardObservation;
  outcome?: ToolOutcome;
}

export function evaluateFlowToolPolicy({
  flow,
  toolName,
  args,
  stateFacts,
  booking,
  createdAt,
}: FlowPolicyInput): FlowPolicyDecision {
  const guardObservation = guardToolCall({
    flow,
    toolName,
    args,
    stateFacts,
    createdAt,
  });
  if (toolName === "book_appt") {
    const historicalBookingDecision = evaluateHistoricalBookingPolicy(
      flow,
      booking,
    );
    if (historicalBookingDecision) {
      return {
        allowed: false,
        observation: observationWithReason(
          guardObservation,
          historicalBookingDecision.reason,
        ),
        outcome: historicalBookingDecision.outcome,
      };
    }
  }
  const guardOutcome = outcomeForGuardReason(guardObservation.reason);
  if (guardOutcome) {
    return {
      allowed: false,
      observation: observationWithReason(
        guardObservation,
        guardObservation.reason,
      ),
      outcome: guardOutcome,
    };
  }

  if (isPendingSideEffectTool(toolName)) {
    const sideEffectDecision = evaluateSideEffectPolicy(
      flow,
      toolName,
      guardObservation.argsHash,
      args,
    );
    if (sideEffectDecision) {
      return {
        allowed: false,
        observation: observationWithReason(
          guardObservation,
          sideEffectDecision.reason,
        ),
        outcome: sideEffectDecision.outcome,
      };
    }
  }

  if (toolName === "book_appt") {
    const bookingDecision = evaluateBookingPolicy(flow, booking);
    if (bookingDecision) {
      return {
        allowed: false,
        observation: observationWithReason(
          guardObservation,
          bookingDecision.reason,
        ),
        outcome: bookingDecision.outcome,
      };
    }
  }

  return {
    allowed: true,
    observation: guardObservation,
  };
}

function isPendingSideEffectTool(
  toolName: GuardedToolName,
): toolName is SideEffectToolName {
  return (
    toolName === "add_patient" ||
    toolName === "cancel_appt" ||
    toolName === "update_insurance" ||
    toolName === "route_to_spring_hill" ||
    toolName === "transfer_call"
  );
}

function evaluateSideEffectPolicy(
  flow: CallFlowState,
  toolName: SideEffectToolName,
  argsHash: string,
  args: unknown,
): { reason: GuardObservationReason; outcome: ToolOutcome } | undefined {
  const actionType = sideEffectActionTypeForTool(toolName);
  const lookup = {
    type: actionType,
    argsHash,
    patientRef: flow.activePatientRef,
    appointmentId: appointmentIdFromArgs(args),
  };
  const invalidatedAction = findInvalidatedSideEffectAction(flow, lookup);
  if (invalidatedAction) {
    return sideEffectInvalidatedOutcome(toolName, actionType);
  }
  const activeAction = findPendingSideEffectAction(flow, lookup);
  if (activeAction) {
    if (!activeAction.confirmed) {
      return sideEffectConfirmationRequiredOutcome(toolName, actionType);
    }
    return undefined;
  }

  const consumedAction = findConsumedSideEffectAction(flow, lookup);
  if (consumedAction) {
    return consumedSideEffectOutcome(toolName, consumedAction.id);
  }

  return sideEffectRequiredOutcome(toolName, actionType);
}

function appointmentIdFromArgs(args: unknown): number | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return undefined;
  const appointmentId = (args as { appointmentId?: unknown }).appointmentId;
  return typeof appointmentId === "number" ? appointmentId : undefined;
}

function sideEffectRequiredOutcome(
  toolName: SideEffectToolName,
  actionType: ReturnType<typeof sideEffectActionTypeForTool>,
): { reason: GuardObservationReason; outcome: ToolOutcome } {
  return {
    reason: "side_effect_requires_pending_action",
    outcome: {
      outcome: "not_allowed",
      nextStep: nextStepForSideEffectAction(actionType),
      speak: pendingActionInstruction(toolName),
      facts: {
        reason: "side_effect_requires_pending_action",
        toolName,
      },
      retryable: true,
    },
  };
}

function sideEffectConfirmationRequiredOutcome(
  toolName: SideEffectToolName,
  actionType: ReturnType<typeof sideEffectActionTypeForTool>,
): { reason: GuardObservationReason; outcome: ToolOutcome } {
  return {
    reason: "side_effect_confirmation_required",
    outcome: {
      outcome: "not_allowed",
      nextStep: nextStepForSideEffectAction(actionType),
      speak: pendingActionInstruction(toolName),
      facts: {
        reason: "side_effect_confirmation_required",
        toolName,
      },
      retryable: true,
    },
  };
}

function sideEffectInvalidatedOutcome(
  toolName: SideEffectToolName,
  actionType: ReturnType<typeof sideEffectActionTypeForTool>,
): { reason: GuardObservationReason; outcome: ToolOutcome } {
  return {
    reason: "side_effect_action_invalidated",
    outcome: {
      outcome: "not_allowed",
      nextStep: nextStepForSideEffectAction(actionType),
      speak:
        "That confirmation is no longer current. Read back the updated details and confirm again before continuing.",
      facts: {
        reason: "side_effect_action_invalidated",
        toolName,
      },
      retryable: true,
    },
  };
}

function consumedSideEffectOutcome(
  toolName: SideEffectToolName,
  pendingActionId: string,
): { reason: GuardObservationReason; outcome: ToolOutcome } {
  return {
    reason: "side_effect_action_already_consumed",
    outcome: {
      outcome: "success",
      nextStep: "answer",
      speak:
        "That confirmed action was already submitted. Do not submit it again.",
      facts: {
        reason: "side_effect_action_already_consumed",
        toolName,
        pendingActionId,
      },
      retryable: false,
    },
  };
}

function pendingActionInstruction(toolName: SideEffectToolName): string {
  switch (toolName) {
    case "add_patient":
      return "Read back the registration details and record the caller's explicit confirmation before creating the patient.";
    case "cancel_appt":
      return "Read back the appointment and record explicit cancellation confirmation before cancelling.";
    case "route_to_spring_hill":
      return "Explain the Spring Hill routing and record the caller's agreement before switching the scheduling office.";
    case "transfer_call":
      return "Tell the caller you are transferring them and record their explicit agreement before starting the transfer.";
    case "update_insurance":
      return "Read back the insurance update and record explicit confirmation before submitting it.";
  }
}

function outcomeForGuardReason(
  reason: GuardObservationReason,
): ToolOutcome | undefined {
  switch (reason) {
    case "visit_type_required_before_insurance":
      return {
        outcome: "needs_clarification",
        nextStep: "triage_visit_type",
        speak:
          "Ask whether this is for routine vision, glasses or contacts, or for medical or surgical eye care before checking insurance.",
        facts: { reason },
        retryable: true,
      };
    case "routine_vision_crystal_river_requires_route_to_spring_hill":
      return {
        outcome: "route_required",
        nextStep: "route_office",
        speak:
          "Routine vision scheduling for Crystal River callers must be routed to Spring Hill before continuing.",
        facts: { reason, routeTool: "route_to_spring_hill" },
        retryable: true,
      };
    case "availability_requires_visit_type":
      return {
        outcome: "needs_clarification",
        nextStep: "triage_visit_type",
        speak: "Ask what the visit is for before searching availability.",
        facts: { reason },
        retryable: true,
      };
    case "availability_duplicate_search_signature":
      return {
        outcome: "not_allowed",
        nextStep: "confirm_booking",
        speak:
          "Use the cached availability already in state, or ask for a different date before searching again.",
        facts: { reason },
        retryable: false,
      };
    case "availability_search_budget_exhausted":
      return {
        outcome: "not_allowed",
        nextStep: "get_availability",
        speak:
          "The exact search budget is exhausted. Broaden the date window, offer cached alternatives, or transfer if needed.",
        facts: { reason },
        retryable: false,
      };
    case "new_patient_requires_insurance_check_before_registration":
      return {
        outcome: "not_allowed",
        nextStep: "check_insurance",
        speak:
          "Check the caller's insurance before creating a new patient record.",
        facts: { reason },
        retryable: true,
      };
    case "booking_requires_verified_or_created_patient":
      return {
        outcome: "not_allowed",
        nextStep: "verify_patient",
        speak: "Verify or create the patient before booking.",
        facts: { reason },
        retryable: true,
      };
    case "booking_requires_recent_availability":
      return {
        outcome: "not_allowed",
        nextStep: "get_availability",
        speak:
          "Get current availability before booking. Do not book from memory or stale slots.",
        facts: { reason },
        retryable: true,
      };
    case "cancel_confirmation_not_tracked":
      return {
        outcome: "not_allowed",
        nextStep: "confirm_cancel",
        speak:
          "Read back the appointment and get explicit cancellation confirmation before cancelling.",
        facts: { reason },
        retryable: true,
      };
    case "cancel_requires_loaded_appointment":
      return {
        outcome: "not_allowed",
        nextStep: "confirm_cancel",
        speak:
          "Load the patient's appointments, choose the exact appointment, then confirm before cancelling.",
        facts: { reason },
        retryable: true,
      };
    case "update_insurance_requires_verified_patient":
      return {
        outcome: "not_allowed",
        nextStep: "verify_patient",
        speak: "Verify the patient before updating insurance.",
        facts: { reason },
        retryable: true,
      };
    default:
      return undefined;
  }
}

function evaluateBookingPolicy(
  flow: CallFlowState,
  booking: Omit<BookingAttemptRecordInput, "spokenSummary"> | undefined,
): { reason: GuardObservationReason; outcome: ToolOutcome } | undefined {
  if (!booking) {
    return {
      reason: "booking_requires_pending_action",
      outcome: {
        outcome: "not_allowed",
        nextStep: "confirm_booking",
        speak: "Confirm the exact slot before booking.",
        facts: { reason: "booking_requires_pending_action" },
        retryable: true,
      },
    };
  }

  const activeAction = findPendingBookingAction(flow, booking);
  if (activeAction?.slotInvalidated) {
    return invalidatedBookingOutcome();
  }
  if (activeAction) {
    if (!activeAction.confirmed) {
      return {
        reason: "booking_confirmation_required",
        outcome: {
          outcome: "not_allowed",
          nextStep: "confirm_booking",
          speak: "Get explicit confirmation for this exact appointment slot.",
          facts: {
            reason: "booking_confirmation_required",
            pendingActionId: activeAction.id,
          },
          retryable: true,
        },
      };
    }
    return undefined;
  }

  const consumedAction = findConsumedBookingAction(flow, booking);
  if (consumedAction?.consumed) {
    return consumedBookingOutcome(consumedAction.id);
  }

  return {
    reason: "booking_requires_pending_action",
    outcome: {
      outcome: "not_allowed",
      nextStep: "confirm_booking",
      speak: "Confirm the exact slot before booking.",
      facts: { reason: "booking_requires_pending_action" },
      retryable: true,
    },
  };
}

function evaluateHistoricalBookingPolicy(
  flow: CallFlowState,
  booking: Omit<BookingAttemptRecordInput, "spokenSummary"> | undefined,
): { reason: GuardObservationReason; outcome: ToolOutcome } | undefined {
  if (!booking) return undefined;

  const consumedAction = findConsumedBookingAction(flow, booking);
  if (consumedAction) {
    return consumedBookingOutcome(consumedAction.id);
  }

  const invalidatedAction = findInvalidatedBookingAction(flow, booking);
  if (invalidatedAction) {
    return invalidatedBookingOutcome();
  }

  return undefined;
}

function consumedBookingOutcome(pendingActionId: string): {
  reason: GuardObservationReason;
  outcome: ToolOutcome;
} {
  return {
    reason: "booking_action_already_consumed",
    outcome: {
      outcome: "success",
      nextStep: "answer",
      speak:
        "That booking action was already submitted. Do not submit it again.",
      facts: {
        reason: "booking_action_already_consumed",
        pendingActionId,
      },
      retryable: false,
    },
  };
}

function invalidatedBookingOutcome(): {
  reason: GuardObservationReason;
  outcome: ToolOutcome;
} {
  return {
    reason: "booking_slot_invalidated",
    outcome: {
      outcome: "not_allowed",
      nextStep: "get_availability",
      speak:
        "That slot was invalidated by a booking error. Offer a cached alternative or search availability again.",
      facts: { reason: "booking_slot_invalidated" },
      retryable: true,
    },
  };
}

function observationWithReason(
  observation: GuardObservation,
  reason: GuardObservationReason,
): GuardObservation {
  return {
    ...observation,
    allowed: false,
    enforcement: "block",
    reason,
  };
}
