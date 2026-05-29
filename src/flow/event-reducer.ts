import { hashToolArgs } from "./guards.js";
import {
  createPendingBookingAction,
  invalidateAvailabilitySearches,
  rejectAvailabilitySlot,
} from "./availability.js";
import {
  consumePendingSideEffectAction,
  createPendingSideEffectAction,
  findPendingSideEffectAction,
  sideEffectActionTypeForTool,
  invalidatePendingActionsForStateChange,
  type SideEffectPendingAction,
  type SideEffectActionType,
  type SideEffectToolName,
} from "./pending-actions.js";
import { mergeCompletedSteps } from "./plans/common.js";
import {
  type TurnUnderstandingStateUpdate,
  reduceTurnUnderstandingFromTranscript,
} from "./turn-state-reducer.js";
import {
  applyPreCallIdentityFromTranscript,
  DEFAULT_PATIENT_REF,
  ensureActivePatientContext,
  nextPatientFlowStep,
  recordPatientVerificationAttempt,
  recordVerifiedPatient,
  updateActivePatientInsurance,
  type PreCallIdentityReducerResult,
  type PatientStateChangeResult,
} from "./state.js";
import type { FlowEvent } from "./events.js";
import {
  isTransferConfirmation,
  isTransferIntent,
  patientRefForMeaning,
} from "./events.js";
import type {
  CallFlowState,
  FlowTransition,
  FlowTransitionSnapshot,
} from "./types.js";

export interface FlowReduceResult {
  event: FlowEvent;
  before: FlowTransitionSnapshot;
  after: FlowTransitionSnapshot;
  transition: FlowTransition;
  update?: TurnUnderstandingStateUpdate;
  preCallIdentity?: PreCallIdentityReducerResult;
  patientChange?: PatientStateChangeResult;
  rescheduleProgressed?: boolean;
}

type AppliedFlowEventResult = Pick<
  FlowReduceResult,
  "update" | "preCallIdentity" | "patientChange" | "rescheduleProgressed"
>;

export function reduceFlowEvent(
  flow: CallFlowState,
  event: FlowEvent,
): FlowReduceResult {
  const before = snapshotFlowTransition(flow);
  const applied = applyFlowEvent(flow, event);
  invalidateCachedWorkflowCommandForEvent(flow, event, applied);
  const after = snapshotFlowTransition(flow);
  const transition = appendFlowTransition(flow, event, before, after);
  return {
    event,
    before,
    after,
    transition,
    ...applied,
  };
}

