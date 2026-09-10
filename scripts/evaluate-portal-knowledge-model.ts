// Real model + real AgentSession against an explicitly configured test backend.
// No audio: this proves tool use and answer text, not spoken-answer latency/quality.
import {
  AgentSession,
  type ChatContext,
  inference,
  initializeLogger,
} from "@livekit/agents";
import { createVoiceAgent } from "../src/agent.js";
import { primaryLLMOptions } from "../src/model-config.js";
import { getOfficeProfiles } from "../src/customers/abita/profile.js";
import { getProductTenantConfig } from "../src/runtime/portal-auth.js";
import { createTestCallState } from "../src/__tests__/support/call-state.js";
import { InMemoryOwnedMiddleware } from "../src/__tests__/support/owned-middleware.js";

initializeLogger({ pretty: false, level: "silent" });
const requestedOffice = process.env.KNOWLEDGE_EVAL_OFFICE ?? "spring-hill";
const offices = getOfficeProfiles().filter(
  (office) => requestedOffice === "all" || office.key === requestedOffice,
);
if (
  !offices.length ||
  !process.env.ACUITY_PRODUCT_KNOWLEDGE_URL ||
  offices.some((office) => !getProductTenantConfig(office.key).secret)
) {
  throw new Error(
    "Explicit test endpoint, valid KNOWLEDGE_EVAL_OFFICE, and each selected tenant credential required",
  );
}
class CapturingModel extends inference.LLM {
  readonly requests: ChatContext[] = [];
  override chat(options: Parameters<inference.LLM["chat"]>[0]) {
    this.requests.push(options.chatCtx.copy());
    return super.chat(options);
  }
}
const cases = [
  ["address-contact", "What is your office address and phone number?"],
  ["office-hours", "What are your office hours?"],
  ["pediatric", "My six-year-old needs a routine eye exam for glasses."],
  [
    "routine-disclosure",
    "I would like to schedule a routine eye exam to update my glasses.",
    "I am new. Before we schedule, is there anything else I need to know?",
  ],
  ["indirect", "When does everyone head home for the day?"],
  ["half-past-five", "Will someone still be there at half past five?"],
  ["spanish", "¿A qué hora cierra la oficina?"],
  ["followup", "What are your office hours?", "And Saturdays?"],
  ["missing", "Do you have valet parking?"],
  ["not-offered", "Can I get retina surgery at the office?"],
  [
    "price-exception",
    "Does the routine vision exam price include retinal photographs?",
  ],
] as const;
if (
  process.env.KNOWLEDGE_EVAL_CASE &&
  !cases.some(([id]) => id === process.env.KNOWLEDGE_EVAL_CASE)
)
  throw new Error("Unknown KNOWLEDGE_EVAL_CASE");
for (const office of offices) {
  for (const [id, ...questions] of cases) {
    if (
      process.env.KNOWLEDGE_EVAL_CASE &&
      process.env.KNOWLEDGE_EVAL_CASE !== id
    )
      continue;
    const llm = new CapturingModel(primaryLLMOptions);
    const session = new AgentSession({ llm });
    const state = createTestCallState({
      officeKey: office.key,
      trunkPhone: office.trunkPhones[0],
      amdOfficePhone: office.amdOfficePhone,
    });
    session.userData = state;
    const deadline = setTimeout(() => {
      void session.close();
    }, 45000);
    try {
      await session.start({
        agent: createVoiceAgent(office.trunkPhones[0]!, {
          ownedMiddleware: new InMemoryOwnedMiddleware(),
          suppressGreeting: true,
        }).agent,
      });
      const begin = performance.now();
      for (const userInput of questions)
        await session.run({ userInput }).wait();
      const items = session.currentAgent.chatCtx.items;
      console.log(
        JSON.stringify({
          id,
          officeKey: office.key,
          model: primaryLLMOptions.model,
          elapsedMs: Math.round(performance.now() - begin),
          tools: items.flatMap((item) =>
            item.type === "function_call"
              ? [{ name: item.name, args: JSON.parse(item.args) }]
              : [],
          ),
          answers: items.flatMap((item) =>
            item.type === "message" && item.role === "assistant"
              ? [item.textContent]
              : [],
          ),
          retrievals: state.runtime.knowledgeRetrievals,
          requestsConsumingPassages: llm.requests.filter((request) =>
            request.items.some(
              (item) =>
                item.type === "function_call_output" &&
                item.name === "search_office_knowledge" &&
                item.output.includes("sectionId"),
            ),
          ).length,
        }),
      );
    } catch {
      console.log(
        JSON.stringify({
          id,
          officeKey: office.key,
          outcome: "evaluation_failed",
        }),
      );
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      await session.close();
      await llm.aclose();
    }
  }
}
