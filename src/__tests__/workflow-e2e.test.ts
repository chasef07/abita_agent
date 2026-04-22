import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, llm, voice } from "@livekit/agents";
import type { ChatContext } from "@livekit/agents";
import type { ToolChoice, ToolContext } from "@livekit/agents";
import { initializeLogger } from "../../node_modules/@livekit/agents/src/log.js";
import { Agent } from "../agent.js";
import {
  createInitialCallState,
  type CallState,
  type PhoneLookupResult,
} from "../tools.js";

initializeLogger({ pretty: false, level: "error" });

beforeAll(() => {
  process.on("unhandledRejection", () => {});
});

type ScriptedResponse = {
  input: string;
  content?: string;
  toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
};

let mockAppointmentsResult: unknown = [];

class ScriptedLLM extends llm.LLM {
  private readonly responses = new Map<string, ScriptedResponse>();

  constructor(responses: ScriptedResponse[]) {
    super();
    for (const response of responses) {
      this.responses.set(response.input, response);
    }
  }

  label(): string {
    return "scripted-llm";
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContext;
    connOptions?: any;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }) {
    const response = this.responses.get(this.getInputText(chatCtx));
    const outer = this;

    return new (class extends llm.LLMStream {
      constructor() {
        super(outer, {
          chatCtx,
          toolCtx,
          connOptions: connOptions ?? ({} as any),
        });
      }

      protected async run(): Promise<void> {
        if (!response) return;

        if (response.content) {
          this.queue.put({
            id: "scripted",
            delta: { role: "assistant", content: response.content },
          });
        }

        if (response.toolCalls?.length) {
          this.queue.put({
            id: "scripted",
            delta: {
              role: "assistant",
              toolCalls: response.toolCalls.map((call, index) =>
                llm.FunctionCall.create({
                  callId: `scripted_call_${index}`,
                  name: call.name,
                  args: JSON.stringify(call.args ?? {}),
                }),
              ),
            },
          });
        }
      }
    })();
  }

  private getInputText(chatCtx: ChatContext): string {
    const items = chatCtx.items;
    const last = items[items.length - 1]!;
    if (last.type === "message" && last.role === "user") {
      return last.textContent ?? "";
    }
    if (last.type === "function_call_output") {
      return last.output;
    }

    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.type === "message" && item.role === "system") {
        const text = item.textContent ?? "";
        const lines = text.split("\n");
        const tail = lines[lines.length - 1] ?? "";
        if (lines.length > 1 && tail.startsWith("instructions:")) {
          return tail;
        }
      }
    }
    throw new Error("No input text found for scripted LLM");
  }
}

function springHillLookup(
  overrides: Partial<NonNullable<PhoneLookupResult>> = {},
): PhoneLookupResult {
  return {
    status: "verified",
    patientId: "P123",
    name: "Maria Santos",
    dob: "03/05/1982",
    phone: "+18135551234",
    insuranceCarrier: "Florida Blue",
    insPlanId: "IP1",
    respPartyId: "RP1",
    routing: "accepted",
    allowedProviders: [],
    routingAmbiguous: false,
    appointments: [],
    ...(overrides as any),
  };
}

function scheduleAvailabilityResult() {
  return [
    {
      startDatetime: "2026-04-24T10:00",
      columnId: 11,
      profileId: 22,
      duration: 30,
      appointmentTypeId: 1007,
    },
  ];
}

async function createSession(args: {
  responses: ScriptedResponse[];
  phoneLookup?: PhoneLookupResult;
}) {
  const state = createInitialCallState({
    officeKey: "spring-hill",
    officePhone: "+17275919997",
    amdOfficePhone: "+17275919997",
    sipRoomName: "room",
    sipParticipantIdentity: "sip",
    callerPhone: "+18135551234",
    phoneLookup: args.phoneLookup,
  });

  const session = new voice.AgentSession<CallState>({
    llm: new ScriptedLLM(args.responses),
    userData: state,
  });
  const agent = new Agent(args.phoneLookup, "+17275919997");
  await session.start({ agent, record: false });
  return { session, state };
}

