import { ToolContext } from "@livekit/agents";
import { objectSchema } from "./support/tool-schema.js";
// Opt-in, paid LLM check. Uses synthetic records and never executes middleware.
// Load LiveKit credentials in the environment before running with tsx.
// Pass scenario IDs as arguments to run a focused subset.
import { llm, initializeLogger } from "@livekit/agents";
import { buildPrompt } from "../prompt.js";
import { preCallLookupHint } from "../runtime/precall-bootstrap.js";
import { createLlmPair } from "../model-config.js";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import {
  HOLLYWOOD_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  getOfficeProfileByPhone,
} from "../customers/abita/profile.js";
import { createTestCallState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

type Scenario = {
  id: string;
  names: string[];
  user: string;
  firstName?: string;
  askFirstName?: boolean;
  officePhone?: string;
  promoted?: boolean;
  activeSameName?: boolean;
  confirmedDob?: boolean;
  dob?: string;
  askDob?: boolean;
};

const scenarios: Scenario[] = [
  {
    id: "same_name_patient_switch",
    names: ["John"],
    user: "Now I need an appointment for my son. His first name is also John, but he's a different patient.",
    activeSameName: true,
    askDob: true,
  },
  {
    id: "promoted_booking",
    names: ["John"],
    user: "John. It's for me.",
    firstName: "John",
    promoted: true,
  },
  {
    id: "promoted_parent_booking",
    names: ["John"],
    user: "It's for my son John.",
    firstName: "John",
    promoted: true,
  },
  {
    id: "dob_already_confirmed",
    names: [],
    user: "Yes, that's correct.",
    firstName: "John",
    confirmedDob: true,
  },
  {
    id: "phone_matches_first_name_supplied",
    names: ["Jane", "John", "Maria", "Alex", "Sam"],
    user: "I'm an existing patient. I'd like to book a routine eye exam for glasses at Hollywood. My first name is John.",
    firstName: "John",
    officePhone: HOLLYWOOD_OFFICE_PHONE,
  },
  {
    id: "phone_matches_name_not_supplied",
    names: ["Jane", "John", "Maria", "Alex", "Sam"],
    user: "I'm an existing patient. I'd like to book a routine eye exam for glasses at Hollywood. What times are available?",
    askFirstName: true,
    officePhone: HOLLYWOOD_OFFICE_PHONE,
  },
  {
    id: "first_name_only",
    names: ["John"],
    user: "I need to reschedule my appointment. My first name is John.",
    firstName: "John",
  },
  {
    id: "parent_for_child",
    names: ["Jane", "John"],
    user: "I'm Jane, calling to reschedule my son John's appointment.",
    firstName: "John",
  },
  {
    id: "negated_name",
    names: ["Jane", "John"],
    user: "I am not Jane. This appointment is for John.",
    firstName: "John",
  },
  {
    id: "spanish_first_name",
    names: ["Juan"],
    user: "Necesito cambiar mi cita. Me llamo Juan.",
    firstName: "Juan",
  },
  {
    id: "no_phone_match",
    names: [],
    user: "I am an existing patient. My name is John Smith and I need to reschedule.",
    firstName: "John",
  },
  {
    id: "dob_supplied_without_confirmation",
    names: [],
    user: "My name is John Smith, born March 12, 1980. I need to reschedule.",
    firstName: "John",
    dob: "03/12/1980",
  },
  {
    id: "phone_match_supplied_dob",
    names: ["John"],
    user: "I need to reschedule. My name is John Smith, born March 12, 1980.",
    firstName: "John",
    dob: "03/12/1980",
  },
  {
    id: "phone_match_conflicting_dob",
    names: ["John"],
    user: "I need to reschedule. My name is John Smith, born March 12, 1990.",
    firstName: "John",
    dob: "03/12/1990",
  },
];

if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  throw new Error(
    "Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET for the opt-in model check.",
  );
}
initializeLogger({ pretty: false, level: "silent" });
const middleware = new InMemoryOwnedMiddleware();
const parameters = createResolvePatientTool(middleware).parameters;
const selectedScenarios = scenarios.filter(
  (scenario) =>
    process.argv.length <= 2 || process.argv.slice(2).includes(scenario.id),
);
if (selectedScenarios.length === 0) throw new Error("No matching scenarios.");
let failures = 0;

