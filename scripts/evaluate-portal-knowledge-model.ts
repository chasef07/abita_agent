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
import { SPRING_HILL_OFFICE_PHONE } from "../src/customers/abita/profile.js";
import { createTestCallState } from "../src/__tests__/support/call-state.js";
import { InMemoryOwnedMiddleware } from "../src/__tests__/support/owned-middleware.js";

initializeLogger({ pretty: false, level: "silent" });
if (
  process.env.ACUITY_PRODUCT_KNOWLEDGE_PILOT !== "spring-hill" ||
  !process.env.ACUITY_PRODUCT_KNOWLEDGE_URL ||
  !process.env.ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET
)
  throw new Error("Explicit pilot test endpoint and credential required");
class CapturingModel extends inference.LLM {
  readonly requests: ChatContext[] = [];
  override chat(options: Parameters<inference.LLM["chat"]>[0]) {
    this.requests.push(options.chatCtx.copy());
    return super.chat(options);
  }
}
const cases = [
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
for (const [id, ...questions] of cases) {
  if (process.env.KNOWLEDGE_EVAL_CASE && process.env.KNOWLEDGE_EVAL_CASE !== id)
    continue;
  const llm = new CapturingModel(primaryLLMOptions);
  const session = new AgentSession({ llm });
  const state = createTestCallState();
  session.userData = state;
  const deadline = setTimeout(() => {
    void session.close();
  }, 45000);
  try {
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: new InMemoryOwnedMiddleware(),
        suppressGreeting: true,
      }).agent,
    });
    const begin = performance.now();
    for (const userInput of questions) await session.run({ userInput }).wait();
    const items = session.currentAgent.chatCtx.items;
    console.log(
      JSON.stringify({
        id,
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
    console.log(JSON.stringify({ id, outcome: "evaluation_failed" }));
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await session.close();
    await llm.aclose();
  }
}
