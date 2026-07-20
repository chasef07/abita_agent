import {
  getOfficeProfileByPhone,
  type OfficeKey,
} from "../customers/abita/profile.js";
import type { CallState } from "./call-state.js";

export type TransferState = "idle" | "pending" | "accepted" | "ambiguous";

export function activeOfficeKey(state: CallState): OfficeKey {
  return state.office.activeKey;
}

export function resetActiveOfficeToTrunk(state: CallState): void {
  const office = getOfficeProfileByPhone(state.runtime.trunkPhone);
  state.office.activeKey = office.key;
  state.office.phoneOverrides[office.key] ??= office.amdOfficePhone;
}

export function runtimeCallerPhone(state: CallState): string {
  return state.runtime.callerPhone;
}

export function recordLatestUserTranscript(
  state: CallState,
  transcript: string,
): void {
  state.runtime.latestUserTranscript = transcript;
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
