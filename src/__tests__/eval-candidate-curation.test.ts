import { describe, expect, it } from "vitest";
import { curateDecisionPointCases } from "../../evals/lib/candidate-curation.js";
import type { DecisionPointCase } from "../../evals/lib/types.js";

function makeCase(
  overrides: Partial<DecisionPointCase>,
  turn: number,
): DecisionPointCase {
  return {
    id: `SCL_TEST-language-turn-${turn}`,
    suite: "language",
    source: "livekit-trace",
    traceId: "SCL_TEST",
    tags: ["language", "spanish", "needs-review"],
    context: {
      trunkPhone: "+17275919997",
      phoneLookupStatus: "unknown",
      notes:
        "Real call: caller spoke Spanish. Check the agent replied in Spanish, not English.",
    },
    conversation: [
      { role: "assistant", content: "hello" },
      { role: "user", content: "hola" },
    ],
    expectations: {
      mustCallTools: [],
      mustNotCallTools: [],
      policyFlags: ["match_caller_language"],
      styleFlags: ["responds_in_spanish", "concise"],
    },
    ...overrides,
  };
}

describe("candidate curation", () => {
  it("prunes repeated copies of the same decision pattern within one trace", () => {
    const first = makeCase({}, 2);
    const later = makeCase(
      {
        id: "SCL_TEST-language-turn-12",
        conversation: [
          { role: "assistant", content: "hello" },
          { role: "user", content: "hola" },
          { role: "assistant", content: "si" },
          { role: "user", content: "necesito ayuda" },
        ],
      },
      12,
    );

    const { curated, removed } = curateDecisionPointCases([later, first]);

    expect(curated.map((testCase) => testCase.id)).toEqual([
      "SCL_TEST-language-turn-2",
    ]);
    expect(removed.map((testCase) => testCase.id)).toEqual([
      "SCL_TEST-language-turn-12",
    ]);
  });

  it("keeps distinct signatures from the same call", () => {
    const scheduling = makeCase(
      {
        id: "SCL_TEST-scheduling-turn-4",
        suite: "scheduling",
        tags: ["scheduling", "missing-reason", "needs-review"],
        context: {
          trunkPhone: "+17275919997",
          phoneLookupStatus: "unknown",
          notes:
            "Real call: agent jumped to get_availability without asking the reason for visit.",
        },
        expectations: {
          mustCallTools: [],
          mustNotCallTools: ["get_availability"],
          policyFlags: ["ask_reason_before_get_availability"],
          styleFlags: ["concise"],
        },
      },
      4,
    );
    const transfer = makeCase(
      {
        id: "SCL_TEST-transfer-turn-5",
        suite: "transfer",
        tags: ["transfer", "human-request"],
        context: {
          trunkPhone: "+17275919997",
          phoneLookupStatus: "unknown",
          notes: "Extracted from a call that transferred to a human.",
        },
        expectations: {
          mustCallTools: ["transfer_call"],
          mustNotCallTools: [],
          policyFlags: ["caller_requested_human"],
          styleFlags: [],
        },
      },
      5,
    );

    const { curated, removed } = curateDecisionPointCases([
      scheduling,
      transfer,
    ]);

    expect(curated).toHaveLength(2);
    expect(removed).toHaveLength(0);
  });
});