describe("workflow e2e", () => {
  beforeEach(() => {
    mockAppointmentsResult = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/patient/appointments")) {
        return new Response(JSON.stringify(mockAppointmentsResult), {
          status: 200,
        });
      }
      if (url.endsWith("/api/scheduler/availability")) {
        return new Response(JSON.stringify(scheduleAvailabilityResult()), {
          status: 200,
        });
      }
      if (url.endsWith("/api/appointment/book")) {
        return new Response(JSON.stringify({ status: "booked" }), {
          status: 200,
        });
      }
      if (url.endsWith("/api/appointment/cancel")) {
        return new Response(JSON.stringify({ status: "cancelled" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as any);
  });

  it("runs the scheduling workflow end to end for an existing patient", async () => {
    const availabilityOutput = JSON.stringify(scheduleAvailabilityResult());
    mockAppointmentsResult = [];
    const { session, state } = await createSession({
      phoneLookup: springHillLookup(),
      responses: [
        {
          input: "I need to schedule an appointment",
          toolCalls: [{ name: "run_schedule_task_group" }],
        },
        {
          input:
            "instructions: Resolve who the patient is. If the current caller context already identifies the patient, confirm that and complete. If the caller is truly new or verification fails enough to move on, allow registration.",
          content: "can I get your first name?",
        },
        {
          input: "Maria",
          toolCalls: [{ name: "confirm_current_patient" }],
        },
        {
          input:
            "instructions: Get the reason for the visit before scheduling. Once you know it clearly enough to continue, record it and move on.",
          content: "what's the reason for the visit?",
        },
        {
          input: "blurry vision",
          toolCalls: [
            {
              name: "record_visit_reason",
              args: { reasonForVisit: "blurry vision" },
            },
          ],
        },
        {
          input:
            "instructions: Search one date at a time, explain the result briefly, and move toward one selected slot. When the caller accepts a slot, record that selected slot and complete.",
          content: "what day works for you?",
        },
        {
          input: "Friday works",
          toolCalls: [
            { name: "search_availability", args: { date: "2026-04-24" } },
          ],
        },
        {
          input: availabilityOutput,
          content: "I have Friday at ten a m. does that work?",
        },
        {
          input: "yes",
          toolCalls: [
            {
              name: "select_current_slot",
              args: {
                startDatetime: "2026-04-24T10:00",
                columnId: 11,
                profileId: 22,
                duration: 30,
                appointmentTypeId: 1007,
              },
            },
          ],
        },
        {
          input:
            "instructions: Confirm the selected slot briefly and book it once the caller agrees. Do not ask them to re-pick the slot unless they change their mind.",
          content: "ok, I'm booking that now.",
        },
        {
          input: "book it",
          toolCalls: [{ name: "confirm_and_book_selected_slot" }],
        },
      ],
    });

    const run1 = await session.run({ userInput: "I need to schedule an appointment" }).wait();
    expect(run1.expect.containsFunctionCall({ name: "run_schedule_task_group" })).toBeTruthy();

    const run2 = await session.run({ userInput: "Maria" }).wait();
    expect(run2.expect.containsFunctionCall({ name: "confirm_current_patient" })).toBeTruthy();

    const run3 = await session.run({ userInput: "blurry vision" }).wait();
    expect(run3.expect.containsFunctionCall({ name: "record_visit_reason" })).toBeTruthy();

    await session.run({ userInput: "Friday works" }).wait();
    await session.run({ userInput: "yes" }).wait();

    const run6 = await session.run({ userInput: "book it" }).wait();
    expect(run6.expect.containsFunctionCall({ name: "confirm_and_book_selected_slot" })).toBeTruthy();

    expect(state.scheduling.bookedSlotsThisCall).toHaveLength(1);
    await session.close();
  });

  it("runs the reschedule workflow and cancels the old appointment only after booking the replacement", async () => {
    const availabilityOutput = JSON.stringify(scheduleAvailabilityResult());
    mockAppointmentsResult = [
      {
        id: 77,
        date: "2026-04-22",
        time: "09:00 AM",
        provider: "Dr. Noel",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: true,
      },
    ];
    const { session, state } = await createSession({
      phoneLookup: springHillLookup({
        appointments: [
          {
            id: 77,
            date: "2026-04-22",
            time: "09:00 AM",
            provider: "Dr. Noel",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
        ],
      }),
      responses: [
        {
          input: "I need to move my appointment",
          toolCalls: [{ name: "run_reschedule_task_group" }],
        },
        {
          input:
            "instructions: Resolve who the patient is. If the current caller context already identifies the patient, confirm that and complete. If the caller is truly new or verification fails enough to move on, allow registration.",
          content: "can I get your first name?",
        },
        {
          input: "Maria",
          toolCalls: [{ name: "confirm_current_patient" }],
        },
        {
          input:
            "instructions: Figure out which existing appointment the caller wants to move or change. If the appointments only came from phone lookup, or the active patient is not yet caller-confirmed, refresh them first. Then select the target appointment once it is clear.",
          content: "which appointment are you trying to move?",
        },
        {
          input: "the one on Wednesday",
          toolCalls: [{ name: "load_existing_appointments" }],
        },
        {
          input: JSON.stringify([
            {
              id: 77,
              date: "2026-04-22",
              time: "09:00 AM",
              provider: "Dr. Noel",
              type: "Follow-up",
              facility: "Spring Hill",
              confirmed: true,
            },
          ]),
          content: "what day works for the replacement appointment?",
        },
        {
          input: "Friday works",
          toolCalls: [{ name: "search_availability", args: { date: "2026-04-24" } }],
        },
        {
          input: availabilityOutput,
          content: "I have Friday at ten a m for the replacement. does that work?",
        },
        {
          input: "yes",
          toolCalls: [
            {
              name: "select_current_slot",
              args: {
                startDatetime: "2026-04-24T10:00",
                columnId: 11,
                profileId: 22,
                duration: 30,
                appointmentTypeId: 1007,
              },
            },
          ],
        },
        {
          input:
            "instructions: Confirm the selected slot briefly and book it once the caller agrees. Do not ask them to re-pick the slot unless they change their mind.",
          content: "ok, I'm booking that now.",
        },
        {
          input: "book it",
          toolCalls: [{ name: "confirm_and_book_selected_slot" }],
        },
        {
          input:
            "instructions: Now that the replacement appointment is booked, cancel the original appointment once the caller confirms that is what they want.",
          content: "ok, the new appointment is set. do you want me to cancel the old one?",
        },
        {
          input: "yes cancel the old one",
          toolCalls: [{ name: "confirm_and_cancel_original_appointment" }],
        },
      ],
    });

    const run1 = await session.run({ userInput: "I need to move my appointment" }).wait();
    expect(run1.expect.containsFunctionCall({ name: "run_reschedule_task_group" })).toBeTruthy();

    const run2 = await session.run({ userInput: "Maria" }).wait();
    expect(run2.expect.containsFunctionCall({ name: "confirm_current_patient" })).toBeTruthy();

    const run3 = await session.run({ userInput: "the one on Wednesday" }).wait();
    expect(run3.expect.containsFunctionCall({ name: "load_existing_appointments" })).toBeTruthy();
    expect(run3.events.some((ev) => ev.type === "function_call" && ev.item.name === "confirm_and_cancel_original_appointment")).toBe(false);

    await session.run({ userInput: "Friday works" }).wait();
    await session.run({ userInput: "yes" }).wait();

    const run6 = await session.run({ userInput: "book it" }).wait();
    expect(run6.events.some((ev) => ev.type === "function_call" && ev.item.name === "confirm_and_cancel_original_appointment")).toBe(false);
    expect(state.scheduling.appointments.some((appt) => appt.id === 77)).toBe(true);

    await session.run({ userInput: "yes cancel the old one" }).wait();
    expect(state.scheduling.appointments.some((appt) => appt.id === 77)).toBe(false);
    await session.close();
  });

  it("enters the confirm workflow for existing appointments", async () => {
    mockAppointmentsResult = [
      {
        id: 55,
        date: "2026-04-22",
        time: "09:00 AM",
        provider: "Dr. Noel",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: true,
      },
    ];
    const { session } = await createSession({
      phoneLookup: springHillLookup({
        appointments: [
          {
            id: 55,
            date: "2026-04-22",
            time: "09:00 AM",
            provider: "Dr. Noel",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
        ],
      }),
      responses: [
        {
          input: "I want to confirm my appointment",
          toolCalls: [{ name: "run_confirm_task_group" }],
        },
        {
          input:
            "instructions: Resolve who the patient is. If the current caller context already identifies the patient, confirm that and complete. If the caller is truly new or verification fails enough to move on, allow registration.",
          content: "can I get your first name?",
        },
        {
          input: "Maria",
          toolCalls: [{ name: "confirm_current_patient" }],
        },
        {
          input:
            "instructions: Figure out which existing appointment the caller wants to move or change. If the appointments only came from phone lookup, or the active patient is not yet caller-confirmed, refresh them first. Then select the target appointment once it is clear.",
          toolCalls: [{ name: "load_existing_appointments" }],
        },
      ],
    });

    const run1 = await session.run({ userInput: "I want to confirm my appointment" }).wait();
    expect(run1.expect.containsFunctionCall({ name: "run_confirm_task_group" })).toBeTruthy();

    const run2 = await session.run({ userInput: "Maria" }).wait();
    expect(run2.expect.containsFunctionCall({ name: "confirm_current_patient" })).toBeTruthy();

    await session.run({ userInput: "confirm it" }).wait();
    await session.close();
  });

  it("enters the cancel workflow for existing appointments", async () => {
    mockAppointmentsResult = [
      {
        id: 88,
        date: "2026-04-22",
        time: "09:00 AM",
        provider: "Dr. Noel",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: true,
      },
    ];
    const { session } = await createSession({
      phoneLookup: springHillLookup({
        appointments: [
          {
            id: 88,
            date: "2026-04-22",
            time: "09:00 AM",
            provider: "Dr. Noel",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
        ],
      }),
      responses: [
        {
          input: "I need to cancel my appointment",
          toolCalls: [{ name: "run_cancel_task_group" }],
        },
        {
          input:
            "instructions: Resolve who the patient is. If the current caller context already identifies the patient, confirm that and complete. If the caller is truly new or verification fails enough to move on, allow registration.",
          content: "can I get your first name?",
        },
        {
          input: "Maria",
          toolCalls: [{ name: "confirm_current_patient" }],
        },
        {
          input:
            "instructions: Figure out which existing appointment the caller wants to move or change. If the appointments only came from phone lookup, or the active patient is not yet caller-confirmed, refresh them first. Then select the target appointment once it is clear.",
          toolCalls: [{ name: "load_existing_appointments" }],
        },
        {
          input: JSON.stringify([
            {
              id: 88,
              date: "2026-04-22",
              time: "09:00 AM",
              provider: "Dr. Noel",
              type: "Follow-up",
              facility: "Spring Hill",
              confirmed: true,
            },
          ]),
          content: "do you want me to cancel that appointment?",
        },
        {
          input: "yes cancel it",
          toolCalls: [{ name: "confirm_and_cancel_original_appointment" }],
        },
      ],
    });

    const run1 = await session.run({ userInput: "I need to cancel my appointment" }).wait();
    expect(run1.expect.containsFunctionCall({ name: "run_cancel_task_group" })).toBeTruthy();

    const run2 = await session.run({ userInput: "Maria" }).wait();
    expect(run2.expect.containsFunctionCall({ name: "confirm_current_patient" })).toBeTruthy();

    await session.run({ userInput: "cancel it" }).wait();
    await session.run({ userInput: "yes cancel it" }).wait();
    await session.close();
  });
});
