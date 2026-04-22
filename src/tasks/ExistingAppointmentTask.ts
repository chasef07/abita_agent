import { llm, voice } from "@livekit/agents";
import { z } from "zod";
import { buildTaskPrompt } from "../prompt.js";
import {
  buildWorkingStateSummary,
  confirm_appt,
  type CallState,
} from "../tools.js";

export interface ExistingAppointmentTaskResult {
  appointmentId: number | null;
}

export class ExistingAppointmentTask extends voice.AgentTask<
  ExistingAppointmentTaskResult,
  CallState
> {
  private readonly mode: "confirm" | "cancel" | "reschedule";

  constructor(
    chatCtx: llm.ChatContext,
    state: CallState,
    mode: "confirm" | "cancel" | "reschedule" = "reschedule",
  ) {
    super({
      chatCtx,
      instructions: buildTaskPrompt({
        mode,
        stateSummary: buildWorkingStateSummary(state, mode),
      }),
      tools: {
        load_existing_appointments: llm.tool({
          description:
            "Load the patient's current appointments if they are not already available in session state.",
          execute: async (_, { ctx }) => {
            const current = ctx.userData as CallState;
            if (
              current.scheduling.appointments.length === 0 ||
              current.scheduling.appointmentsSource === "phone_lookup" ||
              current.identity.switchedPatientThisCall ||
              !current.identity.callerConfirmedPatient
            ) {
              const result = await (confirm_appt as any).execute({}, { ctx });
              if (current.scheduling.appointments.length === 1) {
                const onlyAppointment = current.scheduling.appointments[0]!;
                current.scheduling.targetAppointmentId = onlyAppointment.id;
                this.complete({ appointmentId: onlyAppointment.id });
              }
              return result;
            }
            return "Appointments already loaded in session state.";
          },
        }),
        select_existing_appointment: llm.tool({
          description:
            "Select the existing appointment the caller wants to move or change once it is clear which one they mean.",
          parameters: z.object({
            appointmentId: z
              .number()
              .describe("The appointment ID the caller is referring to"),
          }),
          execute: async ({ appointmentId }, { ctx }) => {
            const current = ctx.userData as CallState;
            const exists = current.scheduling.appointments.some(
              (appt) => appt.id === appointmentId,
            );
            if (!exists) {
              return "ERROR: That appointment is not loaded. Confirm appointments first and then select one.";
            }
            current.scheduling.targetAppointmentId = appointmentId;
            this.complete({ appointmentId });
          },
        }),
      },
    });
    this.mode = mode;
  }

  override async onEnter(): Promise<void> {
    const current = this.session.userData as CallState;
    if (
      current.scheduling.appointments.length === 1 &&
      current.scheduling.appointmentsSource !== "phone_lookup" &&
      current.identity.callerConfirmedPatient
    ) {
      const onlyAppointment = current.scheduling.appointments[0]!;
      current.scheduling.targetAppointmentId = onlyAppointment.id;
      this.complete({ appointmentId: onlyAppointment.id });
      return;
    }

    this.session.generateReply({
      instructions:
        "Figure out which existing appointment the caller wants to move or change. If the appointments only came from phone lookup, or the active patient is not yet caller-confirmed, refresh them first. Then select the target appointment once it is clear.",
    });
  }
}
