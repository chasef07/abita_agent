import {
  confirmIdentityFromTranscript,
  type TranscriptIdentityConfirmation,
} from "../identity/promotion.js";

export type PreCallTranscriptConfirmation = TranscriptIdentityConfirmation;
export const confirmPreCallIdentityFromTranscript =
  confirmIdentityFromTranscript;
