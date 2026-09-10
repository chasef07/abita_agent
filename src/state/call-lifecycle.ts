import {
  getOfficeProfileByPhone,
  type OfficeProfile,
  type OfficeKey,
} from "../customers/abita/profile.js";
import type { CallState } from "./call-state.js";

const officeContextControllers = new WeakMap<CallState, AbortController>();

export function officeContextSignal(state: CallState): AbortSignal {
  let controller = officeContextControllers.get(state);
  if (!controller) {
    controller = new AbortController();
    officeContextControllers.set(state, controller);
  }
  return controller.signal;
}

export type TransferState = "idle" | "pending" | "accepted" | "ambiguous";

export function activeOfficeKey(state: CallState): OfficeKey {
  return state.office.activeKey;
}

export function resetActiveOfficeToTrunk(state: CallState): void {
  const office = getOfficeProfileByPhone(state.runtime.trunkPhone);
  activateOffice(state, office);
}

export function activateOffice(
  state: CallState,
  office: Pick<OfficeProfile, "amdOfficePhone" | "key">,
): void {
  if (state.office.activeKey !== office.key) {
    officeContextControllers.get(state)?.abort();
    officeContextControllers.delete(state);
  }
  state.office.activeKey = office.key;
  state.office.phoneOverrides[office.key] ??= office.amdOfficePhone;
}

export function runtimeCallerPhone(state: CallState): string {
  return state.runtime.callerPhone;
}

export function transferStatus(state: CallState): TransferState {
  return state.runtime.transferState;
}

export function transferIsAccepted(state: CallState): boolean {
  return transferStatus(state) === "accepted";
}

export function transferIsAmbiguous(state: CallState): boolean {
  return transferStatus(state) === "ambiguous";
}

export function beginTransfer(state: CallState): void {
  state.runtime.transferState = "pending";
}

export function acceptTransfer(state: CallState): void {
  state.runtime.transferState = "accepted";
}

export function markTransferAmbiguous(state: CallState): void {
  state.runtime.transferState = "ambiguous";
}
