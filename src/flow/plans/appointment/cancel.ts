import type {
  AppointmentCancelPlan,
  CallFlowState,
  CallerAppointment,
  PatientContext,
  PlannerFact,
  WorkflowCommand,
} from "../../types.js";
import {
  command,
  existingPlanOfKind,
  isPlannerFact,
  isVerified,
  knownPatientFacts,
  taskPlanId,
} from "../common.js";
import {
  mergeEvidence,
  resolveTargetAppointment,
  speakableAppointmentSummary,
} from "./shared.js";

export function planCancel(flow: CallFlowState): WorkflowCommand {
  const patientRef = flow.activePatientRef ?? "caller";
  const patient = flow.patients[patientRef];
  const id = taskPlanId(flow, "appointment_cancel");
  const existingPlan = existingPlanOfKind<AppointmentCancelPlan>(
    flow,
    id,
    "appointment_cancel",
  );
  const verified = isVerified(patient, flow);
  const appointments = patient?.appointments ?? [];
  const evidence = mergeEvidence(
    existingPlan?.targetSelectionEvidence,
    flow.schedulingGoal?.evidence,
  );
  const selection = resolveTargetAppointment(
    appointments,
    evidence,
    existingPlan?.targetAppointmentId,
  );
  const targetAppointment = selection.appointment;
  const cancelConfirmed =
    flow.schedulingGoal?.cancelConfirmed === true ||
    existingPlan?.cancelConfirmed === true;
  const phase = cancelPhase({
    verified,
    appointments,
    selectionStatus: selection.status,
    cancelConfirmed,
  });
  const plan: AppointmentCancelPlan = {
    id,
    kind: "appointment_cancel",
    taskFrameId: flow.currentTask?.id,
    patientRef,
    phase,
    objective: "cancel one selected existing appointment after confirmation",
    lookup: {
      phase: !verified
        ? "needs_verified_patient"
        : appointments.length > 0
          ? "appointments_loaded"
          : "loading_appointments",
      loadedAppointmentCount: appointments.length,
    },
    targetAppointmentId: targetAppointment?.id,
    targetAppointmentSummary: targetAppointment
      ? speakableAppointmentSummary(targetAppointment)
      : undefined,
    targetSelectionStatus: selection.status,
    targetSelectionEvidence: evidence,
    cancelConfirmed,
    createdAt: existingPlan?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };

  if (!verified) {
    return command(flow, plan, {
      phase,
      knownFacts: knownPatientFacts(patient, flow),
      missingFacts: [
        { key: "patientIdentity", label: "verified patient identity" },
      ],
      nextAction: "ask",
      slot: "patientIdentity",
      allowedTools: ["verify_patient"],
      blockedActions: [
        {
          action: "cancel_appt",
          reason: "patient must be verified before cancellation",
        },
      ],
      instruction:
        "Ask for the patient's name and date of birth before cancelling an appointment.",
      step: "verify_patient",
    });
  }

  if (appointments.length === 0) {
    return command(flow, plan, {
      phase,
      knownFacts: knownPatientFacts(patient, flow),
      missingFacts: [
        { key: "loadedAppointments", label: "current appointment list" },
      ],
      nextAction: "call_tool",
      tool: "confirm_appt",
      args: {},
      allowedTools: ["confirm_appt"],
      blockedActions: [
        {
          action: "cancel_appt",
          reason: "appointment list must be loaded before cancellation",
        },
      ],
      instruction: "Call confirm_appt now.",
      step: "confirm_cancel",
    });
  }

  if (selection.status !== "selected") {
    return command(flow, plan, {
      phase,
      knownFacts: knownAppointmentFacts(patient, flow, plan),
      missingFacts: [
        {
          key: "oldAppointment",
          label: "which existing appointment should be cancelled",
        },
      ],
      nextAction: "ask",
      slot: "oldAppointment",
      allowedTools: [],
      blockedActions: [
        {
          action: "cancel_appt",
          reason: "exact appointment must be selected before cancellation",
        },
      ],
      instruction:
        "Ask which existing appointment they want to cancel before reading back a cancellation confirmation.",
      step: "confirm_cancel",
    });
  }

  if (!cancelConfirmed) {
    return command(flow, plan, {
      phase,
      knownFacts: knownAppointmentFacts(patient, flow, plan),
      missingFacts: [
        {
          key: "cancelConfirmation",
          label: "explicit yes to cancel the selected appointment",
        },
      ],
      nextAction: "confirm",
      slot: "cancelConfirmation",
      confirmationType: "cancel",
      allowedTools: [],
      blockedActions: [
        {
          action: "cancel_appt",
          reason: "caller must explicitly confirm the exact cancellation",
          until: "selected appointment is read back and confirmed",
        },
      ],
      instruction:
        "Read back the selected appointment and ask for explicit confirmation before cancelling it.",
      step: "confirm_cancel",
      pendingConfirmation: {
        type: "cancel",
        payload: {
          patientRef,
          appointmentId: targetAppointment?.id,
        },
      },
    });
  }

  return command(flow, plan, {
    phase,
    knownFacts: knownAppointmentFacts(patient, flow, plan),
    missingFacts: [],
    nextAction: "call_tool",
    tool: "cancel_appt",
    args: { appointmentId: targetAppointment?.id },
    allowedTools: ["cancel_appt"],
    blockedActions: [
      {
        action: "book_appt",
        reason: "caller asked to cancel, not book a new appointment",
      },
    ],
    instruction: "Call cancel_appt now for the selected appointment.",
    step: "cancel",
  });
}

function knownAppointmentFacts(
  patient: PatientContext | undefined,
  flow: CallFlowState,
  plan: AppointmentCancelPlan,
): PlannerFact[] {
  return [
    ...knownPatientFacts(patient, flow),
    plan.targetAppointmentSummary
      ? { key: "targetAppointment", value: plan.targetAppointmentSummary }
      : undefined,
    plan.cancelConfirmed
      ? { key: "cancelConfirmed", value: "true" }
      : undefined,
  ].filter(isPlannerFact);
}

function cancelPhase({
  verified,
  appointments,
  selectionStatus,
  cancelConfirmed,
}: {
  verified: boolean;
  appointments: CallerAppointment[];
  selectionStatus: AppointmentCancelPlan["targetSelectionStatus"];
  cancelConfirmed: boolean;
}): AppointmentCancelPlan["phase"] {
  if (!verified) return "needs_lookup";
  if (appointments.length === 0) return "needs_lookup";
  if (selectionStatus !== "selected") return "selecting_appointment";
  if (!cancelConfirmed) return "confirming_cancel";
  return "cancelling";
}
