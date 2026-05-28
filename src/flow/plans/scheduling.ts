import type {
  BlockedAction,
  CallFlowState,
  GenericTaskPlan,
  IntentKind,
  PlannerFact,
  SchedulingGoalState,
  WorkflowCommand,
  WorkflowToolName,
} from "../types.js";
import { classifyVisitType, prepareSchedulingPath } from "../scheduling.js";
import {
  command,
  genericPlan,
  isPlannerFact,
  knownPatientFacts,
  operationalBlockedActions,
} from "./common.js";

export interface PlanSchedulingOptions {
  pathFactsChanged?: boolean;
  preservePreferredWindowOnPathChange?: boolean;
}

export function planScheduling(
  flow: CallFlowState,
  options: PlanSchedulingOptions,
): WorkflowCommand {
  const taskKind = schedulingTaskKind(flow.activeIntent);
  const plan = genericPlan(
    flow,
    taskKind,
    objectiveForSchedulingTask(taskKind),
    flow.step,
  );
  const activeStepCommand = options.pathFactsChanged
    ? undefined
    : planActiveSchedulingStep(flow, plan, options);
  if (activeStepCommand) return activeStepCommand;
  const staleGoalPatch = options.pathFactsChanged
    ? schedulingGoalWithoutStaleSelection(flow.schedulingGoal, {
        preservePreferredWindow: options.preservePreferredWindowOnPathChange,
      })
    : undefined;

  const visitReason = flow.schedulingGoal?.visitReason;
  const visitType =
    flow.schedulingGoal?.visitType ??
    classifyVisitType(visitReason) ??
    (visitReason ? undefined : flow.visitType);
  const coverageType =
    flow.schedulingGoal?.visitType === "routine_vision" ||
    visitType === "routine_vision"
      ? "routine_vision"
      : visitType === "medical" || visitType === "urgent"
        ? "medical"
        : flow.schedulingGoal?.visitReason
          ? undefined
          : flow.coverageType;
  const insurancePlan = storedInsurancePlanForCoverage(flow, coverageType);
  const outcome = prepareSchedulingPath({
    officeKey: flow.officeKey,
    patientStatus: flow.patientStatus,
    visitReason,
    visitType: visitType ?? undefined,
    insurancePlan,
    coverageType,
  });
  const resolvedMetaDecision = {
    tool: "prepareSchedulingPath" as const,
    outcome,
  };

  if (outcome.outcome === "route_required") {
    if (flow.schedulingGoal?.routeConfirmed === true) {
      return command(flow, plan, {
        phase: "routing_office",
        knownFacts: schedulingKnownFacts(flow, outcome.facts),
        missingFacts: [],
        nextAction: "call_tool",
        tool: "route_to_spring_hill",
        args: {},
        allowedTools: ["route_to_spring_hill"],
        blockedActions: [
          {
            action: "get_availability",
            reason: "office routing must be completed first",
          },
        ],
        instruction: "Call route_to_spring_hill now.",
        step: "route_office",
        schedulingGoal: staleGoalPatch,
        resolvedMetaDecision,
      });
    }

    return command(flow, plan, {
      phase: "confirming_route",
      knownFacts: schedulingKnownFacts(flow, outcome.facts),
      missingFacts: [
        {
          key: "routeConfirmation",
          label: "caller agreement to continue through Spring Hill",
        },
      ],
      nextAction: "confirm",
      confirmationType: "route_office",
      allowedTools: [],
      blockedActions: [
        {
          action: "route_to_spring_hill",
          reason: "caller must agree to office routing first",
          until: "Spring Hill routing is confirmed",
        },
        {
          action: "get_availability",
          reason: "wrong office until routing is confirmed",
        },
      ],
      instruction:
        outcome.speak ??
        "Explain the office routing and ask if the caller wants to continue through Spring Hill.",
      step: "route_office",
      pendingConfirmation: {
        type: "route_office",
        payload: outcome.facts ?? {},
      },
      schedulingGoal: staleGoalPatch,
      resolvedMetaDecision,
    });
  }

  if (outcome.outcome === "transfer_required") {
    return command(flow, plan, {
      phase: "transfer_required",
      knownFacts: schedulingKnownFacts(flow, outcome.facts),
      missingFacts:
        flow.schedulingGoal?.transferConfirmed === true
          ? []
          : [
              {
                key: "transferConfirmation",
                label: "explicit agreement to transfer",
              },
            ],
      nextAction:
        flow.schedulingGoal?.transferConfirmed === true
          ? "call_tool"
          : "confirm",
      confirmationType: "transfer",
      tool:
        flow.schedulingGoal?.transferConfirmed === true
          ? "transfer_call"
          : undefined,
      args: flow.schedulingGoal?.transferConfirmed === true ? {} : undefined,
      allowedTools:
        flow.schedulingGoal?.transferConfirmed === true
          ? ["transfer_call"]
          : [],
      blockedActions: [
        {
          action: "get_availability",
          reason: "this request requires office handling",
        },
      ],
      instruction:
        outcome.speak ??
        "Explain this needs office handling and ask for agreement to transfer.",
      step: "handoff",
      pendingConfirmation: {
        type: "transfer",
        payload: outcome.facts ?? {},
      },
      schedulingGoal: staleGoalPatch,
      resolvedMetaDecision,
    });
  }

  if (outcome.outcome === "not_allowed") {
    return command(flow, plan, {
      phase: "cannot_continue",
      knownFacts: schedulingKnownFacts(flow, outcome.facts),
      missingFacts: [],
      nextAction: "respond",
      allowedTools: ["lookup_knowledge"],
      blockedActions: operationalBlockedActions(
        "scheduling path is not allowed for these facts",
      ),
      instruction:
        outcome.speak ?? "Explain why this scheduling path cannot continue.",
      step: "answer",
      schedulingGoal: staleGoalPatch,
      resolvedMetaDecision,
    });
  }

  const nextStep = outcome.nextStep;
  if (nextStep === "triage_visit_type") {
    return askSchedulingSlot(flow, plan, {
      phase: "collecting_visit_type",
      slot: "visitReason",
      label: "visit reason or whether this is routine vision versus medical",
      instruction:
        outcome.speak ??
        "Ask whether this is for routine vision, glasses or contacts, or medical or surgical eye care.",
      step: nextStep,
      schedulingGoal: staleGoalPatch,
      resolvedMetaDecision,
    });
  }
  if (nextStep === "check_insurance") {
    const planName = storedInsurancePlanForCoverage(flow, coverageType);
    if (planName && coverageType) {
      return command(flow, plan, {
        phase: "checking_insurance",
        knownFacts: schedulingKnownFacts(flow, outcome.facts),
        missingFacts: [
          {
            key: "insuranceCheck",
            label: "accepted insurance result",
          },
        ],
        nextAction: "call_tool",
        tool: "check_insurance",
        args: { plan: planName, coverageType },
        allowedTools: ["check_insurance"],
        blockedActions: [
          {
            action: "add_patient",
            reason: "insurance must be checked before registration",
          },
          {
            action: "get_availability",
            reason: "coverage must be resolved before availability",
          },
        ],
        instruction: "Call check_insurance now.",
        step: "check_insurance",
        schedulingGoal: staleGoalPatch,
        resolvedMetaDecision,
      });
    }
    return askSchedulingSlot(flow, plan, {
      phase: "collecting_insurance",
      slot: "insurancePlan",
      label: "insurance plan for this coverage type",
      instruction:
        outcome.speak ??
        "Ask which insurance plan they will be using before scheduling.",
      step: nextStep,
      schedulingGoal: staleGoalPatch,
      resolvedMetaDecision,
    });
  }
  if (nextStep === "verify_patient") {
    const preCallVerifyArgs = selectedPreCallVerifyArgs(flow);
    if (preCallVerifyArgs) {
      return command(flow, plan, {
        phase: "needs_verified_patient",
        knownFacts: schedulingKnownFacts(flow, outcome.facts),
        missingFacts: [],
        nextAction: "call_tool",
        tool: "verify_patient",
        args: preCallVerifyArgs,
        allowedTools: ["verify_patient"],
        blockedActions: [
          {
            action: "get_availability",
            reason: "patient must be verified before availability",
          },
          {
            action: "book_appt",
            reason: "patient must be verified before booking",
          },
        ],
        instruction:
          "Call verify_patient with the selected first name. Caller phone is loaded from state.",
        step: nextStep,
        schedulingGoal: staleGoalPatch,
        resolvedMetaDecision,
      });
    }
    return askSchedulingSlot(flow, plan, {
      phase: "needs_verified_patient",
      slot: isMultiplePreCallSelectionPending(flow)
        ? "patientFirstName"
        : "patientIdentity",
      label: isMultiplePreCallSelectionPending(flow)
        ? "patient first name"
        : "verified patient identity",
      allowedTools: ["verify_patient"],
      blockedActions: [
        {
          action: "get_availability",
          reason: "patient must be verified before availability",
        },
        {
          action: "book_appt",
          reason: "patient must be verified before booking",
        },
      ],
      instruction: verificationInstructionForState(
        flow,
        outcome.speak ?? "Ask for the patient's first name.",
      ),
      step: nextStep,
      schedulingGoal: staleGoalPatch,
      resolvedMetaDecision,
    });
  }
  if (nextStep === "collect_registration") {
    return command(flow, plan, {
      phase: "collecting_registration",
      knownFacts: schedulingKnownFacts(flow, outcome.facts),
      missingFacts: [
        {
          key: "registrationFields",
          label: "required new-patient registration fields",
        },
      ],
      nextAction: "ask",
      slot: "registrationFields",
      allowedTools: ["add_patient", "check_insurance"],
      blockedActions: [
        {
          action: "get_availability",
          reason: "patient record must be created before availability",
        },
        {
          action: "book_appt",
          reason: "patient record must be created before booking",
        },
      ],
      instruction:
        "Collect the missing registration fields and insurance details, then read them back before creating the patient.",
      step: "collect_registration",
      schedulingGoal: staleGoalPatch,
      resolvedMetaDecision,
    });
  }

  return planAvailabilityFrontier(flow, plan, {
    schedulingGoal: staleGoalPatch,
    resolvedMetaDecision,
  });
}

