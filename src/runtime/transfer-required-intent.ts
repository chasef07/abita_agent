import { llm } from "@livekit/agents";
import type { CallState, TransferRequiredReason } from "../state/call-state.js";

export function transferRequiredReasonFromTranscript(
  transcript: string,
): TransferRequiredReason | null {
  const normalized = normalizeIntentText(transcript);
  if (!normalized) return null;

  const isOpticalPrescription =
    /\b(contact\s*lens(?:es)?|contacts?|glasses|eyeglasses?)\b/.test(
      normalized,
    ) && /\bprescription\b/.test(normalized);
  if (!isOpticalPrescription) return null;

  if (
    /\b(verification|verify|verifying|status|update|updating|copy|send|sent|fax|faxed|release|record)\b/.test(
      normalized,
    )
  ) {
    return "contact_lens_prescription_verification";
  }

  return null;
}

export function recordTransferRequiredIntent(
  state: CallState,
  reason: TransferRequiredReason,
): boolean {
  if (state.runtime.transferred) return false;
  if (state.runtime.pendingTransferRequiredReason === reason) return false;
  state.runtime.pendingTransferRequiredReason = reason;
  return true;
}

export function transferRequiredSystemMessage(
  reason: TransferRequiredReason,
): string {
  switch (reason) {
    case "contact_lens_prescription_verification":
      return (
        "Internal state: the caller asked for contact lens prescription verification, which requires office staff. " +
        "Call transfer_call now. Do not collect patient registration details, check availability, or schedule this as a routine vision appointment."
      );
  }
}

export function ensureNoPendingTransferRequiredIntent(
  state: CallState,
  action: string,
): void {
  const reason = state.runtime.pendingTransferRequiredReason;
  if (!reason || state.runtime.transferred) return;

  throw new llm.ToolError(
    `${transferRequiredActionLabel(reason)} requires transfer to office staff. Call transfer_call instead of ${action}.`,
  );
}

function transferRequiredActionLabel(reason: TransferRequiredReason): string {
  switch (reason) {
    case "contact_lens_prescription_verification":
      return "Contact lens prescription verification";
  }
}

function normalizeIntentText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