function applyFlowEvent(
  flow: CallFlowState,
  event: FlowEvent,
): AppliedFlowEventResult {
  switch (event.type) {
    case "caller_turn_meaning": {
      const hadRecoverableScheduling = hasRecoverableSchedulingTask(flow);
      const transferPushbackAlreadyOffered = flow.completedSteps.includes(
        "transfer_pushback_offered",
      );
      const update = reduceTurnUnderstandingFromTranscript(
        flow,
        event.transcript ?? "",
        event.understanding,
      );
      applyReducerOwnedTransferState(flow, event, {
        hadRecoverableScheduling,
        transferPushbackAlreadyOffered,
      });
      applyReducerOwnedBookingConfirmation(flow, event);
      applyReducerOwnedSideEffectConfirmation(flow, event);
      return { update };
    }
    case "pre_call_identity_observed":
      return {
        preCallIdentity: applyPreCallIdentityFromTranscript(
          flow,
          event.transcript,
        ),
      };
    case "confirmed_pre_call_caller_restored":
      applyConfirmedPreCallCallerRestoredEvent(flow);
      return {};
    case "workflow_fact_event":
      applyWorkflowFactEvent(flow, event.workflowEventType);
      return {};
    case "workflow_step_updated":
      applyWorkflowStepUpdatedEvent(flow, event);
      return {};
    case "patient_recorded":
      return { patientChange: applyPatientRecordedEvent(flow, event) };
    case "patient_payload_applied":
      applyPatientPayloadAppliedEvent(flow, event);
      return {};
    case "patient_session_cleared":
      flow.coverageType = undefined;
      flow.routing = undefined;
      flow.allowedProviders = undefined;
      flow.routingAmbiguous = undefined;
      flow.preauthRequired = undefined;
      return {};
    case "active_patient_status_synced":
      flow.patientStatus = event.patientStatus;
      return {};
    case "active_patient_appointments_recorded":
      applyActivePatientAppointmentsRecordedEvent(flow, event);
      return {};
    case "active_patient_appointment_removed":
      applyActivePatientAppointmentRemovedEvent(flow, event);
      return {};
    case "patient_verification_attempted":
      recordPatientVerificationAttempt(flow, {
        firstName: event.firstName,
        lastName: event.lastName,
        dob: event.dob,
        phone: event.phone,
      });
      return {};
    case "active_patient_insurance_updated":
      applyActivePatientInsuranceUpdatedEvent(flow, event);
      return {};
    case "insurance_checked":
      applyInsuranceCheckedEvent(flow, event);
      return {};
    case "routine_vision_office_ensured":
      applyRoutineVisionOfficeEnsuredEvent(flow, event);
      return {};
    case "office_routed":
      applyOfficeRoutedEvent(flow, event);
      return {};
    case "availability_visit_context_ensured":
      applyAvailabilityVisitContextEnsuredEvent(flow, event);
      return {};
    case "reschedule_replacement_booked":
      return {
        rescheduleProgressed: applyRescheduleReplacementBookedEvent(
          flow,
          event,
        ),
      };
    case "reschedule_old_appointment_cancelled":
      return {
        rescheduleProgressed: applyRescheduleOldAppointmentCancelledEvent(
          flow,
          event,
        ),
      };
    case "availability_invalidated":
      applyAvailabilityInvalidatedEvent(flow, event);
      return {};
    case "planner_command_applied":
      applyPlannerCommandEvent(flow, event);
      return {};
    case "tool_guard_observed":
      flow.lastGuardedToolCall = {
        name: event.toolName,
        argsHash: event.argsHash,
        guardAllowed: event.guardAllowed,
      };
      return {};
    case "side_effect_confirmation_requested":
      applySideEffectConfirmationRequestedEvent(flow, event);
      return {};
    case "side_effect_confirmed":
      applySideEffectConfirmedEvent(flow, event);
      return {};
    case "tool_succeeded":
      applyToolSucceededEvent(flow, event);
      return {};
    case "tool_failed":
      return {};
  }
}

function invalidateCachedWorkflowCommandForEvent(
  flow: CallFlowState,
  event: FlowEvent,
  applied: AppliedFlowEventResult,
): void {
  if (!flow.lastWorkflowCommand) return;
  if (!shouldInvalidateCachedWorkflowCommand(event, applied)) return;
  flow.lastWorkflowCommand = undefined;
}

function shouldInvalidateCachedWorkflowCommand(
  event: FlowEvent,
  applied: AppliedFlowEventResult,
): boolean {
  switch (event.type) {
    case "planner_command_applied":
    case "tool_guard_observed":
    case "tool_failed":
      return false;
    case "pre_call_identity_observed":
      return applied.preCallIdentity?.changed === true;
    default:
      return true;
  }
}

function setFlowStep(flow: CallFlowState, step: CallFlowState["step"]): void {
  flow.step = step;
  if (flow.currentTask) {
    flow.currentTask.step = step;
  }
}

function applyConfirmedPreCallCallerRestoredEvent(flow: CallFlowState): void {
  const preCall = flow.preCall;
  if (
    preCall?.status !== "single_match_confirmed" &&
    preCall?.status !== "multiple_match_confirmed"
  ) {
    return;
  }
  const selectedRef = preCall.selectedCandidateRef ?? DEFAULT_PATIENT_REF;
  const patient = flow.patients[selectedRef];
  if (!patient?.patientId) return;

  ensureActivePatientContext(flow, selectedRef);
  patient.status = "verified";
  flow.patientStatus = "verified";
  if (flow.currentTask?.patientRef?.startsWith("candidate:")) {
    flow.currentTask.patientRef = selectedRef;
  }
  if (flow.schedulingGoal?.patientRef?.startsWith("candidate:")) {
    flow.schedulingGoal.patientRef = selectedRef;
  }
}

function applyWorkflowStepUpdatedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "workflow_step_updated" }>,
): void {
  if (event.activeFlow) flow.activeFlow = event.activeFlow;
  flow.step = event.step;
  if (flow.currentTask) {
    flow.currentTask.step = event.step;
  }
}

function applyPlannerCommandEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "planner_command_applied" }>,
): void {
  const command = event.command;
  flow.taskPlans = {
    ...(flow.taskPlans ?? {}),
    [command.taskPlan.id]: command.taskPlan,
  };
  flow.activeTaskPlanId = command.taskPlan.id;
  flow.lastWorkflowCommand = command;

  applyPrepareSchedulingPathOutcome(flow, command);
  applyCommandTransition(flow, command);
  applyTransferPushbackCommand(flow, command);
}

function applyPrepareSchedulingPathOutcome(
  flow: CallFlowState,
  command: Extract<FlowEvent, { type: "planner_command_applied" }>["command"],
): void {
  const transition = command.resolvedMetaDecision?.outcome.transition;
  if (!transition) return;

  flow.activeFlow = transition.activeFlow;
  flow.step = transition.step;
  if (flow.currentTask) flow.currentTask.step = transition.step;
  flow.officeKey = transition.officeKey;
  if (transition.patientStatus) flow.patientStatus = transition.patientStatus;
  if (transition.visitType) flow.visitType = transition.visitType;
  if (transition.coverageType) flow.coverageType = transition.coverageType;
  if (transition.routing) flow.routing = transition.routing;
  if (transition.requiredSlots) flow.requiredSlots = transition.requiredSlots;
  if (transition.completedSteps) {
    flow.completedSteps = mergeCompletedSteps(
      flow.completedSteps,
      transition.completedSteps,
    );
  }
}

function applyCommandTransition(
  flow: CallFlowState,
  command: Extract<FlowEvent, { type: "planner_command_applied" }>["command"],
): void {
  if (command.step) {
    flow.step = command.step;
    if (flow.currentTask) flow.currentTask.step = command.step;
  }
  if (command.visitType) flow.visitType = command.visitType;
  if (command.coverageType) flow.coverageType = command.coverageType;
  if (command.pendingConfirmation) {
    flow.pendingConfirmation = command.pendingConfirmation;
  }
  if (command.schedulingGoal) {
    flow.schedulingGoal = command.schedulingGoal;
  }
}

function applyTransferPushbackCommand(
  flow: CallFlowState,
  command: Extract<FlowEvent, { type: "planner_command_applied" }>["command"],
): void {
  if (command.taskKind !== "transfer" || command.phase !== "pushback_offered") {
    return;
  }

  const resumed = schedulingTaskToResume(flow);
  flow.activeIntent = "new_appointment";
  flow.activeFlow = "scheduling";
  flow.step = resumed?.step ?? "get_availability";
  flow.completedSteps = mergeCompletedSteps(flow.completedSteps, [
    "transfer_pushback_offered",
  ]);
  if (resumed) {
    flow.currentTask = resumed;
    flow.taskStack = flow.taskStack.filter((task) => task.id !== resumed.id);
  }
}

function schedulingTaskToResume(flow: CallFlowState) {
  if (flow.currentTask?.kind === "schedule") return flow.currentTask;
  const returnTo = flow.currentTask?.returnTo;
  return [...flow.taskStack]
    .reverse()
    .find(
      (task) => task.kind === "schedule" && (!returnTo || task.id === returnTo),
    );
}

function applyReducerOwnedBookingConfirmation(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "caller_turn_meaning" }>,
): void {
  if (
    event.meaning.confirmation?.type !== "booking" &&
    event.meaning.confirmation?.type !== "reschedule"
  ) {
    return;
  }
  const selectedSlotId = flow.schedulingGoal?.selectedSlotId;
  if (!selectedSlotId) return;

  if (event.meaning.confirmation.confirmed === false) {
    invalidateRejectedBookingAction(flow, selectedSlotId, event.id);
    return;
  }
  if (event.meaning.confirmation.confirmed !== true) return;

  const cachedSlot = latestCachedSlotForBooking(flow, selectedSlotId);
  createPendingBookingAction(flow, {
    patientRef: flow.activePatientRef,
    slotHash: selectedSlotId,
    officeKey: cachedSlot?.officeKey ?? flow.officeKey,
    routing: cachedSlot?.routing ?? flow.routing,
    spokenSummary:
      cachedSlot?.startDatetime ?? `Slot ${selectedSlotId} confirmed by caller`,
    confirmed: true,
    createdTurnId: event.id,
    confirmationTurnId: event.id,
  });
  flow.step = "book";
  if (flow.currentTask) flow.currentTask.step = "book";
}