function planActiveSchedulingStep(
  flow: CallFlowState,
  plan: GenericTaskPlan,
  options: PlanSchedulingOptions,
): WorkflowCommand | undefined {
  if (
    flow.activeFlow !== "scheduling" &&
    flow.currentTask?.kind !== "schedule"
  ) {
    return undefined;
  }
  const goal = flow.schedulingGoal;
  const goalPatch = options.pathFactsChanged
    ? schedulingGoalWithoutStaleSelection(goal)
    : undefined;
  const effectiveGoal = goalPatch ?? goal;
  const latestCachedSearch = latestAvailabilitySearchWithCachedSlots(flow);
  const latestSearch = latestUsableAvailabilitySearch(flow);

  if (
    effectiveGoal?.bookingConfirmed === true &&
    effectiveGoal.selectedSlotId
  ) {
    const missingNoteFact = nextMissingBookingNoteFact(effectiveGoal);
    if (missingNoteFact) {
      return command(flow, plan, {
        phase: "collecting_booking_note",
        knownFacts: schedulingKnownFacts(flow),
        missingFacts: [missingNoteFact],
        nextAction: "ask",
        slot: missingNoteFact.key,
        allowedTools: [],
        blockedActions: [
          {
            action: "book_appt",
            reason: "booking note metadata must be collected before booking",
            until: missingNoteFact.label,
          },
        ],
        instruction: instructionForMissingBookingNoteFact(missingNoteFact.key),
        step: "collect_visit_reason",
        schedulingGoal: goalPatch,
      });
    }
    return command(flow, plan, {
      phase: "booking",
      knownFacts: schedulingKnownFacts(flow),
      missingFacts: [],
      nextAction: "call_tool",
      tool: "book_appt",
      args: bookingArgsForState(flow, effectiveGoal.selectedSlotId),
      allowedTools: ["book_appt"],
      blockedActions: [
        {
          action: "cancel_appt",
          reason: "caller is booking a selected slot",
        },
      ],
      instruction: "Call book_appt now.",
      step: "confirm_booking",
      schedulingGoal: goalPatch,
    });
  }

  if (
    flow.step === "get_availability" &&
    effectiveGoal?.preferredWindow &&
    !effectiveGoal.selectedSlotId
  ) {
    if (latestCachedSearch) {
      return askFromCachedAvailability(flow, plan, {
        schedulingGoal: goalPatch,
      });
    }
    if (latestSearch?.status === "exhausted") {
      return askAfterAvailabilityBudget(flow, plan, {
        schedulingGoal: goalPatch,
      });
    }
    if (latestSearch && availabilitySearchHasAttempts(latestSearch)) {
      return askAfterAvailabilityAttempt(flow, plan, {
        schedulingGoal: goalPatch,
      });
    }
    return command(flow, plan, {
      phase: "searching_availability",
      knownFacts: schedulingKnownFacts(flow),
      missingFacts: [
        {
          key: "availability",
          label: "available appointment slot",
        },
      ],
      nextAction: "call_tool",
      tool: "get_availability",
      args: {},
      allowedTools: ["get_availability"],
      blockedActions: [
        {
          action: "book_appt",
          reason: "availability must be searched before booking",
        },
      ],
      instruction: "Call get_availability now.",
      step: "get_availability",
      schedulingGoal: goalPatch,
    });
  }

  if (flow.step === "confirm_booking") {
    if (effectiveGoal?.bookingConfirmed === false) {
      const rejectedSlotId = effectiveGoal.selectedSlotId;
      const retryGoal = schedulingGoalWithoutStaleSelection(effectiveGoal, {
        preservePreferredWindow: true,
      });
      return planAvailabilityFrontier(flow, plan, {
        schedulingGoal: retryGoal,
        rejectedSlotId,
      });
    }

    return command(flow, plan, {
      phase: "confirming_booking",
      knownFacts: schedulingKnownFacts(flow),
      missingFacts: [
        {
          key: "bookingConfirmation",
          label: "explicit yes to the exact offered slot",
        },
      ],
      nextAction: "ask",
      slot: "bookingConfirmation",
      allowedTools: [],
      blockedActions: [
        {
          action: "book_appt",
          reason: "caller must explicitly confirm the offered slot",
          until: "exact appointment slot is confirmed",
        },
      ],
      instruction:
        "Ask whether they want the exact appointment slot that was just offered.",
      step: "confirm_booking",
      schedulingGoal: goalPatch,
    });
  }

  if (flow.step === "book") {
    if (!effectiveGoal?.selectedSlotId) {
      return command(flow, plan, {
        phase: "confirming_booking",
        knownFacts: schedulingKnownFacts(flow),
        missingFacts: [
          {
            key: "bookingConfirmation",
            label: "explicit yes to the exact offered slot",
          },
        ],
        nextAction: "ask",
        slot: "bookingConfirmation",
        allowedTools: [],
        blockedActions: [
          {
            action: "book_appt",
            reason: "slot must be selected and confirmed",
          },
        ],
        instruction:
          "Ask whether they want the exact appointment slot that was just offered.",
        step: "confirm_booking",
        schedulingGoal: goalPatch,
      });
    }
    const missingNoteFact = nextMissingBookingNoteFact(effectiveGoal);
    if (missingNoteFact) {
      return command(flow, plan, {
        phase: "collecting_booking_note",
        knownFacts: schedulingKnownFacts(flow),
        missingFacts: [missingNoteFact],
        nextAction: "ask",
        slot: missingNoteFact.key,
        allowedTools: [],
        blockedActions: [
          {
            action: "book_appt",
            reason: "booking note metadata must be collected before booking",
            until: missingNoteFact.label,
          },
        ],
        instruction: instructionForMissingBookingNoteFact(missingNoteFact.key),
        step: "collect_visit_reason",
        schedulingGoal: goalPatch,
      });
    }
    return command(flow, plan, {
      phase: "booking",
      knownFacts: schedulingKnownFacts(flow),
      missingFacts: [],
      nextAction: "call_tool",
      tool: "book_appt",
      args: bookingArgsForState(flow, effectiveGoal.selectedSlotId),
      allowedTools: ["book_appt"],
      blockedActions: [],
      instruction: "Call book_appt now.",
      step: "confirm_booking",
      schedulingGoal: goalPatch,
    });
  }

  return undefined;
}

