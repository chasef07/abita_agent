import type {
  AppointmentActionAnalytics,
  CallState,
  OwnedMiddlewareFailureAnalytics,
  OwnedMiddlewareOperation,
  StaffTaskReceipt,
} from "./call-state.js";

export function recordAppointmentAction(
  state: CallState,
  action: AppointmentActionAnalytics,
): void {
  state.runtime.appointmentActions = [
    ...state.runtime.appointmentActions,
    {
      createdAt: new Date().toISOString(),
      ...action,
    },
  ];
}

export function appointmentActions(
  state: CallState,
): AppointmentActionAnalytics[] {
  return [...state.runtime.appointmentActions];
}

export function recordOwnedMiddlewareFailure(
  state: CallState,
  operation: OwnedMiddlewareOperation,
  failure: Pick<OwnedMiddlewareFailureAnalytics, "reason" | "detail">,
): void {
  state.runtime.ownedMiddlewareFailures = [
    ...state.runtime.ownedMiddlewareFailures,
    {
      createdAt: new Date().toISOString(),
      operation,
      ...failure,
    },
  ];
}

export function ownedMiddlewareFailures(
  state: CallState,
): OwnedMiddlewareFailureAnalytics[] {
  return [...state.runtime.ownedMiddlewareFailures];
}

export function staffTaskReceipts(state: CallState): StaffTaskReceipt[] {
  return [...state.runtime.staffTasks];
}

export function findStaffTaskReceipt(
  state: CallState,
  idempotencyKey: string,
): StaffTaskReceipt | null {
  return (
    state.runtime.staffTasks.find(
      (receipt) => receipt.idempotencyKey === idempotencyKey,
    ) ?? null
  );
}

export function recordStaffTaskReceipt(
  state: CallState,
  receipt: StaffTaskReceipt,
): void {
  state.runtime.staffTasks = [
    ...state.runtime.staffTasks.filter(
      (item) => item.idempotencyKey !== receipt.idempotencyKey,
    ),
    receipt,
  ];
}
