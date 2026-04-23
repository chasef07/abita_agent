import { llm, voice } from "@livekit/agents";
import { z } from "zod";
import { buildTaskPrompt } from "../prompt.js";
import { buildTaskEscapeTools } from "./escapeTools.js";
import { startTaskReply } from "./startTaskReply.js";
import {
  buildWorkingStateSummary,
  get_availability,
  type CallState,
  route_to_spring_hill,
  shouldExposeRouteToSpringHill,
} from "../tools.js";

export interface AvailabilityTaskResult {
  selectedSlot: CallState["scheduling"]["selectedSlot"];
}

export class AvailabilityTask extends voice.AgentTask<
  AvailabilityTaskResult,
  CallState
> {
  constructor(
    chatCtx: llm.ChatContext,
    state: CallState,
    mode: "schedule" | "reschedule" = "schedule",
  ) {
    super({
      chatCtx,
      instructions: buildTaskPrompt({
        mode,
        stateSummary: buildWorkingStateSummary(state, mode),
        officeKey: state.officeKey,
        effectiveOfficeKey: state.effectiveOfficeKey,
      }),
      tools: {
        ...buildTaskEscapeTools((result) => this.complete(result as any)),
        ...(shouldExposeRouteToSpringHill(state)
          ? { route_to_spring_hill }
          : {}),
        search_availability: llm.tool({
          description:
            "Search schedule availability for a specific date once the patient and visit reason are already known.",
          parameters: get_availability.parameters,
          execute: async (params, { ctx }) => {
            return (get_availability as any).execute(params, { ctx });
          },
        }),
        select_current_slot: llm.tool({
          description:
            "Use this when the caller has clearly agreed to one specific slot from the most recent availability results.",
          parameters: z.object({
            startDatetime: z
              .string()
              .describe("Selected slot datetime in YYYY-MM-DDTHH:MM format"),
            columnId: z.number().describe("Selected slot provider columnId"),
            profileId: z.number().describe("Selected slot provider profileId"),
            duration: z.number().describe("Selected slot duration in minutes"),
            appointmentTypeId: z
              .number()
              .describe("Selected slot appointment type ID"),
          }),
          execute: async (params, { ctx }) => {
            const current = ctx.userData as CallState;
            current.scheduling.selectedSlot = {
              startDatetime: params.startDatetime,
              columnId: params.columnId,
              profileId: params.profileId,
              duration: params.duration,
              appointmentTypeId: params.appointmentTypeId,
            };
            this.complete({ selectedSlot: current.scheduling.selectedSlot });
          },
        }),
      },
    });
  }

  override async onEnter(): Promise<void> {
    const prompt =
      "Search one date at a time, explain the result briefly, and move toward one selected slot. When the caller accepts a slot, record that selected slot and complete.";

    startTaskReply(this.session, prompt);
  }
}