function planAvailabilityFrontier(
  flow: CallFlowState,
  plan: GenericTaskPlan,
  input: {
    schedulingGoal?: SchedulingGoalState;
    resolvedMetaDecision?: WorkflowCommand["resolvedMetaDecision"];
    rejectedSlotId?: string;
  },
): WorkflowCommand {
  const preferredWindow =
    input.schedulingGoal !== undefined
      ? input.schedulingGoal?.preferredWindow
      : flow.schedulingGoal?.preferredWindow;
  if (!preferredWindow) {
    return askSchedulingSlot(flow, plan, {
      phase: "collecting_preferred_window",
      slot: "preferredDate",
      label: "day or time window for the appointment",
      instruction:
        "Ask what day or general time window works for the appointment.",
      schedulingGoal: input.schedulingGoal,
      resolvedMetaDecision: input.resolvedMetaDecision,
    });
  }
  const latestCachedSearch = latestAvailabilitySearchWithCachedSlots(flow);
  if (latestCachedSearch) {
    return askFromCachedAvailability(flow, plan, {
      rejectedSlotId: input.rejectedSlotId,
      schedulingGoal: input.schedulingGoal,
      resolvedMetaDecision: input.resolvedMetaDecision,
    });
  }
  const latestSearch = latestUsableAvailabilitySearch(flow);
  if (latestSearch?.status === "exhausted") {
    return askAfterAvailabilityBudget(flow, plan, {
      schedulingGoal: input.schedulingGoal,
      resolvedMetaDecision: input.resolvedMetaDecision,
    });
  }
  if (latestSearch && availabilitySearchHasAttempts(latestSearch)) {
    return askAfterAvailabilityAttempt(flow, plan, {
      schedulingGoal: input.schedulingGoal,
      resolvedMetaDecision: input.resolvedMetaDecision,
    });
  }

  return command(flow, plan, {
    phase: "searching_availability",
    knownFacts: schedulingKnownFacts(flow),
    missingFacts: [
      {
        key: "availability",
        label: "available appointment slot",
      },
    ],
    nextAction: "call_tool",
    tool: "get_availability",
    args: {},
    allowedTools: ["get_availability"],
    blockedActions: [
      {
        action: "book_appt",
        reason: "availability must be searched before booking",
      },
    ],
    instruction: "Call get_availability now.",
    step: "get_availability",
    schedulingGoal: input.schedulingGoal,
    resolvedMetaDecision: input.resolvedMetaDecision,
  });
}

