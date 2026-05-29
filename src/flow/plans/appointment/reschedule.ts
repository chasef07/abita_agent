import type {
  AppointmentReschedulePlan,
  BlockedAction,
  CallFlowState,
  CallerAppointment,
  PatientContext,
  PlannerFact,
  WorkflowCommand,
} from "../../types.js";
import { resolveSchedulingVisitType } from "../../scheduling.js";
import {
  command,
  existingPlanOfKind,
  isPlannerFact,
  isVerified,
  knownPatientFacts,
  taskPlanId,
} from "../common.js";
import {
  appointmentLookupKnownFact,
  mergeEvidence,
  resolveTargetAppointment,
  resolveAppointmentLookup,
  speakableAppointmentSummary,
  verifiedPatientResolveArgs,
} from "./shared.js";

const RESCHEDULE_BLOCKED_ACTIONS: BlockedAction[] = [
  {
    action: "book_appt",
    reason:
      "replacement slot and explicit full reschedule confirmation required",
    until: "offered replacement slot is confirmed",
  },
  {
    action: "cancel_appt",
    reason: "book the replacement appointment before cancelling the old one",
  },
];

export function planReschedule(flow: CallFlowState): WorkflowCommand {
  const patientRef = flow.activePatientRef ?? "caller";
  const patient = flow.patients[patientRef];
  const id = taskPlanId(flow, "appointment_reschedule");
  const existingPlan = existingPlanOfKind<AppointmentReschedulePlan>(
    flow,
    id,
    "appointment_reschedule",
  );
  if (existingPlan?.phase === "partial_failure") {
    return command(flow, existingPlan, {
      phase: "partial_failure",
      knownFacts: knownRescheduleFacts(
        flow.patients[flow.activePatientRef ?? "caller"],
        flow,
        existingPlan,
      ),
      missingFacts: [
        {
          key: "officeRecovery",
          label: "human recovery for partially completed reschedule",
        },
      ],
      nextAction: "call_tool",
      tool: "transfer_call",
      args: {},
      allowedTools: ["transfer_call"],
      blockedActions: [
        {
          action: "book_appt",
          reason: "replacement may already be booked; human recovery required",
        },
      ],
      instruction:
        'Route to the office for recovery because the replacement was booked but the old appointment was not safely cancelled. Say "I\'m going to transfer you to the office now. They may be with a patient, so please leave a message and we will get back to you as soon as possible." Then call transfer_call once.',
      step: "handoff",
    });
  }
  if (existingPlan?.phase === "complete") {
    return command(flow, existingPlan, {
      phase: "complete",
      knownFacts: knownRescheduleFacts(
        flow.patients[flow.activePatientRef ?? "caller"],
        flow,
        existingPlan,
      ),
      missingFacts: [],
      nextAction: "complete",
      allowedTools: [],
      blockedActions: [],
      instruction:
        "Tell the caller the appointment has been rescheduled and ask if they need anything else.",
      step: "answer",
    });
  }
  const verified = isVerified(patient, flow);
  const appointments = patient?.appointments ?? [];
  const lookup = resolveAppointmentLookup(
    verified,
    appointments,
    existingPlan?.lookup,
    patient?.appointmentsStatus,
  );
  const evidence = mergeEvidence(
    existingPlan?.targetSelectionEvidence,
    flow.schedulingGoal?.evidence,
  );
  const selection = resolveTargetAppointment(
    appointments,
    evidence,
    existingPlan?.targetAppointmentId,
  );
  const oldAppointment = selection.appointment;
  const preferredWindow = flow.schedulingGoal?.preferredWindow;
  const replacementVisitType = resolveSchedulingVisitType(
    flow.schedulingGoal?.visitReason,
    flow.schedulingGoal?.visitType,
  );
  const replacementCoverageType =
    coverageTypeForVisitType(replacementVisitType);
  const replacementRouting = routingForVisitType(flow, replacementVisitType);
  const latestAvailability = latestUsableAvailability(flow, {
    visitType: replacementVisitType,
    coverageType: replacementCoverageType,
    routing: replacementRouting,
  });
  const selectedReplacementSlotId =
    flow.schedulingGoal?.selectedSlotId ?? existingPlan?.replacementSlotId;
  const replacementSlotId =
    selectedReplacementSlotId &&
    availabilityHasSlot(latestAvailability, selectedReplacementSlotId)
      ? selectedReplacementSlotId
      : firstCachedSlot(latestAvailability);
  const rescheduleConfirmed =
    flow.schedulingGoal?.bookingConfirmed === true ||
    existingPlan?.rescheduleConfirmed === true;
  const note = notePayloadForReschedule(flow, oldAppointment, existingPlan);
  const phase = reschedulePhase({
    verified,
    appointments,
    selectionStatus: selection.status,
    replacementVisitType,
    preferredWindow,
    latestAvailability,
    replacementSlotId,
    rescheduleConfirmed,
  });
  const effectivePhase: AppointmentReschedulePlan["phase"] =
    verified && (lookup.noneFound || lookup.lookupFailed) ? "complete" : phase;
  const plan: AppointmentReschedulePlan = {
    id,
    kind: "appointment_reschedule",
    taskFrameId: flow.currentTask?.id,
    patientRef,
    phase: effectivePhase,
    objective: "replace the selected existing appointment with a new slot",
    lookup: lookup.subplan,
    targetAppointmentId: oldAppointment?.id,
    targetAppointmentSummary: oldAppointment
      ? speakableAppointmentSummary(oldAppointment)
      : undefined,
    targetSelectionStatus: selection.status,
    targetSelectionEvidence: evidence,
    replacementSlotId,
    replacementSlotSummary: replacementSlotId
      ? `replacement slot ${replacementSlotId}`
      : undefined,
    appointmentReason: note.appointmentReason,
    referringDoctor: note.referringDoctor,
    rescheduleConfirmed,
    replacementBookedAppointmentId:
      existingPlan?.replacementBookedAppointmentId,
    oldCancelled: existingPlan?.oldCancelled,
    createdAt: existingPlan?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };

  if (!verified) {
    return command(flow, plan, {
      phase,
      knownFacts: knownRescheduleFacts(patient, flow, plan),
      missingFacts: [
        { key: "patientIdentity", label: "verified patient identity" },
      ],
      nextAction: "ask",
      slot: "patientIdentity",
      allowedTools: ["verify_patient"],
      blockedActions: RESCHEDULE_BLOCKED_ACTIONS,
      instruction:
        "Ask for the patient's first name before changing an existing appointment.",
    });
  }

  if (lookup.noneFound) {
    return command(flow, plan, {
      phase: "complete",
      knownFacts: [
        ...knownRescheduleFacts(patient, flow, plan),
        appointmentLookupKnownFact(lookup),
      ],
      missingFacts: [],
      nextAction: "respond",
      allowedTools: [],
      blockedActions: RESCHEDULE_BLOCKED_ACTIONS,
      instruction:
        "Tell the caller you do not see any upcoming appointments to reschedule, then ask if they would like to schedule a new appointment.",
    });
  }

  if (lookup.lookupFailed) {
    return command(flow, plan, {
      phase: "complete",
      knownFacts: [
        ...knownRescheduleFacts(patient, flow, plan),
        appointmentLookupKnownFact(lookup),
      ],
      missingFacts: [],
      nextAction: "respond",
      allowedTools: [],
      blockedActions: RESCHEDULE_BLOCKED_ACTIONS,
      instruction:
        "Tell the caller the appointment lookup is unavailable right now, and offer to transfer them for rescheduling help.",
    });
  }

  if (lookup.needsLookup) {
    const resolveArgs = verifiedPatientResolveArgs(patient);
    if (!resolveArgs) {
      return command(flow, plan, {
        phase,
        knownFacts: knownRescheduleFacts(patient, flow, plan),
        missingFacts: [
          { key: "patientIdentity", label: "verified patient identity" },
        ],
        nextAction: "ask",
        slot: "patientIdentity",
        allowedTools: ["verify_patient"],
        blockedActions: RESCHEDULE_BLOCKED_ACTIONS,
        instruction:
          "Ask for the patient's first name before changing an existing appointment.",
      });
    }
    return command(flow, plan, {
      phase,
      knownFacts: knownRescheduleFacts(patient, flow, plan),
      missingFacts: [
        { key: "loadedAppointments", label: "current appointment list" },
      ],
      nextAction: "call_tool",
      tool: "verify_patient",
      args: resolveArgs,
      allowedTools: ["verify_patient"],
      blockedActions: RESCHEDULE_BLOCKED_ACTIONS,
      instruction:
        "Call verify_patient with the patient's first name to load appointments. Caller phone is loaded from state.",
    });
  }

  if (selection.status !== "selected") {
    return command(flow, plan, {
      phase,
      knownFacts: knownRescheduleFacts(patient, flow, plan),
      missingFacts: [
        {
          key: "oldAppointment",
          label: "which existing appointment should be moved",
        },
      ],
      nextAction: "ask",
      slot: "oldAppointment",
      allowedTools: [],
      blockedActions: RESCHEDULE_BLOCKED_ACTIONS,
      instruction:
        "Ask which existing appointment they want to move before searching replacement availability.",
    });
  }

  if (
    typeof plan.replacementBookedAppointmentId === "number" &&
    oldAppointment &&
    !plan.oldCancelled
  ) {
    return command(flow, plan, {
      phase: "cancelling_old_appointment",
      knownFacts: knownRescheduleFacts(patient, flow, plan),
      missingFacts: [],
      nextAction: "call_tool",
      tool: "cancel_appt",
      args: { appointmentId: oldAppointment.id },
      allowedTools: ["cancel_appt"],
      blockedActions: [
        {
          action: "book_appt",
          reason: "replacement appointment is already booked",
        },
      ],
      instruction:
        "Call cancel_appt now for the old appointment so the reschedule is completed.",
      step: "cancel",
    });
  }

  if (!replacementVisitType || !replacementCoverageType) {
    return command(flow, plan, {
      phase,
      knownFacts: knownRescheduleFacts(patient, flow, plan),
      missingFacts: [
        {
          key: "replacementVisitType",
          label:
            "whether the replacement appointment is routine vision or medical",
        },
      ],
      nextAction: "ask",
      slot: "visitReason",
      allowedTools: [],
      blockedActions: RESCHEDULE_BLOCKED_ACTIONS,
      instruction:
        "Ask whether the replacement appointment is for routine vision, glasses or contacts, or for medical eye care.",
      step: "triage_visit_type",
    });
  }

  if (!preferredWindow) {
    return command(flow, plan, {
      phase,
      knownFacts: knownRescheduleFacts(patient, flow, plan),
      missingFacts: [
        {
          key: "replacementWindow",
          label: "day or time window for the replacement appointment",
        },
      ],
      nextAction: "ask",
      slot: "preferredDate",
      allowedTools: [],
      blockedActions: RESCHEDULE_BLOCKED_ACTIONS,
      instruction:
        "Ask what day or time window works for the replacement appointment.",
    });
  }

  if (!latestAvailability?.cachedSlots.length && !replacementSlotId) {
    return command(flow, plan, {
      phase,
      knownFacts: knownRescheduleFacts(patient, flow, plan),
      missingFacts: [
        {
          key: "replacementAvailability",
          label: "available replacement appointment slot",
        },
      ],
      nextAction: "call_tool",
      tool: "get_availability",
      args: {},
      allowedTools: ["get_availability"],
      blockedActions: RESCHEDULE_BLOCKED_ACTIONS,
      instruction: "Call get_availability now.",
      step: "get_availability",
      visitType: replacementVisitType,
      coverageType: replacementCoverageType,
      schedulingGoalStatus: "ready_for_availability",
    });
  }

  if (!flow.schedulingGoal?.selectedSlotId || !rescheduleConfirmed) {
    return command(flow, plan, {
      phase,
      knownFacts: knownRescheduleFacts(patient, flow, plan),
      missingFacts: [
        {
          key: "rescheduleConfirmation",
          label:
            "explicit yes to replace the old appointment with the offered slot",
        },
      ],
      nextAction: "ask",
      slot: "rescheduleConfirmation",
      allowedTools: [],
      blockedActions: RESCHEDULE_BLOCKED_ACTIONS,
      instruction:
        "Offer one replacement slot and ask for explicit confirmation to replace the old appointment with that exact slot.",
      step: "confirm_booking",
    });
  }

  return command(flow, plan, {
    phase: "booking_replacement",
    knownFacts: knownRescheduleFacts(patient, flow, plan),
    missingFacts: [],
    nextAction: "call_tool",
    tool: "book_appt",
    args: {
      slotId: flow.schedulingGoal.selectedSlotId,
      appointmentKind: appointmentKindForReschedule(flow, replacementVisitType),
      appointmentReason: note.appointmentReason,
      referringDoctor: note.referringDoctor,
    },
    allowedTools: ["book_appt"],
    blockedActions: [
      {
        action: "cancel_appt",
        reason:
          "book the replacement appointment before cancelling the old one",
      },
    ],
    instruction: "Call book_appt now for the replacement appointment.",
    step: "book",
  });
}