const { primary, fallback } = createLlmPair();
for (const model of [primary, fallback]) {
  model.on("error", () => {});
  try {
    for (const scenario of selectedScenarios) {
      const officePhone = scenario.officePhone ?? SPRING_HILL_OFFICE_PHONE;
      const tools = buildToolsForTrunk(middleware, officePhone);
      const state = createTestCallState({
        officeKey: getOfficeProfileByPhone(officePhone).key,
        trunkPhone: officePhone,
        preCallCandidates: scenario.names.map((firstName) => ({
          status: "verified",
          ref: firstName,
          patientId: firstName,
          firstName,
          lastName: "Smith",
          dob: "03/12/1980",
          appointments: [],
          appointmentsStatus: "none",
        })),
        preCallLookup: {
          status:
            scenario.names.length > 1
              ? "multiple_matches"
              : scenario.names.length === 1
                ? "verified"
                : "no_match",
        },
      });
      const chatCtx = llm.ChatContext.empty();
      chatCtx.addMessage({
        role: "system",
        content: buildPrompt(officePhone),
      });
      chatCtx.addMessage({
        role: "assistant",
        content: "Thank you for calling Abita Eye Group. How can I help?",
      });
      if (scenario.activeSameName) {
        const args = { firstName: "John", lastName: null, dob: null };
        chatCtx.addMessage({
          role: "user",
          content: "This is John. I need an appointment.",
        });
        const reply = await createResolvePatientTool(middleware).execute(args, {
          ctx: createToolContext(state),
          toolCallId: "prior-patient",
        } as never);
        chatCtx.insert([
          llm.FunctionCall.create({
            callId: "prior-patient",
            name: "resolve_patient",
            args: JSON.stringify(args),
          }),
          llm.FunctionCallOutput.create({
            callId: "prior-patient",
            name: "resolve_patient",
            output: reply,
            isError: false,
          }),
        ]);
        chatCtx.addMessage({
          role: "assistant",
          content: "I found your patient record, John Smith.",
        });
      }
      if (scenario.promoted) {
        chatCtx.addMessage({
          role: "user",
          content: "I'd like an appointment for a scratch in my left eye.",
        });
        chatCtx.addMessage({
          role: "assistant",
          content: "What's the patient's first name?",
        });
      }
      if (scenario.confirmedDob) {
        chatCtx.addMessage({
          role: "user",
          content: "I'm John, born March 12, 1980. I need to reschedule.",
        });
        chatCtx.addMessage({
          role: "assistant",
          content: "That's March 12, 1980?",
        });
      }
      chatCtx.addMessage({ role: "user", content: scenario.user });
      if (scenario.promoted) {
        const args = {
          firstName: scenario.firstName!,
          lastName: null,
          dob: null,
        };
        const reply = await createResolvePatientTool(middleware).execute(args, {
          ctx: createToolContext(state),
          toolCallId: "synthetic-promotion",
        } as never);
        chatCtx.insert([
          llm.FunctionCall.create({
            callId: "synthetic-promotion",
            name: "resolve_patient",
            args: JSON.stringify(args),
          }),
          llm.FunctionCallOutput.create({
            callId: "synthetic-promotion",
            name: "resolve_patient",
            output: reply,
            isError: false,
          }),
        ]);
      }
      const hint = preCallLookupHint(state);
      if (hint) chatCtx.addMessage({ role: "system", content: hint });
      try {
        const response = await model
          .chat({
            chatCtx,
            toolCtx: new ToolContext(tools),
            ...(model === fallback ? { inferenceClass: "low" as const } : {}),
            connOptions: { maxRetry: 0, timeoutMs: 20_000, retryIntervalMs: 0 },
          })
          .collect();
        const call = response.toolCalls[0];
        const identity = call
          ? objectSchema<
              Parameters<
                ReturnType<typeof createResolvePatientTool>["execute"]
              >[0]
            >(parameters).safeParse(JSON.parse(call.args))
          : null;
        const asks =
          response.toolCalls.length === 0 && response.text.includes("?");
        const passed = scenario.promoted
          ? /found/i.test(response.text) &&
            /John/i.test(response.text) &&
            !/last name|full name|surname|date of birth|born|\bDOB\b/i.test(
              response.text,
            ) &&
            response.toolCalls.every((call) => call.name !== "resolve_patient")
          : scenario.askFirstName
            ? asks &&
              /first name/i.test(response.text) &&
              !/last name|full name|surname|date of birth|\bDOB\b/i.test(
                response.text,
              )
            : scenario.askDob
              ? asks &&
                /date of birth|\bDOB\b|born/i.test(response.text) &&
                !/last name|surname/i.test(response.text)
              : response.toolCalls.length === 1 &&
                call?.name === "resolve_patient" &&
                identity?.success === true &&
                identity.data.firstName === scenario.firstName &&
                !response.text.includes("?") &&
                (scenario.confirmedDob
                  ? identity.data.dob === "03/12/1980"
                  : scenario.dob
                    ? identity.data.dob === scenario.dob
                    : !identity.data.dob?.trim());
        if (!passed) failures += 1;
        console.log(
          JSON.stringify({
            model: model.model,
            scenario: scenario.id,
            passed,
            ...(!passed || scenario.askFirstName
              ? {
                  response: response.text,
                  tools: response.toolCalls.map((tool) => ({
                    name: tool.name,
                    args: tool.args,
                  })),
                }
              : {}),
          }),
        );
      } catch {
        failures += 1;
        console.log(
          JSON.stringify({
            model: model.model,
            scenario: scenario.id,
            passed: false,
            reason: "request_or_response_failed",
          }),
        );
      }
    }
  } finally {
    await model.aclose();
  }
}

console.log(JSON.stringify({ cases: selectedScenarios.length * 2, failures }));
if (failures > 0) process.exitCode = 1;