function askFromCachedAvailability(
  flow: CallFlowState,
  plan: GenericTaskPlan,
  input: {
    rejectedSlotId?: string;
    schedulingGoal?: SchedulingGoalState;
    resolvedMetaDecision?: WorkflowCommand["resolvedMetaDecision"];
  } = {},
): WorkflowCommand {
  const rejectedText = input.rejectedSlotId
    ? ` Do not offer slot ${input.rejectedSlotId} again unless the caller asks for it.`
    : "";
  return command(flow, plan, {
    phase: "offering_cached_availability",
    knownFacts: schedulingKnownFacts(flow),
    missingFacts: [
      {
        key: "bookingConfirmation",
        label: "caller response to a cached available slot",
      },
    ],
    nextAction: "ask",
    slot: "bookingConfirmation",
    allowedTools: [],
    blockedActions: [
      {
        action: "book_appt",
        reason: "caller must explicitly confirm the offered slot",
      },
      {
        action: "get_availability",
        reason:
          "cached availability is already available for this scheduling request",
        until: "caller gives a different date, month, or time window",
      },
    ],
    instruction:
      "Offer one cached availability option or say the cached options do not match the requested window, then ask whether they want that option, a different window, or a transfer." +
      rejectedText,
    step: "confirm_booking",
    schedulingGoal: input.schedulingGoal,
    resolvedMetaDecision: input.resolvedMetaDecision,
  });
}

