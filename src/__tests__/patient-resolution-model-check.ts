// Opt-in, paid LLM check. Uses synthetic records and never executes middleware.
// Load Baseten and LiveKit credentials in the environment before running with tsx.
import { llm, initializeLogger } from "@livekit/agents";
import { buildPrompt } from "../prompt.js";
import { createLlmPair } from "../model-config.js";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import { patientModelProjection } from "../identity/patient-identity.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { createTestCallState } from "./support/call-state.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

type Scenario = {
  id: string;
  names: string[];
  user: string;
  firstName: string;
  lastName?: string;
  confirmationYear?: string;
  mayAsk?: boolean;
};

const scenarios: Scenario[] = [
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
    lastName: "Smith",
    mayAsk: true,
  },
  {
    id: "dob_unconfirmed",
    names: [],
    user: "My name is John Smith, born March 12, 1980. I need to reschedule.",
    firstName: "John",
    lastName: "Smith",
    confirmationYear: "1980",
  },
  {
    id: "phone_match_supplied_dob",
    names: ["John"],
    user: "I need to reschedule. My name is John Smith, born March 12, 1980.",
    firstName: "John",
    lastName: "Smith",
    confirmationYear: "1980",
  },
  {
    id: "phone_match_conflicting_dob",
    names: ["John"],
    user: "I need to reschedule. My name is John Smith, born March 12, 1990.",
    firstName: "John",
    lastName: "Smith",
    confirmationYear: "1990",
  },
];

if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  throw new Error(
    "Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET for the opt-in model check.",
  );
}
initializeLogger({ pretty: false, level: "silent" });
const middleware = new InMemoryOwnedMiddleware();
const tools = buildToolsForTrunk(middleware, SPRING_HILL_OFFICE_PHONE);
const parameters = createResolvePatientTool(middleware).parameters;
let failures = 0;

const { primary, fallback } = createLlmPair();
for (const model of [primary, fallback]) {
  model.on("error", () => {});
  try {
    for (const scenario of scenarios) {
      const state = createTestCallState({
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
          durationMs: 1,
        },
      });
      const chatCtx = llm.ChatContext.empty();
      chatCtx.addMessage({
        role: "system",
        content: buildPrompt(SPRING_HILL_OFFICE_PHONE),
      });
      chatCtx.addMessage({
        role: "system",
        content: patientModelProjection(state),
      });
      chatCtx.addMessage({
        role: "assistant",
        content: "Thank you for calling Abita Eye Group. How can I help?",
      });
      chatCtx.addMessage({ role: "user", content: scenario.user });
      try {
        const response = await model
          .chat({
            chatCtx,
            toolCtx: tools,
            ...(model === fallback ? { inferenceClass: "low" as const } : {}),
            connOptions: { maxRetry: 0, timeoutMs: 20_000, retryIntervalMs: 0 },
          })
          .collect();
        const call = response.toolCalls[0];
        const identity = call
          ? parameters.safeParse(JSON.parse(call.args))
          : null;
        const asks =
          response.toolCalls.length === 0 && response.text.includes("?");
        const passed = scenario.confirmationYear
          ? asks && response.text.includes(scenario.confirmationYear)
          : (scenario.mayAsk && asks) ||
            (response.toolCalls.length === 1 &&
              call?.name === "resolve_patient" &&
              identity?.success === true &&
              identity.data.firstName === scenario.firstName &&
              (identity.data.lastName?.trim() || undefined) ===
                scenario.lastName &&
              !identity.data.dob?.trim());
        if (!passed) failures += 1;
        console.log(
          JSON.stringify({
            model: model.model,
            scenario: scenario.id,
            passed,
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

console.log(JSON.stringify({ cases: scenarios.length * 2, failures }));
if (failures > 0) process.exitCode = 1;
