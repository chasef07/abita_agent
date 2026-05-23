import type {
  CallFlowState,
  FlowStep,
  PendingAction,
  PatientRef,
} from "./types.js";

export type SideEffectPendingAction = Exclude<
  PendingAction,
  { type: "book_appt" }
>;

export type SideEffectActionType = SideEffectPendingAction["type"];

export type SideEffectToolName =
  | "add_patient"
  | "cancel_appt"
  | "update_insurance"
  | "route_to_spring_hill"
  | "transfer_call";

export interface PendingSideEffectActionInput {
  type: SideEffectActionType;
  argsHash: string;
  spokenSummary: string;
  patientRef?: PatientRef;
  appointmentId?: number;
  requiredFieldsComplete?: boolean;
  confirmed?: boolean;
  createdTurnId: string;
  confirmationTurnId?: string;
}

export interface SideEffectActionLookupInput {
  type: SideEffectActionType;
  argsHash: string;
  patientRef?: PatientRef;
  appointmentId?: number;
}

export function sideEffectActionTypeForTool(
  toolName: SideEffectToolName,
): SideEffectActionType {
  return toolName === "route_to_spring_hill" ? "route_office" : toolName;
}

export function nextStepForSideEffectAction(
  actionType: SideEffectActionType,
): FlowStep {
  switch (actionType) {
    case "add_patient":
      return "collect_registration";
    case "cancel_appt":
      return "cancel";
    case "route_office":
      return "route_office";
    case "transfer_call":
      return "handoff";
    case "update_insurance":
      return "check_insurance";
  }
}

export function createPendingSideEffectAction(
  flow: CallFlowState,
  input: PendingSideEffectActionInput,
): SideEffectPendingAction {
  const patientRef = input.patientRef ?? flow.activePatientRef ?? "caller";
  const existing = findSideEffectAction(flow, {
    type: input.type,
    argsHash: input.argsHash,
    patientRef,
    appointmentId: input.appointmentId,
    includeConsumed: true,
    includeInvalidated: true,
  });
  if (existing) return existing;

  const base = {
    id: `pending_${input.type}_${flow.pendingActions.length + 1}`,
    argsHash: input.argsHash,
    spokenSummary: input.spokenSummary,
    confirmed: input.confirmed ?? false,
    consumed: false,
    confirmationTurnId: input.confirmationTurnId,
    createdTurnId: input.createdTurnId,
    invalidated: false,
  };

  if (input.type === "cancel_appt") {
    if (typeof input.appointmentId !== "number") {
      throw new Error("cancel pending action requires appointmentId");
    }
    const action: SideEffectPendingAction = {
      ...base,
      type: "cancel_appt",
      patientRef,
      appointmentId: input.appointmentId,
    };
    flow.pendingActions.push(action);
    return action;
  }

  if (input.type === "add_patient") {
    const action: SideEffectPendingAction = {
      ...base,
      type: "add_patient",
      patientRef,
      requiredFieldsComplete: input.requiredFieldsComplete ?? true,
    };
    flow.pendingActions.push(action);
    return action;
  }

  const action: SideEffectPendingAction = {
    ...base,
    type: input.type,
    patientRef:
      input.type === "update_insurance" ? patientRef : input.patientRef,
  };
  flow.pendingActions.push(action);
  return action;
}

export function findPendingSideEffectAction(
  flow: CallFlowState,
  input: SideEffectActionLookupInput,
): SideEffectPendingAction | undefined {
  return findSideEffectAction(flow, input);
}

export function findConsumedSideEffectAction(
  flow: CallFlowState,
  input: SideEffectActionLookupInput,
): SideEffectPendingAction | undefined {
  return findSideEffectAction(flow, {
    ...input,
    consumed: true,
    includeConsumed: true,
  });
}

export function findInvalidatedSideEffectAction(
  flow: CallFlowState,
  input: SideEffectActionLookupInput,
): SideEffectPendingAction | undefined {
  return findSideEffectAction(flow, {
    ...input,
    includeInvalidated: true,
    invalidated: true,
  });
}

export function consumePendingSideEffectAction(
  flow: CallFlowState,
  input: SideEffectActionLookupInput,
): SideEffectPendingAction | undefined {
  const action = findPendingSideEffectAction(flow, input);
  if (!action) return undefined;
  action.consumed = true;
  return action;
}

export function invalidatePendingActionsForStateChange(
  flow: CallFlowState,
  reason: string,
): SideEffectPendingAction[] {
  const invalidated: SideEffectPendingAction[] = [];
  for (const action of flow.pendingActions) {
    if (action.type === "book_appt") {
      if (!action.consumed) {
        action.slotInvalidated = true;
        action.invalidated = true;
        action.invalidationReason = reason;
      }
      continue;
    }
    if (action.consumed || action.invalidated) continue;
    action.invalidated = true;
    action.invalidationReason = reason;
    invalidated.push(action);
  }
  return invalidated;
}

function findSideEffectAction(
  flow: CallFlowState,
  input: SideEffectActionLookupInput & {
    consumed?: boolean;
    invalidated?: boolean;
    includeConsumed?: boolean;
    includeInvalidated?: boolean;
  },
): SideEffectPendingAction | undefined {
  const patientRef = input.patientRef ?? flow.activePatientRef ?? "caller";
  return [...flow.pendingActions]
    .reverse()
    .find((action): action is SideEffectPendingAction => {
      if (action.type === "book_appt") return false;
      if (action.type !== input.type) return false;
      if (!input.includeConsumed && action.consumed) return false;
      if (input.consumed !== undefined && action.consumed !== input.consumed) {
        return false;
      }
      if (!input.includeInvalidated && action.invalidated) return false;
      if (
        input.invalidated !== undefined &&
        Boolean(action.invalidated) !== input.invalidated
      ) {
        return false;
      }
      if (action.argsHash !== input.argsHash) return false;
      if (
        "patientRef" in action &&
        action.patientRef &&
        action.patientRef !== patientRef
      ) {
        return false;
      }
      if (
        action.type === "cancel_appt" &&
        typeof input.appointmentId === "number" &&
        action.appointmentId !== input.appointmentId
      ) {
        return false;
      }
      return true;
    });
}