function askAfterAvailabilityBudget(
  flow: CallFlowState,
  plan: GenericTaskPlan,
  input: {
    schedulingGoal?: SchedulingGoalState;
    resolvedMetaDecision?: WorkflowCommand["resolvedMetaDecision"];
  } = {},
): WorkflowCommand {
  return command(flow, plan, {
    phase: "availability_budget_exhausted",
    knownFacts: schedulingKnownFacts(flow),
    missingFacts: [
      {
        key: "preferredDate",
        label: "broader or different appointment window",
      },
    ],
    nextAction: "ask",
    slot: "preferredDate",
    allowedTools: [],
    blockedActions: [
      {
        action: "get_availability",
        reason:
          "availability search budget is exhausted for the current request",
        until: "caller gives a different date, month, or time window",
      },
      {
        action: "book_appt",
        reason: "caller has not confirmed an available slot",
      },
    ],
    instruction:
      "Do not search again for the same window. Offer any cached options if present; otherwise ask for a different date or time window, or offer to transfer.",
    step: "confirm_booking",
    schedulingGoal: input.schedulingGoal,
    resolvedMetaDecision: input.resolvedMetaDecision,
  });
}

function askAfterAvailabilityAttempt(
  flow: CallFlowState,
  plan: GenericTaskPlan,
  input: {
    schedulingGoal?: SchedulingGoalState;
    resolvedMetaDecision?: WorkflowCommand["resolvedMetaDecision"];
  } = {},
): WorkflowCommand {
  return command(flow, plan, {
    phase: "availability_needs_clarification",
    knownFacts: schedulingKnownFacts(flow),
    missingFacts: [
      {
        key: "preferredDate",
        label: "different appointment window",
      },
    ],
    nextAction: "ask",
    slot: "preferredDate",
    allowedTools: [],
    blockedActions: [
      {
        action: "get_availability",
        reason: "availability was already checked for the current request",
        until: "caller gives a different date, month, or time window",
      },
      {
        action: "book_appt",
        reason: "caller has not confirmed an available slot",
      },
    ],
    instruction:
      "Do not search again for the same window. Say what was found or not found, then ask for a different date or time window, or offer to transfer.",
    step: "confirm_booking",
    schedulingGoal: input.schedulingGoal,
    resolvedMetaDecision: input.resolvedMetaDecision,
  });
}

