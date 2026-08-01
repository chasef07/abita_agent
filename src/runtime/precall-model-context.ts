import { ChatContext } from "@livekit/agents";
import type { PhoneLookupResult } from "../state/call-state.js";

export type ModelFacingLookupStatus =
  "single_match" | "multiple_matches" | "no_match" | "lookup_failed";

export const CALLER_IDENTITY_INSTRUCTIONS = `<caller_identity_policy>
The initial system chat context contains exactly one pre-call phone lookup status: single_match, multiple_matches, no_match, or lookup_failed.
Use that status only after the caller asks for patient-specific help. It describes the lookup outcome while new-or-existing status remains unknown.
For single_match or multiple_matches, keep the number of lookup records private and use the same identity question.
When the patient's first name is still needed, ask the same privacy-safe question for either status.
In English, say exactly: "To help with the appointment, could you spell the patient's first name?"
In Spanish, say exactly: "Para ayudar con la cita, ¿podría deletrear el primer nombre del paciente?"
Before every reply, runtime tries to match any caller-provided first name to a preloaded patient.
If runtime provides confirmed-patient context, continue directly with that context. Reserve resolve_patient for an unconfirmed identity or a patient switch.
Keep hidden candidate details private until identity is confirmed.
When runtime leaves identity unconfirmed after the supplied first name, collect full identity and use resolve_patient as the last resort for existing-patient lookup.
Use resolve_patient to switch to a different patient when needed.
After identity is confirmed, use the selected patient's name, insurance carrier when loaded, and appointments from the current turn's internal system message or the latest resolve_patient result.
</caller_identity_policy>`;

export function modelFacingLookupStatus(
  lookup: PhoneLookupResult,
): ModelFacingLookupStatus {
  if (!lookup) return "lookup_failed";
  return lookup.status === "verified" ? "single_match" : lookup.status;
}

export function createInitialLookupChatContext(
  status: ModelFacingLookupStatus,
): ChatContext {
  const chatCtx = ChatContext.empty();
  chatCtx.addMessage({ role: "system", content: status });
  return chatCtx;
}