function latestCachedSlotForBooking(flow: CallFlowState, slotHash: string) {
  for (const search of [...flow.availabilitySearches].reverse()) {
    const slot = search.cachedSlots.find(
      (cached) => cached.slotHash === slotHash,
    );
    if (slot) {
      return {
        officeKey: search.officeKey,
        routing: search.routing,
        startDatetime: slot.startDatetime,
      };
    }
  }
  return undefined;
}

function applyPatientRecordedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "patient_recorded" }>,
): PatientStateChangeResult {
  return recordVerifiedPatient(flow, {
    patientId: event.patientId,
    patientName: event.patientName,
    dob: event.dob,
    phone: event.phone,
    appointments: event.appointments,
    appointmentsStatus: event.appointmentsStatus,
    source: event.slotSource,
  });
}

function applyPatientPayloadAppliedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "patient_payload_applied" }>,
): void {
  if (event.patientStatus === "created") {
    const patient = ensureActivePatientContext(flow);
    patient.status = "created";
    flow.patientStatus = "created";
    setFlowStep(flow, nextPatientFlowStep("created"));
  }

  flow.officeKey = event.officeKey;
  flow.routing = event.routing;
  flow.allowedProviders = event.allowedProviders;
  flow.routingAmbiguous = event.routingAmbiguous;
  flow.preauthRequired = event.preauthRequired;
  flow.coverageType = event.coverageType;
  if (event.visitType) {
    flow.visitType = event.visitType;
  }
  if (event.insurance?.plan || event.insurance?.canonicalPlan) {
    updateActivePatientInsurance(flow, {
      plan: event.insurance.plan ?? event.insurance.canonicalPlan,
      coverageType: event.insurance.coverageType,
      canonicalPlan: event.insurance.canonicalPlan ?? event.insurance.plan,
      currentCarrier: event.insurance.currentCarrier,
      source: event.insurance.source,
    });
  }
}

function applyActivePatientInsuranceUpdatedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "active_patient_insurance_updated" }>,
): void {
  updateActivePatientInsurance(flow, {
    plan: event.plan,
    coverageType: event.coverageType,
    canonicalPlan: event.canonicalPlan,
    currentCarrier: event.currentCarrier,
    source: event.slotSource,
  });
  flow.routing = event.routing ?? undefined;
  flow.allowedProviders = event.allowedProviders;
  flow.routingAmbiguous = event.routingAmbiguous;
  flow.preauthRequired = event.preauthRequired;
}

function applyActivePatientAppointmentsRecordedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "active_patient_appointments_recorded" }>,
): void {
  const patient = ensureActivePatientContext(flow);
  patient.appointments = event.appointments;
  if (event.appointmentsStatus) {
    patient.appointmentsStatus = event.appointmentsStatus;
  }
}

function applyActivePatientAppointmentRemovedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "active_patient_appointment_removed" }>,
): void {
  const patient = ensureActivePatientContext(flow);
  patient.appointments = patient.appointments.filter(
    (appointment) => appointment.id !== event.appointmentId,
  );
}

function applyInsuranceCheckedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "insurance_checked" }>,
): void {
  flow.officeKey = event.officeKey;
  flow.activeFlow = "insurance";
  setFlowStep(
    flow,
    event.status === "accepted"
      ? nextPatientFlowStep(flow.patientStatus)
      : "check_insurance",
  );
  flow.coverageType = event.coverageType ?? undefined;
  updateActivePatientInsurance(flow, {
    plan: event.canonicalPlan ? event.plan : null,
    coverageType: event.canonicalPlan ? event.coverageType : null,
    canonicalPlan: event.canonicalPlan ?? null,
    source: "caller_spoken",
  });
  if (event.coverageType === "routine_vision") {
    flow.visitType = "routine_vision";
    flow.routing = "optical_only";
    if (event.officeKey === "crystal-river" && event.status === "accepted") {
      flow.activeFlow = "routing";
      setFlowStep(flow, "route_office");
    }
  }
}

function applyRoutineVisionOfficeEnsuredEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "routine_vision_office_ensured" }>,
): void {
  flow.officeKey = event.officeKey;
  flow.activeFlow = "scheduling";
  flow.visitType = "routine_vision";
  flow.coverageType = "routine_vision";
  flow.routing = "optical_only";
}

function applyOfficeRoutedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "office_routed" }>,
): void {
  flow.officeKey = event.officeKey;
  flow.activeFlow = "scheduling";
  setFlowStep(flow, nextPatientFlowStep(flow.patientStatus));
}

function applyAvailabilityVisitContextEnsuredEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "availability_visit_context_ensured" }>,
): void {
  if (flow.visitType) return;
  flow.visitType = event.visitType;
  if (event.visitType === "routine_vision") {
    flow.coverageType = "routine_vision";
    flow.routing = "optical_only";
    return;
  }
  if (event.visitType === "medical" || event.visitType === "urgent") {
    flow.coverageType ??= "medical";
  }
}

function activeReschedulePlan(flow: CallFlowState) {
  const planId = flow.activeTaskPlanId;
  const plan = planId ? flow.taskPlans?.[planId] : undefined;
  return plan?.kind === "appointment_reschedule" ? plan : undefined;
}

function applyRescheduleReplacementBookedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "reschedule_replacement_booked" }>,
): boolean {
  const plan = activeReschedulePlan(flow);
  if (!plan || typeof plan.targetAppointmentId !== "number") return false;
  flow.taskPlans = {
    ...(flow.taskPlans ?? {}),
    [plan.id]: {
      ...plan,
      phase: "cancelling_old_appointment",
      replacementBookedAppointmentId: event.replacementBookedAppointmentId,
      oldCancelled: false,
      updatedAt: Date.now(),
    },
  };
  flow.activeIntent = "existing_appointment_reschedule";
  flow.activeFlow = "appointment_management";
  setFlowStep(flow, "cancel");
  createPendingSideEffectAction(flow, {
    type: "cancel_appt",
    argsHash: hashToolArgs({ appointmentId: plan.targetAppointmentId }),
    spokenSummary:
      plan.targetAppointmentSummary ??
      `Cancel appointment ${plan.targetAppointmentId}.`,
    patientRef: plan.patientRef ?? flow.activePatientRef,
    appointmentId: plan.targetAppointmentId,
    confirmed: true,
    createdTurnId: event.id,
    confirmationTurnId: event.id,
  });
  return true;
}

function applyRescheduleOldAppointmentCancelledEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "reschedule_old_appointment_cancelled" }>,
): boolean {
  const plan = activeReschedulePlan(flow);
  if (!plan || plan.targetAppointmentId !== event.appointmentId) return false;
  flow.taskPlans = {
    ...(flow.taskPlans ?? {}),
    [plan.id]: {
      ...plan,
      phase: "complete",
      oldCancelled: true,
      updatedAt: Date.now(),
    },
  };
  return true;
}

function applyAvailabilityInvalidatedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "availability_invalidated" }>,
): void {
  invalidateAvailabilitySearches(flow, event.reason);
  invalidatePendingActionsForStateChange(flow, event.reason);
}

function applySideEffectConfirmationRequestedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "side_effect_confirmation_requested" }>,
): void {
  const actionType = sideEffectActionTypeForTool(event.toolName);
  const action = createPendingSideEffectAction(flow, {
    type: actionType,
    argsHash: event.argsHash,
    spokenSummary: event.spokenSummary,
    patientRef: event.patientRef,
    appointmentId: event.appointmentId,
    requiredFieldsComplete: event.requiredFieldsComplete,
    confirmed: false,
    createdTurnId: event.toolCallId,
  });
  flow.pendingConfirmation = {
    type: confirmationTypeForSideEffectAction(action.type),
    payload: {
      pendingActionId: action.id,
      toolName: event.toolName,
      argsHash: event.argsHash,
      ...(typeof event.appointmentId === "number"
        ? { appointmentId: event.appointmentId }
        : {}),
      ...(event.requestedAfterTranscript
        ? { requestedAfterTranscript: event.requestedAfterTranscript }
        : {}),
    },
  };
}

function applySideEffectConfirmedEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "side_effect_confirmed" }>,
): void {
  const actionType = sideEffectActionTypeForTool(event.toolName);
  if (actionType === "cancel_appt" && typeof event.appointmentId === "number") {
    flow.pendingConfirmation = {
      type: "cancel",
      payload: { appointmentId: event.appointmentId },
    };
  }

  const action = createPendingSideEffectAction(flow, {
    type: actionType,
    argsHash: event.argsHash,
    spokenSummary: event.spokenSummary,
    patientRef: event.patientRef,
    appointmentId: event.appointmentId,
    requiredFieldsComplete: event.requiredFieldsComplete,
    confirmed: true,
    createdTurnId: event.toolCallId,
    confirmationTurnId: event.toolCallId,
  });
  action.confirmed = true;
  action.confirmationTurnId ??= event.toolCallId;
}