function askSchedulingSlot(
  flow: CallFlowState,
  plan: GenericTaskPlan,
  input: {
    phase: string;
    slot: string;
    label: string;
    allowedTools?: WorkflowToolName[];
    blockedActions?: BlockedAction[];
    instruction: string;
    step?: CallFlowState["step"];
    schedulingGoal?: SchedulingGoalState;
    resolvedMetaDecision?: WorkflowCommand["resolvedMetaDecision"];
  },
): WorkflowCommand {
  return command(flow, plan, {
    phase: input.phase,
    knownFacts: schedulingKnownFacts(flow),
    missingFacts: [{ key: input.slot, label: input.label }],
    nextAction: "ask",
    slot: input.slot,
    allowedTools: input.allowedTools ?? [],
    blockedActions:
      input.blockedActions ??
      operationalBlockedActions("required scheduling fact is still missing"),
    instruction: input.instruction,
    step: input.step,
    schedulingGoal: input.schedulingGoal,
    resolvedMetaDecision: input.resolvedMetaDecision,
  });
}

function selectedPreCallVerifyArgs(
  flow: CallFlowState,
): { firstName: string } | null {
  if (flow.preCall?.status !== "multiple_match_selected_pending_verification") {
    return null;
  }

  const patient =
    flow.patients[
      flow.activePatientRef ?? flow.preCall.selectedCandidateRef ?? ""
    ];
  const firstName = patient?.firstName?.value;
  if (!firstName) return null;

  return { firstName };
}

