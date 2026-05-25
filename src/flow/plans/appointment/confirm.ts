import type {
  AppointmentConfirmPlan,
  CallFlowState,
  WorkflowCommand,
} from "../../types.js";
import {
  command,
  existingPlanCreatedAt,
  isVerified,
  knownPatientFacts,
  taskPlanId,
} from "../common.js";

export function planConfirm(flow: CallFlowState): WorkflowCommand {
  const patientRef = flow.activePatientRef ?? "caller";
  const patient = flow.patients[patientRef];
  const id = taskPlanId(flow, "appointment_confirm");
  const verified = isVerified(patient, flow);
  const appointments = patient?.appointments ?? [];
  const phase: AppointmentConfirmPlan["phase"] = !verified
    ? "needs_lookup"
    : appointments.length > 0
      ? "complete"
      : "needs_lookup";
  const plan: AppointmentConfirmPlan = {
    id,
    kind: "appointment_confirm",
    taskFrameId: flow.currentTask?.id,
    patientRef,
    phase,
    objective: "read back the patient's upcoming appointment details",
    lookup: {
      phase: !verified
        ? "needs_verified_patient"
        : appointments.length > 0
          ? "appointments_loaded"
          : "loading_appointments",
      loadedAppointmentCount: appointments.length,
    },
    createdAt: existingPlanCreatedAt(flow, id),
    updatedAt: Date.now(),
  };

  if (!verified) {
    return command(flow, plan, {
      phase: "needs_verified_patient",
      knownFacts: knownPatientFacts(patient, flow),
      missingFacts: [
        { key: "patientIdentity", label: "verified patient identity" },
      ],
      nextAction: "ask",
      slot: "patientIdentity",
      allowedTools: ["verify_patient"],
      blockedActions: [
        {
          action: "confirm_appt",
          reason: "patient must be verified before appointment lookup",
        },
      ],
      instruction:
        "Ask for the patient's name and date of birth before looking up appointments.",
    });
  }

  if (appointments.length === 0) {
    return command(flow, plan, {
      phase: "loading_appointments",
      knownFacts: knownPatientFacts(patient, flow),
      missingFacts: [
        { key: "loadedAppointments", label: "current appointment list" },
      ],
      nextAction: "call_tool",
      tool: "confirm_appt",
      args: {},
      allowedTools: ["confirm_appt"],
      blockedActions: [],
      instruction: "Call confirm_appt now.",
    });
  }

  return command(flow, plan, {
    phase: "complete",
    knownFacts: [
      ...knownPatientFacts(patient, flow),
      {
        key: "appointments",
        value: `${appointments.length} loaded appointment(s)`,
      },
    ],
    missingFacts: [],
    nextAction: "respond",
    allowedTools: [],
    blockedActions: [],
    instruction:
      "Read back the loaded appointment details, then close this appointment-confirm task unless the caller asks for another change.",
  });
}
