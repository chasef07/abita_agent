// Opt-in inference check; requires LiveKit inference credentials and incurs model
// usage. All patient/task/transfer effects are inert. No room or phone call is made.
import { initializeLogger, isFunctionTool, llm } from "@livekit/agents";
import { createLlmPair } from "../model-config.js";
import { buildPrompt } from "../prompt.js";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { patientModelProjection } from "../identity/patient-identity.js";
import {
  resolveOfficeKnowledge,
  officeKnowledgeReference,
} from "../office-knowledge.js";
import {
  createConfirmedPatientState,
  createTestCallState,
  confirmedActivePatient,
} from "./support/call-state.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { staffTaskCases } from "./support/staff-task-cases.js";
import { captureStaffTaskTransport } from "./support/staff-task-transport.js";
import type { StaffTaskCategory } from "../state/call-state.js";

type Scenario = {
  id: string;
  caller: string;
  category?: StaffTaskCategory;
  question?: RegExp;
  answer?: RegExp;
  transfer?: boolean;
  anonymous?: boolean;
  messageIncludes?: RegExp[];
};
const scenarios: Scenario[] = [
  ...staffTaskCases.map((scenario) => ({
    ...scenario,
    caller: `${scenario.caller} Yes, please submit my request for staff review. I cannot provide any more details.`,
    anonymous: scenario.id === "patient_incomplete",
  })),
  {
    id: "ambiguous_prescription",
    caller: "I need help with my prescription.",
    question: /(?:glasses|contacts?|medication)/i,
  },
  {
    id: "ambiguous_authorization",
    caller: "I need prior authorization.",
    question:
      /medication[\s\S]*(?:visit|procedure|test)|(?:visit|procedure|test)[\s\S]*medication/i,
  },
  {
    id: "ambiguous_stage",
    caller:
      "I need someone to clarify the routine instructions for my surgery care.",
    question: /before[\s\S]*after|pre.op[\s\S]*post.op/i,
  },
  {
    id: "records_requester_question",
    caller: "I need medical records.",
    question:
      /patient[\s\S]*(?:office|attorney)|(?:office|attorney)[\s\S]*patient/i,
    anonymous: true,
  },
  {
    id: "records_email_question",
    caller: "I am the patient. Please email my visit summary.",
    question: /email address/i,
  },
  {
    id: "records_fax_question",
    caller: "I am the patient. Please fax my full records.",
    question: /fax number/i,
  },
  {
    id: "records_medical_office_question",
    caller:
      "I am calling from a medical office requesting records for Alex Example.",
    question: /office|doctor/i,
  },
  {
    id: "records_attorney_question",
    caller:
      "I am an attorney-office caller requesting full records for Alex Example.",
    question: /fax|authorization/i,
  },
  {
    id: "self_pay_answer",
    caller: "How much is a new-patient medical visit without insurance?",
    answer: /250/,
  },
  {
    id: "self_pay_visit_type",
    caller: "How much is a self-pay visit?",
    question: /medical|routine|new|established|type/i,
  },
  {
    id: "billing_only",
    caller: "I need to discuss the balance on my bill.",
    answer: /786[^\d]*446[^\d]*8333/,
  },
  {
    id: "eye_emergency",
    caller:
      "I suddenly lost vision after surgery and see a curtain. Please help.",
    transfer: true,
  },
];
const selected = scenarios.filter(
  (scenario) =>
    process.argv.length <= 2 || process.argv.slice(2).includes(scenario.id),
);
if (!selected.length) throw new Error("No matching scenarios");
if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET)
  throw new Error(
    "Export LIVEKIT_API_KEY and LIVEKIT_API_SECRET for the opt-in model check. No calls or production side effects are enabled.",
  );
initializeLogger({ pretty: false, level: "silent" });
process.env.ACUITY_PRODUCT_HANDOFF_URL =
  "https://staff-task.invalid/v1/handoffs";
process.env.ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET = "synthetic-only";
const models = createLlmPair();
let failures = 0;
for (const model of [models.primary, models.fallback]) {
  model.on("error", () => {});
  try {
    for (const scenario of selected) {
      const state = scenario.anonymous
        ? createTestCallState()
        : createConfirmedPatientState({
            activePatient: confirmedActivePatient({
              patientId: "synthetic-patient",
              name: "Alex Example",
              dob: "02/03/1990",
              phone: "+12025550147",
            }),
          });
      const transport = captureStaffTaskTransport();
      const middleware = new InMemoryOwnedMiddleware();
      const tools = buildToolsForTrunk(
        middleware,
        SPRING_HILL_OFFICE_PHONE,
        transport.fetch,
      );
      const chatCtx = llm.ChatContext.empty();
      chatCtx.addMessage({
        role: "system",
        content: buildPrompt(SPRING_HILL_OFFICE_PHONE),
      });
      chatCtx.addMessage({
        role: "system",
        content: patientModelProjection(state),
      });
      chatCtx.addMessage({ role: "user", content: scenario.caller });
      const knowledge = resolveOfficeKnowledge("spring-hill", scenario.caller);
      if (knowledge.outcome !== "skipped")
        chatCtx.addMessage({
          role: "assistant",
          content: officeKnowledgeReference("spring-hill", knowledge),
        });
      let text = "";
      let transfer = false;
      let blockedTool = false;
      try {
        for (let step = 0; step < 5; step++) {
          const response = await model
            .chat({
              chatCtx,
              toolCtx: tools,
              ...(model === models.fallback
                ? { inferenceClass: "low" as const }
                : {}),
              connOptions: {
                maxRetry: 0,
                timeoutMs: 20_000,
                retryIntervalMs: 0,
              },
            })
            .collect();
          text += response.text;
          if (!response.toolCalls.length) break;
          for (const call of response.toolCalls) {
            // Transfers are observed but NEVER executed. No effectful tool other
            // than the real task with its inert transport can run in this check.
            if (call.name === "transfer_call") {
              transfer = true;
              break;
            }
            if (call.name !== "create_staff_task") {
              blockedTool = true;
              break;
            }
            const task = tools.find(
              (entry) => isFunctionTool(entry) && entry.name === call.name,
            );
            if (!task || !isFunctionTool(task)) throw new Error("Missing tool");
            const output = await task.execute(JSON.parse(call.args), {
              ctx: {
                session: { userData: state },
                disallowInterruptions() {},
              } as never,
              toolCallId: call.callId,
            } as never);
            chatCtx.insert([
              call,
              llm.FunctionCallOutput.create({
                callId: call.callId,
                name: call.name,
                output: String(output),
                isError: false,
              }),
            ]);
          }
          if (transfer || blockedTool) break;
        }
        const passed =
          !blockedTool &&
          (scenario.transfer
            ? transfer && transport.payloads.length === 0
            : scenario.category
              ? !transfer &&
                transport.payloads.length === 1 &&
                transport.payloads[0]?.category === scenario.category
              : !transfer &&
                transport.payloads.length === 0 &&
                (scenario.question
                  ? text.includes("?") && scenario.question.test(text)
                  : scenario.answer!.test(text)));
        if (!passed) failures++;
        console.log(
          JSON.stringify({
            model: model.model,
            scenario: scenario.id,
            passed,
            ...(!passed
              ? {
                  response: text,
                  categories: transport.payloads.map(
                    (payload) => payload.category,
                  ),
                  transfer,
                  blockedTool,
                }
              : {}),
          }),
        );
      } catch {
        failures++;
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
console.log(JSON.stringify({ cases: selected.length * 2, failures }));
if (failures) process.exitCode = 1;