function isMultiplePreCallSelectionPending(flow: CallFlowState): boolean {
  return (
    flow.preCall?.status === "multiple_matches_pending_selection" &&
    flow.preCall.identityPromotion !== "verify_patient_required"
  );
}

function verificationInstructionForState(
  flow: CallFlowState,
  fallback: string,
): string {
  if (isMultiplePreCallSelectionPending(flow)) {
    return "Ask for the patient's first name only.";
  }
  if (flow.preCall?.status === "multiple_match_selected_pending_verification") {
    return "Call verify_patient with the selected first name. Caller phone is loaded from state.";
  }
  return fallback;
}

export function isSchedulingOrInsuranceIntent(
  intent: IntentKind | null,
): intent is
  | "new_appointment"
  | "new_patient_registration"
  | "insurance_question" {
  return (
    intent === "new_appointment" ||
    intent === "new_patient_registration" ||
    intent === "insurance_question"
  );
}

function schedulingTaskKind(
  intent: IntentKind | null,
): GenericTaskPlan["kind"] {
  if (intent === "insurance_question") return "insurance";
  if (intent === "new_patient_registration") return "registration";
  return "scheduling";
}

function objectiveForSchedulingTask(kind: GenericTaskPlan["kind"]): string {
  switch (kind) {
    case "insurance":
      return "resolve insurance coverage before scheduling or answering";
    case "registration":
      return "create a new patient record before scheduling";
    case "scheduling":
      return "schedule an appointment through the safe booking sequence";
    default:
      return "continue the active workflow";
  }
}

function schedulingGoalWithoutStaleSelection(
  goal: SchedulingGoalState | undefined,
  options: { preservePreferredWindow?: boolean } = {},
): SchedulingGoalState | undefined {
  if (!goal) return undefined;
  const next: SchedulingGoalState = {
    ...goal,
    status:
      goal.status === "confirming_booking"
        ? "ready_for_availability"
        : goal.status,
    updatedAt: Date.now(),
  };
  delete next.selectedSlotId;
  delete next.bookingConfirmed;
  if (!options.preservePreferredWindow) {
    delete next.preferredWindow;
  }
  return next;
}

function latestAvailabilitySearchWithCachedSlots(flow: CallFlowState) {
  return [...flow.availabilitySearches]
    .reverse()
    .find(
      (search) =>
        search.status !== "invalidated" && search.cachedSlots.length > 0,
    );
}

function latestUsableAvailabilitySearch(flow: CallFlowState) {
  return [...flow.availabilitySearches]
    .reverse()
    .find((search) => search.status !== "invalidated");
}

function availabilitySearchHasAttempts(
  search: NonNullable<ReturnType<typeof latestUsableAvailabilitySearch>>,
): boolean {
  return search.exactSearchCount > 0 || search.duplicateSearchCount > 0;
}

function storedInsurancePlanForCoverage(
  flow: CallFlowState,
  coverageType: CallFlowState["coverageType"],
): string | undefined {
  const insurance = activePatientInsurance(flow);
  if (!insurance || !coverageType || insurance.coverageType !== coverageType) {
    return undefined;
  }
  return insurance.canonicalPlan ?? insurance.plan?.value;
}

function activePatientInsurance(flow: CallFlowState) {
  return flow.patients[flow.activePatientRef ?? "caller"]?.insurance;
}

