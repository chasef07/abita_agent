import type {
  AppointmentConfirmPlan,
  CallFlowState,
  WorkflowCommand,
} from "../../types.js";
import {
  command,
  existingPlanOfKind,
  existingPlanCreatedAt,
  isVerified,
  knownPatientFacts,
  taskPlanId,
} from "../common.js";
import {
  appointmentLookupKnownFact,
  resolveAppointmentLookup,
} from "./shared.js";

export function planConfirm(flow: CallFlowState): WorkflowCommand {
  const patientRef = flow.activePatientRef ?? "caller";
  const patient = flow.patients[patientRef];
  const id = taskPlanId(flow, "appointment_confirm");
  const existingPlan = existingPlanOfKind<AppointmentConfirmPlan>(
    flow,
    id,
    "appointment_confirm",
  );
  const verified = isVerified(patient, flow);
  const appointments = patient?.appointments ?? [];
  const lookup = resolveAppointmentLookup(
    verified,
    appointments,
    existingPlan?.lookup,
  );
  const phase: AppointmentConfirmPlan["phase"] = !verified
    ? "needs_lookup"
    : lookup.complete
      ? "complete"
      : "needs_lookup";
  const plan: AppointmentConfirmPlan = {
    id,
    kind: "appointment_confirm",
    taskFrameId: flow.currentTask?.id,
    patientRef,
    phase,
    objective: "read back the patient's upcoming appointment details",
    lookup: lookup.subplan,
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
      allowedTools: ["resolve_patient"],
      blockedActions: [
        {
          action: "resolve_patient",
          reason: "patient must be verified before appointment lookup",
        },
      ],
      instruction:
        "Ask for the patient's name and date of birth before looking up appointments.",
    });
  }

  if (lookup.noneFound) {
    return command(flow, plan, {
      phase: "complete",
      knownFacts: [
        ...knownPatientFacts(patient, flow),
        appointmentLookupKnownFact(lookup),
      ],
      missingFacts: [],
      nextAction: "respond",
      allowedTools: [],
      blockedActions: [],
      instruction:
        "Tell the caller you do not see any upcoming appointments, then ask if they would like to schedule one.",
    });
  }

  if (lookup.needsLookup) {
    return command(flow, plan, {
      phase: "loading_appointments",
      knownFacts: knownPatientFacts(patient, flow),
      missingFacts: [
        { key: "loadedAppointments", label: "current appointment list" },
      ],
      nextAction: "call_tool",
      tool: "resolve_patient",
      args: { mode: "appointments" },
      allowedTools: ["resolve_patient"],
      blockedActions: [],
      instruction: "Call resolve_patient with mode appointments now.",
    });
  }

  return command(flow, plan, {
    phase: "complete",
    knownFacts: [
      ...knownPatientFacts(patient, flow),
      appointmentLookupKnownFact(lookup),
    ],
    missingFacts: [],
    nextAction: "respond",
    allowedTools: [],
    blockedActions: [],
    instruction:
      "Read back the loaded appointment details, then close this appointment-confirm task unless the caller asks for another change.",
  });
}
