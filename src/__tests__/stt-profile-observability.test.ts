import { describe, expect, it } from "vitest";
import { snapshotSttProfileTransition } from "../runtime/stt-profile-observability.js";

describe("STT profile observability", () => {
  it("captures profile transition metadata without copied transcript text", () => {
    const transition = snapshotSttProfileTransition({
      createdAt: Date.parse("2026-05-20T10:05:00.000Z"),
      from: "default",
      reason: "assistant_prompt",
      to: "email",
    });

    expect(transition).toEqual({
      createdAt: "2026-05-20T10:05:00.000Z",
      from: "default",
      reason: "assistant_prompt",
      to: "email",
    });
  });
});
