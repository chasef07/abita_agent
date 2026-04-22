import { llm, voice } from "@livekit/agents";
import { z } from "zod";
import { buildTaskPrompt } from "../prompt.js";
import {
  buildWorkingStateSummary,
  clearActivePatientContext,
  type CallState,
  verify_patient,
} from "../tools.js";

export interface IdentifyPatientTaskResult {
  outcome: "identified" | "registration_allowed";
  patientId: string | null;
  patientName: string | null;
}

export class IdentifyPatientTask extends voice.AgentTask<
  IdentifyPatientTaskResult,
  CallState
> {
  constructor(chatCtx: llm.ChatContext, state: CallState) {
    super({
      chatCtx,
      instructions: buildTaskPrompt({
        mode: "identify",
        stateSummary: buildWorkingStateSummary(state, "identify"),
      }),
      tools: {
        confirm_current_patient: llm.tool({
          description:
            "Use this when the active patient is already resolved from caller context, such as when the caller's first name matches the single pre-loaded patient.",
          execute: async (_, { ctx }) => {
            const current = ctx.userData as CallState;
            current.workflow.registrationAllowed = false;
            current.identity.callerConfirmedPatient = true;
            current.identity.activePatientMatchesLookup =
              !!current.identity.originalLookupPatientId &&
              current.identity.originalLookupPatientId ===
                current.identity.patientId;
            this.complete({
              outcome: "identified",
              patientId: current.identity.patientId,
              patientName: current.identity.patientName,
            });
          },
        }),
        verify_existing_patient: llm.tool({
          description:
            "Verify an existing patient using the information the caller gave you. If verification succeeds, this task will complete automatically.",
          parameters: verify_patient.parameters,
          execute: async (params, { ctx }) => {
            const result = await (verify_patient as any).execute(params, {
              ctx,
            });
            const current = ctx.userData as CallState;
            if (
              current.workflow.verificationStatus === "verified" &&
              current.identity.patientId
            ) {
              this.complete({
                outcome: "identified",
                patientId: current.identity.patientId,
                patientName: current.identity.patientName,
              });
            }
            return result;
          },
        }),
        allow_registration: llm.tool({
          description:
            "Use this when the caller clearly says they are a new patient, or when identity verification has failed and the workflow should move into registration.",
          parameters: z.object({
            reason: z.string().describe("Why registration is now allowed"),
          }),
          execute: async ({ reason }, { ctx }) => {
            const current = ctx.userData as CallState;
            clearActivePatientContext(current);
            current.workflow.registrationAllowed = true;
            current.workflow.verificationStatus = "no_match";
            this.complete({
              outcome: "registration_allowed",
              patientId: null,
              patientName: null,
            });
            return `Registration allowed: ${reason}`;
          },
        }),
      },
    });
  }

  override async onEnter(): Promise<void> {
    this.session.generateReply({
      instructions:
        "Resolve who the patient is. If the current caller context already identifies the patient, confirm that and complete. If the caller is truly new or verification fails enough to move on, allow registration.",
    });
  }
}