function knownRescheduleFacts(
  patient: PatientContext | undefined,
  flow: CallFlowState,
  plan: AppointmentReschedulePlan,
): PlannerFact[] {
  return [
    ...knownPatientFacts(patient, flow),
    plan.targetAppointmentSummary
      ? { key: "oldAppointment", value: plan.targetAppointmentSummary }
      : undefined,
    flow.schedulingGoal?.preferredWindow
      ? {
          key: "preferredWindow",
          value: flow.schedulingGoal.preferredWindow,
        }
      : undefined,
    plan.replacementSlotId
      ? { key: "replacementSlot", value: plan.replacementSlotId }
      : undefined,
    plan.appointmentReason
      ? { key: "appointmentReason", value: plan.appointmentReason }
      : undefined,
    plan.referringDoctor
      ? { key: "referringDoctor", value: plan.referringDoctor }
      : undefined,
    typeof plan.replacementBookedAppointmentId === "number"
      ? {
          key: "replacementBookedAppointment",
          value: String(plan.replacementBookedAppointmentId),
        }
      : undefined,
    plan.oldCancelled
      ? {
          key: "oldAppointmentCancelled",
          value: "true",
        }
      : undefined,
  ].filter(isPlannerFact);
}

function latestUsableAvailability(
  flow: CallFlowState,
  input: {
    visitType?: CallFlowState["visitType"] | null;
    coverageType?: CallFlowState["coverageType"] | null;
    routing?: CallFlowState["routing"] | null;
  } = {},
) {
  return [...flow.availabilitySearches].reverse().find((search) => {
    if (search.status === "invalidated") return false;
    if (input.visitType && search.visitType !== input.visitType) {
      return false;
    }
    if (input.coverageType && search.coverageType !== input.coverageType) {
      return false;
    }
    if (input.routing && search.routing !== input.routing) {
      return false;
    }
    return true;
  });
}

