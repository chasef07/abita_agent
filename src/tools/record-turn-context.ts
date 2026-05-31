import { llm } from "@livekit/agents";
import { z } from "zod";
import {
  applyTurnContextToState,
  workflowContextGuideFor,
  workflowContextNameForTurn,
} from "../state/call-state.js";
import { getState } from "./session.js";

export const record_turn_context = llm.tool({
  description:
    "Select the workflow context for the caller's current request when the intent is clear. " +
    "Call this only when you are confident about what the caller is trying to do. " +
    "For scheduling, call this only after you can classify the appointment lane as medical ophthalmology or routine vision/optical. " +
    "Do not call this for greetings, filler, unclear requests, ambiguous scheduling requests, or partial information. " +
    "If the intent or scheduling lane is unclear, ask concise clarifying questions instead. " +
    "This tool records the selected context and returns workflow guidance. It does not speak, verify, schedule, cancel, transfer, or call external systems.",
  parameters: z
    .object({
      intent: z
        .enum(["schedule", "change_appointment", "question", "transfer"])
        .describe(
          "The clear workflow intent for the caller's current request. Do not call this tool until the intent is clear.",
        ),
      appointmentLane: z
        .enum(["medical_md", "routine_od", "not_applicable"])
        .describe(
          "Required lane for scheduling. Use medical_md for ophthalmology or medical eye-care requests. Use routine_od for routine vision, glasses, contacts, or optometry. Use not_applicable when the intent is not schedule. If a scheduling lane is unclear, do not call this tool yet; ask clarifying questions.",
        ),
      isEmergency: z
        .boolean()
        .describe(
          "True only for possible urgent/emergency eye symptoms like torn retina, sudden vision loss, severe eye pain, trauma, chemical exposure, or post-surgical emergency.",
        ),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe(
          "Model confidence from 0.0 to 1.0 in this workflow selection. Do not call this tool when confidence is low.",
        ),
    })
    .superRefine((args, ctx) => {
      if (
        args.intent === "schedule" &&
        args.appointmentLane === "not_applicable"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appointmentLane"],
          message:
            "Scheduling requires medical_md or routine_od. Ask clarifying questions if the lane is unclear.",
        });
      }
      if (
        args.intent !== "schedule" &&
        args.appointmentLane !== "not_applicable"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appointmentLane"],
          message:
            "Use not_applicable for appointmentLane when the intent is not schedule.",
        });
      }
    }),
  execute: async (args, { ctx }) => {
    const state = getState(ctx);
    applyTurnContextToState(state, args);
    const workflowContext = workflowContextNameForTurn(args);
    return {
      recorded: true,
      workflowContext: workflowContextGuideFor(workflowContext),
    };
  },
});
