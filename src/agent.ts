// agent.ts — Agent definition
// Instructions loaded from workspace/ files, tools wired below.

import { llm, voice } from "@livekit/agents";
import { buildPrompt } from "./prompt.js";
import {
  buildTurnStateSummary,
  type CallState,
  type PhoneLookupResult,
  update_insurance,
  check_insurance,
  lookup_knowledge,
  route_to_spring_hill,
  transfer_call,
} from "./tools.js";
import { getOfficeConfigByPhone } from "./offices.js";
import { IdentifyPatientTask } from "./tasks/IdentifyPatientTask.js";
import { RegistrationTask } from "./tasks/RegistrationTask.js";
import { runCancelTaskGroup } from "./workflows/CancelTaskGroup.js";
import { runConfirmTaskGroup } from "./workflows/ConfirmTaskGroup.js";
import { runRescheduleTaskGroup } from "./workflows/RescheduleTaskGroup.js";
import { runScheduleTaskGroup } from "./workflows/ScheduleTaskGroup.js";

export function buildToolsForTrunk(trunkPhone?: string) {
  const office = getOfficeConfigByPhone(trunkPhone ?? "");
  return {
    run_identify_patient_task: llm.tool({
      description:
        "Placeholder identify-patient workflow tool. The live agent replaces this with a task-backed version at runtime.",
      execute: async () =>
        "Identify workflow is unavailable until the agent session is active.",
    }),
    run_registration_task: llm.tool({
      description:
        "Placeholder registration workflow tool. The live agent replaces this with a task-backed version at runtime.",
      execute: async () =>
        "Registration workflow is unavailable until the agent session is active.",
    }),
    run_schedule_task_group: llm.tool({
      description:
        "Placeholder schedule workflow tool. The live agent replaces this with a task-group-backed version at runtime.",
      execute: async () =>
        "Scheduling workflow is unavailable until the agent session is active.",
    }),
    run_reschedule_task_group: llm.tool({
      description:
        "Placeholder reschedule workflow tool. The live agent replaces this with a task-group-backed version at runtime.",
      execute: async () =>
        "Rescheduling workflow is unavailable until the agent session is active.",
    }),
    run_confirm_task_group: llm.tool({
      description:
        "Placeholder confirm workflow tool. The live agent replaces this with a task-group-backed version at runtime.",
      execute: async () =>
        "Confirmation workflow is unavailable until the agent session is active.",
    }),
    run_cancel_task_group: llm.tool({
      description:
        "Placeholder cancel workflow tool. The live agent replaces this with a task-group-backed version at runtime.",
      execute: async () =>
        "Cancellation workflow is unavailable until the agent session is active.",
    }),
    update_insurance,
    check_insurance,
    lookup_knowledge,
    ...(office.features.routeToSpringHill ? { route_to_spring_hill } : {}),
    transfer_call,
  };
}

export class Agent extends voice.Agent {
  private greeting: string;

