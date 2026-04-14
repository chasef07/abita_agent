/**
 * In-process Promptfoo provider for the LiveKit voice agent.
 *
 * Loads the agent module ONCE and runs every test case in the same Node
 * process — saves ~2 sec of tsx startup + heavy SDK imports per case
 * (LiveKit Agents, Baseten plugin, etc.). For a 93-case eval that's ~3-4 min
 * per workspace.
 *
 * Requires the host Node process to have a TypeScript loader registered, since
 * we import a .ts file directly. Tournament/optimize-nightly set this via
 * NODE_OPTIONS="--import tsx" before invoking promptfoo. For ad-hoc runs use:
 *
 *   NODE_OPTIONS="--import tsx" npm run evals:run
 */

import { runDecisionPointCase } from "../lib/run-decision-point-case.ts";

export default class LivekitAgentEvalProvider {
  constructor(options = {}) {
    this.options = options;
  }

  id() {
    return "livekit-agent-eval";
  }

  async callApi(prompt, context) {
    const casePath = context?.vars?.casePath;
    const model = context?.vars?.model || this.options?.config?.model;

    if (!casePath || typeof casePath !== "string") {
      throw new Error("Promptfoo test is missing vars.casePath");
    }

    try {
      const result = await runDecisionPointCase(casePath, model);
      return { output: JSON.stringify(result) };
    } catch (error) {
      return {
        output: JSON.stringify({
          caseId: casePath,
          error: error?.message ?? String(error),
          finalText: "",
          toolCalls: [],
          assistantMessages: [],
        }),
        error: error?.message ?? String(error),
      };
    }
  }
}
