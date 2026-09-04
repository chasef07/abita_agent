import {
  AgentSessionEventTypes,
  createUserTranscriptionTimeoutEvent,
  type AgentSession,
} from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import {
  attachTranscriptionTimeoutRecovery,
  voiceTranscriptionTimeoutMs,
} from "../runtime/transcription-timeout-recovery.js";
import type { CallState } from "../state/call-state.js";

class TestSession {
  readonly generateReply = vi.fn();
  readonly listeners = new Map<string, (event: never) => void>();

  on(event: string, listener: (event: never) => void) {
    this.listeners.set(event, listener);
  }

  emit(event: string, payload: unknown) {
    this.listeners.get(event)?.(payload as never);
  }
}

describe("transcription timeout recovery", () => {
  it("uses a three-and-a-half-second timeout", () => {
    expect(voiceTranscriptionTimeoutMs).toBe(3_500);
  });

  it("asks the caller to repeat after meaningful speech produces no transcript", () => {
    const session = new TestSession();
    attachTranscriptionTimeoutRecovery(
      session as unknown as AgentSession<CallState>,
    );

    session.emit(
      AgentSessionEventTypes.UserTranscriptionTimeout,
      createUserTranscriptionTimeoutEvent({
        speechDuration: 400,
        vadSpeechStartedAt: Date.parse("2026-09-04T12:00:00.000Z"),
      }),
    );

    expect(session.generateReply).toHaveBeenCalledOnce();
    expect(session.generateReply).toHaveBeenCalledWith({
      instructions:
        "In the caller's current language, briefly say you didn't catch that and ask them to repeat it.",
    });
  });

  it("ignores sub-threshold audio blips", () => {
    const session = new TestSession();
    attachTranscriptionTimeoutRecovery(
      session as unknown as AgentSession<CallState>,
    );

    session.emit(
      AgentSessionEventTypes.UserTranscriptionTimeout,
      createUserTranscriptionTimeoutEvent({
        speechDuration: 399,
        vadSpeechStartedAt: Date.parse("2026-09-04T12:00:00.000Z"),
      }),
    );

    expect(session.generateReply).not.toHaveBeenCalled();
  });
});
