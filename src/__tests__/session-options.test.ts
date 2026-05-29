import { initializeLogger, voice } from "@livekit/agents";
import { beforeAll, describe, expect, it } from "vitest";
import { voiceTurnHandlingOptions } from "../session-options.js";

describe("voice session options", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  it("disables LiveKit preemptive generation", () => {
    const session = new voice.AgentSession({
      turnHandling: voiceTurnHandlingOptions,
    });

    expect(
      session.sessionOptions.turnHandling.preemptiveGeneration.enabled,
    ).toBe(false);
  });
});