function firstCachedSlot(
  search: ReturnType<typeof latestUsableAvailability>,
): string | undefined {
  return search?.cachedSlots[0]?.slotHash;
}

function availabilityHasSlot(
  search: ReturnType<typeof latestUsableAvailability>,
  slotId: string,
): boolean {
  const normalized = slotId.trim().toUpperCase();
  return Boolean(
    search?.cachedSlots.some(
      (slot) => slot.slotHash.trim().toUpperCase() === normalized,
    ),
  );
}

function reschedulePhase({
  verified,
  appointments,
  selectionStatus,
  replacementVisitType,
  preferredWindow,
  latestAvailability,
  replacementSlotId,
  rescheduleConfirmed,
}: {
  verified: boolean;
  appointments: CallerAppointment[];
  selectionStatus: AppointmentReschedulePlan["targetSelectionStatus"];
  replacementVisitType?: CallFlowState["visitType"] | null;
  preferredWindow?: string;
  latestAvailability: ReturnType<typeof latestUsableAvailability>;
  replacementSlotId?: string;
  rescheduleConfirmed: boolean;
}): AppointmentReschedulePlan["phase"] {
  if (!verified) return "needs_verified_patient";
  if (appointments.length === 0) return "loading_existing_appointments";
  if (selectionStatus !== "selected") return "selecting_old_appointment";
  if (!replacementVisitType) return "collecting_replacement_visit_type";
  if (!preferredWindow) return "collecting_replacement_window";
  if (!latestAvailability?.cachedSlots.length && !replacementSlotId) {
    return "searching_replacement";
  }
  if (!replacementSlotId) return "offering_replacement";
  if (!rescheduleConfirmed) return "confirming_reschedule";
  return "booking_replacement";
}