function applyReducerOwnedSideEffectConfirmation(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "caller_turn_meaning" }>,
): void {
  const confirmation = event.meaning.confirmation;
  if (!confirmation) return;

  switch (confirmation.type) {
    case "cancel":
      applyCancelConfirmation(flow, confirmation.confirmed, event.id);
      return;
    case "route_office":
      applyRouteConfirmation(flow, confirmation.confirmed, event.id);
      return;
    case "registration":
      applyPendingActionConfirmation(
        flow,
        "add_patient",
        confirmation.confirmed,
        event.id,
      );
      return;
    case "insurance_update":
      applyPendingActionConfirmation(
        flow,
        "update_insurance",
        confirmation.confirmed,
        event.id,
      );
      return;
    default:
      return;
  }
}

function applyCancelConfirmation(
  flow: CallFlowState,
  confirmed: boolean,
  eventId: string,
): void {
  const appointmentId = cancelAppointmentIdForConfirmation(flow);
  if (typeof appointmentId !== "number") {
    applyPendingActionConfirmation(flow, "cancel_appt", confirmed, eventId);
    return;
  }

  const argsHash = hashToolArgs({ appointmentId });
  const existing = findPendingSideEffectAction(flow, {
    type: "cancel_appt",
    argsHash,
    patientRef: flow.activePatientRef,
    appointmentId,
  });
  if (!confirmed) {
    invalidatePendingSideEffectAction(existing, "caller_rejected", eventId);
    flow.pendingConfirmation = undefined;
    return;
  }

  const action =
    existing ??
    createPendingSideEffectAction(flow, {
      type: "cancel_appt",
      argsHash,
      spokenSummary: `Cancel appointment ${appointmentId}.`,
      patientRef: flow.activePatientRef,
      appointmentId,
      confirmed: false,
      createdTurnId: eventId,
    });
  confirmPendingSideEffectAction(action, eventId);
  flow.pendingConfirmation = undefined;
}

function applyRouteConfirmation(
  flow: CallFlowState,
  confirmed: boolean,
  eventId: string,
): void {
  const argsHash = hashToolArgs({});
  const existing = findPendingSideEffectAction(flow, {
    type: "route_office",
    argsHash,
    patientRef: flow.activePatientRef,
  });
  if (!confirmed) {
    invalidatePendingSideEffectAction(existing, "caller_rejected", eventId);
    flow.pendingConfirmation = undefined;
    return;
  }

  const action =
    existing ??
    createPendingSideEffectAction(flow, {
      type: "route_office",
      argsHash,
      spokenSummary: "Switch scheduling to Spring Hill.",
      patientRef: flow.activePatientRef,
      confirmed: false,
      createdTurnId: eventId,
    });
  confirmPendingSideEffectAction(action, eventId);
  flow.pendingConfirmation = undefined;
}

function applyPendingActionConfirmation(
  flow: CallFlowState,
  actionType: SideEffectActionType,
  confirmed: boolean,
  eventId: string,
): void {
  const action =
    sideEffectActionFromPendingConfirmation(flow, actionType) ??
    latestOpenSideEffectAction(flow, actionType);
  if (!action) return;

  if (!confirmed) {
    invalidatePendingSideEffectAction(action, "caller_rejected", eventId);
    flow.pendingConfirmation = undefined;
    return;
  }

  confirmPendingSideEffectAction(action, eventId);
  flow.pendingConfirmation = undefined;
}

function confirmPendingSideEffectAction(
  action: SideEffectPendingAction,
  eventId: string,
): void {
  action.confirmed = true;
  action.confirmationTurnId = eventId;
}

function invalidatePendingSideEffectAction(
  action: SideEffectPendingAction | undefined,
  reason: string,
  eventId: string,
): void {
  if (!action || action.consumed || action.invalidated) return;
  action.invalidated = true;
  action.invalidationReason = reason;
  action.confirmationTurnId ??= eventId;
}

