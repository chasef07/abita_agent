import { llm, voice } from "@livekit/agents";
import { buildTaskPrompt } from "../prompt.js";
import {
  add_patient,
  buildWorkingStateSummary,
  check_insurance,
  type CallState,
  route_to_spring_hill,
  shouldExposeRouteToSpringHill,
} from "../tools.js";

export interface RegistrationTaskResult {
  registered: boolean;
  patientId: string | null;
  patientName: string | null;
}

export class RegistrationTask extends voice.AgentTask<
  RegistrationTaskResult,
  CallState
> {
  constructor(chatCtx: llm.ChatContext, state: CallState) {
    super({
      chatCtx,
      instructions: buildTaskPrompt({
        mode: "register",
        stateSummary: buildWorkingStateSummary(state, "register"),
        officeKey: state.officeKey,
        effectiveOfficeKey: state.effectiveOfficeKey,
      }),
      tools: {
        ...(shouldExposeRouteToSpringHill(state)
          ? { route_to_spring_hill }
          : {}),
        check_insurance,
        submit_registration: llm.tool({
          description:
            "Submit the new-patient registration after all required fields are collected and confirmed. This task completes automatically on success.",
          parameters: add_patient.parameters,
          execute: async (params, { ctx }) => {
            const result = await (add_patient as any).execute(params, { ctx });
            const current = ctx.userData as CallState;
            if (
              current.workflow.registrationComplete &&
              current.identity.patientId
            ) {
              this.complete({
                registered: true,
                patientId: current.identity.patientId,
                patientName: current.identity.patientName,
              });
            }
            return result;
          },
        }),
      },
    });
  }

  override async onEnter(): Promise<void> {
    const current = this.session.userData as CallState;
    if (!current.workflow.registrationAllowed) {
      this.complete({
        registered: false,
        patientId: current.identity.patientId,
        patientName: current.identity.patientName,
      });
      return;
    }

    this.session.generateReply({
      instructions:
        "Complete new-patient registration. Collect the missing fields, confirm the critical details, then submit registration once everything required is ready.",
    });
  }
}