function notePayloadForReschedule(
  flow: CallFlowState,
  oldAppointment: CallerAppointment | undefined,
  existingPlan: AppointmentReschedulePlan | undefined,
): { appointmentReason: string; referringDoctor: string } {
  const draft = flow.schedulingGoal?.noteDraft;
  return {
    appointmentReason:
      draft?.appointmentReason ??
      flow.schedulingGoal?.visitReason ??
      existingPlan?.appointmentReason ??
      oldAppointment?.type ??
      "existing appointment reschedule",
    referringDoctor:
      draft?.referringDoctor ?? existingPlan?.referringDoctor ?? "none",
  };
}

function appointmentKindForReschedule(
  flow: CallFlowState,
  replacementVisitType: CallFlowState["visitType"],
): "medical" | "routine_vision" | "post_op" {
  if (replacementVisitType === "routine_vision") {
    return "routine_vision";
  }
  const reason = `${flow.schedulingGoal?.visitReason ?? ""}`.toLowerCase();
  if (
    /\bpost\s*-?\s*op\b|\bpost\s+operative\b|\bpostoperative\b|\bsurgery\s+follow\s*-?\s*up\b|\brecent\s+surgery\b/.test(
      reason,
    )
  ) {
    return "post_op";
  }
  return "medical";
}

function coverageTypeForVisitType(
  visitType: CallFlowState["visitType"] | null,
): CallFlowState["coverageType"] | undefined {
  if (visitType === "routine_vision") return "routine_vision";
  if (visitType === "medical" || visitType === "urgent") return "medical";
  return undefined;
}

function routingForVisitType(
  flow: CallFlowState,
  visitType: CallFlowState["visitType"] | null,
): CallFlowState["routing"] | undefined {
  if (visitType === "routine_vision") return "optical_only";
  if (visitType === "medical") return flow.routing;
  return undefined;
}