function sideEffectActionFromPendingConfirmation(
  flow: CallFlowState,
  actionType: SideEffectActionType,
): SideEffectPendingAction | undefined {
  const payload = flow.pendingConfirmation?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const pendingActionId = (payload as { pendingActionId?: unknown })
    .pendingActionId;
  if (typeof pendingActionId !== "string") return undefined;
  return flow.pendingActions.find(
    (action): action is SideEffectPendingAction =>
      action.type === actionType &&
      action.id === pendingActionId &&
      !action.consumed &&
      !action.invalidated,
  );
}

function latestOpenSideEffectAction(
  flow: CallFlowState,
  actionType: SideEffectActionType,
): SideEffectPendingAction | undefined {
  return [...flow.pendingActions]
    .reverse()
    .find(
      (action): action is SideEffectPendingAction =>
        action.type === actionType && !action.consumed && !action.invalidated,
    );
}

function cancelAppointmentIdForConfirmation(
  flow: CallFlowState,
): number | undefined {
  const pendingAppointmentId = appointmentIdFromPayload(
    flow.pendingConfirmation?.payload,
  );
  if (typeof pendingAppointmentId === "number") return pendingAppointmentId;

  const planId = flow.activeTaskPlanId;
  const plan = planId ? flow.taskPlans?.[planId] : undefined;
  return plan?.kind === "appointment_cancel"
    ? plan.targetAppointmentId
    : undefined;
}

function appointmentIdFromPayload(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const appointmentId = (payload as { appointmentId?: unknown }).appointmentId;
  return typeof appointmentId === "number" ? appointmentId : undefined;
}

function confirmationTypeForSideEffectAction(
  actionType: SideEffectActionType,
): NonNullable<CallFlowState["pendingConfirmation"]>["type"] {
  switch (actionType) {
    case "add_patient":
      return "registration";
    case "update_insurance":
      return "insurance_update";
    case "route_office":
      return "route_office";
    case "cancel_appt":
      return "cancel";
    case "transfer_call":
      return "transfer";
  }
}

function applyToolSucceededEvent(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "tool_succeeded" }>,
): void {
  if (isSideEffectToolName(event.toolName)) {
    consumePendingSideEffectAction(flow, {
      type: sideEffectActionTypeForTool(event.toolName),
      argsHash: event.argsHash ?? hashToolArgs({}),
      patientRef: event.patientRef ?? flow.activePatientRef,
      ...(typeof event.appointmentId === "number"
        ? { appointmentId: event.appointmentId }
        : {}),
    });
  }

  if (event.toolName === "cancel_appt") {
    flow.pendingConfirmation = undefined;
  }
  if (event.toolName === "route_to_spring_hill") {
    if (flow.pendingConfirmation?.type === "route_office") {
      flow.pendingConfirmation = undefined;
    }
    flow.officeKey = "spring-hill";
    flow.activeFlow = "scheduling";
    flow.step = nextPatientFlowStep(flow.patientStatus);
    if (flow.coverageType === "routine_vision") {
      flow.visitType = "routine_vision";
      flow.routing = "optical_only";
    }
    if (flow.currentTask) {
      flow.currentTask.step = flow.step;
    }
  }
}

function invalidateRejectedBookingAction(
  flow: CallFlowState,
  slotHash: string,
  eventId: string,
): void {
  rejectAvailabilitySlot(flow, slotHash, "caller_rejected");
  for (const action of flow.pendingActions) {
    if (
      action.type !== "book_appt" ||
      action.consumed ||
      action.slotHash !== slotHash
    ) {
      continue;
    }
    action.invalidated = true;
    action.invalidationReason = "caller_rejected";
    action.slotInvalidated = true;
    action.confirmationTurnId ??= eventId;
  }
}

function isSideEffectToolName(
  toolName: string,
): toolName is SideEffectToolName {
  return (
    toolName === "add_patient" ||
    toolName === "cancel_appt" ||
    toolName === "update_insurance" ||
    toolName === "route_to_spring_hill" ||
    toolName === "transfer_call"
  );
}

function applyWorkflowFactEvent(
  flow: CallFlowState,
  eventType: Extract<
    FlowEvent,
    { type: "workflow_fact_event" }
  >["workflowEventType"],
): void {
  switch (eventType) {
    case "booking_succeeded":
      if (flow.schedulingGoal) {
        flow.schedulingGoal = {
          ...flow.schedulingGoal,
          status: "booked",
          updatedAt: Date.now(),
        };
      }
      return;
    case "cancel_succeeded":
      flow.pendingConfirmation = undefined;
      return;
    default:
      return;
  }
}