  constructor(phoneLookup?: PhoneLookupResult, trunkPhone?: string) {
    const office = getOfficeConfigByPhone(trunkPhone ?? "");
    super({
      instructions: buildPrompt(phoneLookup, trunkPhone),
      tools: buildToolsForTrunk(trunkPhone),
    });
    this.greeting = office.greeting;
    this.updateTools({
      ...buildToolsForTrunk(trunkPhone),
      run_identify_patient_task: llm.tool({
        description:
          "Use this when the patient must be identified before scheduling, appointment changes, or insurance updates can continue. This task resolves single-match, multiple-match, existing-patient, and true new-patient flows.",
        execute: async () => {
          const state = this.session.userData as CallState;
          state.workflow.activeFlow = "identify";
          const result = await new IdentifyPatientTask(
            this.chatCtx.copy({ excludeInstructions: true }),
            state,
          ).run();

          if (result.outcome === "registration_allowed") {
            state.workflow.activeFlow = "register";
            return "Identity flow completed: registration is allowed. If the caller is truly new, continue with run_registration_task.";
          }

          state.workflow.activeFlow = "none";
          return result.patientName
            ? `Identity flow completed: active patient is ${result.patientName}.`
            : "Identity flow completed: active patient is identified.";
        },
      }),
      run_registration_task: llm.tool({
        description:
          "Use this when the caller is a true new patient and registration must be completed before scheduling can continue. Prefer this when caller context does not already have a matched patient. If a matched patient is already loaded from this phone number but the caller says the visit is for a different new person, prefer run_schedule_task_group or run_identify_patient_task first so the workflow can safely switch patients before registration.",
        execute: async () => {
          const state = this.session.userData as CallState;
          const canStartDirectRegistration =
            !state.workflow.registrationAllowed &&
            !state.identity.patientId &&
            state.identity.lookupMatchStatus === "none";
          if (canStartDirectRegistration) {
            state.workflow.registrationAllowed = true;
            state.workflow.verificationStatus = "no_match";
          }
          state.workflow.activeFlow = "register";
          const result = await new RegistrationTask(
            this.chatCtx.copy({ excludeInstructions: true }),
            state,
          ).run();

          if (!result.registered) {
            state.workflow.activeFlow = "none";
            return state.identity.patientId
              ? "Registration workflow was not needed because the patient is already identified. Continue helping the caller."
              : "Registration workflow is not allowed yet. Identify the patient first or confirm they are truly new before registering them.";
          }

          state.workflow.activeFlow = "none";
          return result.patientName
            ? `Registration completed for ${result.patientName}. Continue helping the caller.`
            : "Registration completed. Continue helping the caller.";
        },
      }),
      run_schedule_task_group: llm.tool({
        description:
          "Use this when the caller wants to schedule an appointment. This workflow handles identification, registration if needed, visit reason, availability, and booking.",
        execute: async () => {
          const state = this.session.userData as CallState;
          const result = await runScheduleTaskGroup(
            this.chatCtx.copy({ excludeInstructions: true }),
            state,
          );

          const booking = result.taskResults["booking"] as
            | { booked?: boolean }
            | undefined;

          if (booking?.booked) {
            return "Scheduling workflow completed. The appointment has been booked.";
          }

          return "Scheduling workflow completed. Continue helping the caller based on what was completed.";
        },
      }),
      run_reschedule_task_group: llm.tool({
        description:
          "Use this when the caller wants to move or change an existing appointment. This workflow identifies the patient, selects the current appointment, books the replacement, and then cancels the old appointment.",
        execute: async () => {
          const state = this.session.userData as CallState;
          const result = await runRescheduleTaskGroup(
            this.chatCtx.copy({ excludeInstructions: true }),
            state,
          );

          const identify = result.taskResults["identify_patient"] as
            | { outcome?: "identified" | "registration_allowed" }
            | undefined;
          if (identify?.outcome === "registration_allowed") {
            return "Reschedule workflow stopped because no existing patient could be resolved. If the caller is truly new, use the scheduling workflow instead.";
          }

          const cancelled = result.taskResults["cancel_original"] as
            | { cancelled?: boolean }
            | undefined;
          if (cancelled?.cancelled) {
            return "Reschedule workflow completed. The replacement appointment is booked and the original appointment has been cancelled.";
          }

          return "Reschedule workflow completed. Continue helping the caller based on what was completed.";
        },
      }),
      run_confirm_task_group: llm.tool({
        description:
          "Use this when the caller wants to confirm an existing appointment. This workflow identifies the patient, resolves which appointment they mean, and then confirms the appointment details.",
        execute: async () => {
          const state = this.session.userData as CallState;
          const result = await runConfirmTaskGroup(
            this.chatCtx.copy({ excludeInstructions: true }),
            state,
          );

          const identify = result.taskResults["identify_patient"] as
            | { outcome?: "identified" | "registration_allowed" }
            | undefined;
          if (identify?.outcome === "registration_allowed") {
            return "Confirmation workflow stopped because no existing patient could be resolved.";
          }

          const appointmentId = state.scheduling.targetAppointmentId;
          const appointment = state.scheduling.appointments.find(
            (appt) => appt.id === appointmentId,
          );
          if (appointment) {
            return `Appointment confirmed: ${appointment.date} at ${appointment.time} with ${appointment.provider} at ${appointment.facility}.`;
          }

          return "Confirmation workflow completed. Continue helping the caller based on what was completed.";
        },
      }),
      run_cancel_task_group: llm.tool({
        description:
          "Use this when the caller wants to cancel an existing appointment. This workflow identifies the patient, resolves which appointment they mean, and then cancels it after confirmation.",
        execute: async () => {
          const state = this.session.userData as CallState;
          const result = await runCancelTaskGroup(
            this.chatCtx.copy({ excludeInstructions: true }),
            state,
          );

          const identify = result.taskResults["identify_patient"] as
            | { outcome?: "identified" | "registration_allowed" }
            | undefined;
          if (identify?.outcome === "registration_allowed") {
            return "Cancellation workflow stopped because no existing patient could be resolved.";
          }

          const cancelled = result.taskResults["cancel_original"] as
            | { cancelled?: boolean }
            | undefined;
          if (cancelled?.cancelled) {
            return "Cancellation workflow completed. The appointment has been cancelled.";
          }

          return "Cancellation workflow completed. Continue helping the caller based on what was completed.";
        },
      }),
    });
  }

  override async onEnter(): Promise<void> {
    // Brief delay so the SIP audio path is fully established before speaking
    await new Promise((r) => setTimeout(r, 500));
    await this.session.say(this.greeting);
  }

  override async onUserTurnCompleted(
    chatCtx: llm.ChatContext,
    _newMessage: llm.ChatMessage,
  ): Promise<void> {
    const summary = buildTurnStateSummary(this.session.userData as CallState);
    if (!summary) return;

    chatCtx.addMessage({
      role: "system",
      content: `<turn_state>\n${summary}\n</turn_state>`,
    });
  }
}