function schedulingKnownFacts(
  flow: CallFlowState,
  facts: Record<string, unknown> | undefined = undefined,
): PlannerFact[] {
  const goal = flow.schedulingGoal;
  return [
    ...knownPatientFacts(
      flow.patients[flow.activePatientRef ?? "caller"],
      flow,
    ),
    flow.visitType ? { key: "visitType", value: flow.visitType } : undefined,
    flow.coverageType
      ? { key: "coverageType", value: flow.coverageType }
      : undefined,
    flow.routing ? { key: "routing", value: flow.routing } : undefined,
    goal?.visitReason ? { key: "visitReason", value: "known" } : undefined,
    goal?.noteDraft?.appointmentReason
      ? { key: "appointmentReason", value: "known" }
      : undefined,
    goal?.noteDraft?.referringDoctor
      ? { key: "referringDoctor", value: "known" }
      : undefined,
    goal?.preferredWindow
      ? { key: "preferredWindow", value: goal.preferredWindow }
      : undefined,
    goal?.selectedSlotId
      ? { key: "selectedSlot", value: goal.selectedSlotId }
      : undefined,
    goal?.bookingConfirmed
      ? { key: "bookingConfirmed", value: "true" }
      : undefined,
    facts?.allowedOffice
      ? { key: "allowedOffice", value: String(facts.allowedOffice) }
      : undefined,
    facts?.canonicalPlan
      ? { key: "canonicalPlan", value: String(facts.canonicalPlan) }
      : undefined,
  ].filter(isPlannerFact);
}

type BookingAppointmentKind = "medical" | "routine_vision" | "post_op";

function bookingArgsForState(
  state: CallFlowState,
  slotId: string,
): {
  slotId: string;
  appointmentKind: BookingAppointmentKind;
  appointmentReason: string;
  referringDoctor: string;
} {
  const note = notePayloadForBooking(state);
  return {
    slotId,
    appointmentKind: appointmentKindForState(state),
    appointmentReason: note.appointmentReason,
    referringDoctor: note.referringDoctor,
  };
}

function appointmentKindForState(state: CallFlowState): BookingAppointmentKind {
  if (
    state.routing === "optical_only" ||
    state.visitType === "routine_vision" ||
    state.schedulingGoal?.visitType === "routine_vision"
  ) {
    return "routine_vision";
  }
  if (looksLikePostOpVisit(state.schedulingGoal?.visitReason)) {
    return "post_op";
  }
  return "medical";
}

function notePayloadForBooking(flow: CallFlowState): {
  appointmentReason: string;
  referringDoctor: string;
} {
  const draft = flow.schedulingGoal?.noteDraft;
  return {
    appointmentReason:
      draft?.appointmentReason ??
      flow.schedulingGoal?.visitReason ??
      "appointment",
    referringDoctor: draft?.referringDoctor ?? "none",
  };
}

function nextMissingBookingNoteFact(
  goal: SchedulingGoalState | undefined,
): { key: "appointmentReason" | "referringDoctor"; label: string } | undefined {
  const reason = cleanBookingNoteValue(
    goal?.noteDraft?.appointmentReason ?? goal?.visitReason,
  );
  if (!reason || isGenericBookingReason(reason)) {
    return {
      key: "appointmentReason",
      label: "appointment reason",
    };
  }

  if (!cleanBookingNoteValue(goal?.noteDraft?.referringDoctor)) {
    return {
      key: "referringDoctor",
      label: 'referring doctor or "none"',
    };
  }

  return undefined;
}

function instructionForMissingBookingNoteFact(
  key: "appointmentReason" | "referringDoctor",
): string {
  if (key === "appointmentReason") {
    return "Ask for the appointment reason before booking.";
  }
  return "Ask who referred them, or whether there is no referring doctor. Do not ask for surgery details; the appointment reason is already known.";
}

function cleanBookingNoteValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isGenericBookingReason(value: string): boolean {
  return /^(appointment|appt|visit|office visit|booking)$/i.test(value.trim());
}

function looksLikePostOpVisit(visitReason: string | undefined): boolean {
  const normalized = visitReason?.trim().toLowerCase() ?? "";
  return /\bpost\s*-?\s*op\b|\bpost\s+operative\b|\bpostoperative\b|\bsurgery\s+follow\s*-?\s*up\b|\brecent\s+surgery\b/.test(
    normalized,
  );
}