function applyReducerOwnedTransferState(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "caller_turn_meaning" }>,
  previous: {
    hadRecoverableScheduling: boolean;
    transferPushbackAlreadyOffered: boolean;
  },
): void {
  if (!isTransferIntent(event.meaning.intent)) return;

  const transferConfirmed = isTransferConfirmation(event.meaning);
  if (transferConfirmed === true) {
    ensureTransferPendingAction(flow, event, true);
    if (flow.pendingConfirmation?.type === "transfer") {
      flow.pendingConfirmation = undefined;
    }
    return;
  }
  if (transferConfirmed === false) {
    return;
  }

  if (
    !previous.hadRecoverableScheduling ||
    previous.transferPushbackAlreadyOffered
  ) {
    ensureTransferPendingAction(flow, event, true);
    if (flow.pendingConfirmation?.type === "transfer") {
      flow.pendingConfirmation = undefined;
    }
  }
}

function ensureTransferPendingAction(
  flow: CallFlowState,
  event: Extract<FlowEvent, { type: "caller_turn_meaning" }>,
  confirmed: boolean,
): void {
  const patientRef =
    patientRefForMeaning(event.meaning) ?? flow.activePatientRef ?? "caller";
  const argsHash = hashToolArgs({});
  const existing = findPendingSideEffectAction(flow, {
    type: "transfer_call",
    argsHash,
    patientRef,
  });

  if (existing) {
    if (confirmed) {
      existing.confirmed = true;
      existing.confirmationTurnId = event.id;
    }
    return;
  }

  createPendingSideEffectAction(flow, {
    type: "transfer_call",
    argsHash,
    spokenSummary: "Transfer the caller to the office.",
    patientRef,
    confirmed,
    createdTurnId: event.id,
    ...(confirmed ? { confirmationTurnId: event.id } : {}),
  });
}

function hasRecoverableSchedulingTask(flow: CallFlowState): boolean {
  return (
    flow.currentTask?.kind === "schedule" ||
    flow.taskStack.some((task) => task.kind === "schedule")
  );
}

function snapshotFlowTransition(flow: CallFlowState): FlowTransitionSnapshot {
  const command = flow.lastWorkflowCommand;
  return {
    activeIntent: flow.activeIntent,
    activeFlow: flow.activeFlow,
    step: flow.step,
    activeTaskPlanId: flow.activeTaskPlanId,
    currentTaskId: flow.currentTask?.id,
    lastCommandTaskId: command?.taskId,
    lastCommandTaskKind: command?.taskKind,
    lastCommandPhase: command?.phase,
    lastCommandAction: command?.nextAction,
    lastCommandTool: command?.tool,
    lastCommandSuggestedTool: command?.suggestedTool,
    patientStatus: flow.patientStatus,
    pendingActions: flow.pendingActions.length,
    pendingActionState: flow.pendingActions
      .map((action) =>
        [
          action.id,
          action.type,
          action.confirmed ? "confirmed" : "unconfirmed",
          action.consumed ? "consumed" : "pending",
          action.invalidated ? "invalidated" : "valid",
        ].join(":"),
      )
      .join("|"),
  };
}

function appendFlowTransition(
  flow: CallFlowState,
  event: FlowEvent,
  before: FlowTransitionSnapshot,
  after: FlowTransitionSnapshot,
): FlowTransition {
  const transition: FlowTransition = {
    eventId: event.id,
    eventType: event.type,
    source: event.source,
    before,
    after,
    changed: changedTransitionFields(before, after),
    createdAt: Date.now(),
  };
  flow.transitionLog = [...(flow.transitionLog ?? []), transition];
  return transition;
}

function changedTransitionFields(
  before: FlowTransitionSnapshot,
  after: FlowTransitionSnapshot,
): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(before) as Array<
    keyof FlowTransitionSnapshot
  >) {
    if (before[key] !== after[key]) changed.push(key);
  }
  for (const key of Object.keys(after) as Array<keyof FlowTransitionSnapshot>) {
    if (!(key in before)) changed.push(key);
  }
  return [...new Set(changed)];
}
