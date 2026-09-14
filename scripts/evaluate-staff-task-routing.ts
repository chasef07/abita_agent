import assert from "node:assert/strict";
import {
  AgentSession,
  inference,
  initializeLogger,
  isFunctionTool,
} from "@livekit/agents";
import { createVoiceAgent } from "../src/agent.js";
import { primaryLLMOptions } from "../src/model-config.js";
import { voiceMaxToolSteps } from "../src/session-options.js";
import { createConfirmedPatientState } from "../src/__tests__/support/call-state.js";
import { InMemoryOwnedMiddleware } from "../src/__tests__/support/owned-middleware.js";
import type { CallState, StaffTaskCategory } from "../src/state/call-state.js";

// Opt-in model evaluation: real agent/tools, synthetic identity, inert delivery.
// No EMR, knowledge service, portal ingestion, or live transfer is exercised.
const scenarios: {
  name: string;
  turns: string[];
  categories: StaffTaskCategory[];
  clarification?: RegExp;
}[] = [
  {
    name: "expedited glasses prescription",
    turns: [
      "Please ask Optical to expedite a copy of my glasses prescription for pickup. I approve sending the request.",
    ],
    categories: ["optical"],
  },
  {
    name: "medication authorization",
    turns: [
      "My pharmacy, Example Pharmacy, is waiting for the insurance prior authorization for my latanoprost refill. Please send staff a request to check its status; I approve.",
    ],
    categories: ["medication"],
  },
  {
    name: "service authorization",
    turns: [
      "Please ask staff to check my insurance authorization status for the eye test next Tuesday. This is not a medication request. I approve sending it.",
    ],
    categories: ["insurance"],
  },
  {
    name: "ambiguous authorization",
    turns: [
      "Please send staff a request to check my prior auth status. I approve.",
      "I don't know what the authorization is for. Please send the request with that detail marked unknown.",
    ],
    categories: ["other"],
    clarification:
      /medication|medicine|procedure|service|test|what.*(?:auth|for)/i,
  },
  {
    name: "pre-op callback",
    turns: [
      "My surgery is next week. Please send the pre-op team a non-urgent callback request to review my preparation paperwork. I have no symptoms and am not asking you for medical advice. I approve.",
    ],
    categories: ["pre_op"],
  },
  {
    name: "post-op callback",
    turns: [
      "My surgery was last week. Please send the post-op team a non-urgent callback request to review my aftercare paperwork. I have no symptoms and am not asking you for medical advice. I approve.",
    ],
    categories: ["post_op"],
  },
  {
    name: "distinct authorization needs",
    turns: [
      "Please send two requests: Example Pharmacy needs the authorization status for my latanoprost refill, and I need the authorization status for my eye test next Tuesday. Both are unresolved. I approve both staff requests.",
    ],
    categories: ["medication", "insurance"],
  },
  {
    name: "two needs in the same group",
    turns: [
      "Please send two separate Optical requests: expedite a copy of my glasses prescription for pickup, and check the repair status of my broken frames. I approve both requests.",
    ],
    categories: ["optical", "optical"],
  },
];

initializeLogger({ pretty: false, level: "error" });
process.env.NODE_ENV = "development";
delete process.env.LIVEKIT_AGENT_DEPLOYMENT;
process.env.ACUITY_PRODUCT_HANDOFF_URL =
  "https://staff-task-eval.invalid/v1/handoffs";
process.env.ACUITY_PRODUCT_KNOWLEDGE_URL =
  "https://staff-task-eval.invalid/v1/knowledge";
process.env.ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET = "synthetic-eval-secret";

const networkFetch = globalThis.fetch;
let failed = 0;
for (const scenario of scenarios) {
  const payloads: {
    category: StaffTaskCategory;
    callId: string;
    idempotencyKey: string;
    patient?: { id?: string };
  }[] = [];
  const transfers: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "staff-task-eval.invalid") {
      if (url.pathname === "/v1/tasks") {
        payloads.push(JSON.parse(String(init?.body)));
        return Response.json({
          status: "created",
          taskId: `synthetic-${payloads.length}`,
        });
      }
      return Response.json({
        outcome: "no_relevant_information",
        passages: [],
      });
    }
    if (url.hostname.endsWith(".livekit.cloud"))
      return networkFetch(input, init);
    throw new Error(`Evaluation blocked external request to ${url.hostname}`);
  };
  const state = createConfirmedPatientState({
    trunkPhone: "+18135484830",
    callId: `routing-eval-${scenario.name}`,
    callerPhone: "+12025550147",
  });
  const session = new AgentSession<CallState>({
    llm: new inference.LLM(primaryLLMOptions),
    userData: state,
    maxToolSteps: voiceMaxToolSteps,
    turnHandling: { turnDetection: "manual" },
  });
  const { agent } = createVoiceAgent(state.runtime.trunkPhone, {
    ownedMiddleware: new InMemoryOwnedMiddleware(),
    suppressGreeting: true,
  });
  // Keep transfer available to the model while intercepting its side effect.
  for (const entry of agent.toolCtx.tools) {
    if (isFunctionTool(entry) && entry.name === "transfer_call") {
      entry.execute = async () => {
        transfers.push("transfer_call");
        return "Synthetic transfer intercepted; no live transfer occurred.";
      };
    }
  }
  const timer = setTimeout(
    () => session.shutdown({ drain: false, reason: "eval_timeout" }),
    90_000,
  );
  try {
    await session.start({ agent });
    for (const [index, turn] of scenario.turns.entries()) {
      await session
        .run({ userInput: index === 0 ? `I'm Jane Doe. ${turn}` : turn })
        .wait();
      if (index === 0 && scenario.clarification) {
        assert.equal(
          payloads.length,
          0,
          "Must clarify the authorization subject before submission",
        );
        const replies = session.history.items
          .filter(
            (item) => item.type === "message" && item.role === "assistant",
          )
          .map((item) => (item.type === "message" ? item.textContent : ""))
          .join("\n");
        assert.match(replies, scenario.clarification);
      }
    }
    assert.deepEqual(
      payloads.map((payload) => payload.category).sort(),
      [...scenario.categories].sort(),
    );
    assert.equal(
      new Set(payloads.map((payload) => payload.idempotencyKey)).size,
      payloads.length,
    );
    for (const payload of payloads) {
      assert.equal(payload.callId, state.runtime.callId);
      assert.equal(payload.patient?.id, "patient-1");
    }
    assert.deepEqual(transfers, []);
    console.log(
      JSON.stringify({ scenario: scenario.name, status: "passed", payloads }),
    );
  } catch (error) {
    failed++;
    console.error(
      JSON.stringify({
        scenario: scenario.name,
        status: "failed",
        error: String(error),
        payloads,
        history: session.history.toJSON(),
      }),
    );
  } finally {
    clearTimeout(timer);
    await session.close();
    globalThis.fetch = networkFetch;
  }
}
process.exitCode = failed ? 1 : 0;
