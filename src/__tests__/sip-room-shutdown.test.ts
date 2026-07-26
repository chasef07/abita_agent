import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachSipParticipantShutdown } from "../runtime/sip-room-shutdown.js";

type TestParticipant = {
  identity: string;
};

class TestRoom extends EventEmitter {
  remoteParticipants = new Map<string, TestParticipant>();

  disconnectParticipant(participant: TestParticipant) {
    this.remoteParticipants.delete(participant.identity);
    this.emit("participantDisconnected", participant);
  }
}

function createContext(room: TestRoom) {
  return {
    room,
    shutdown: vi.fn(),
  };
}

describe("SIP room shutdown", () => {
  it("shuts down the LiveKit job when the SIP participant disconnects", () => {
    const room = new TestRoom();
    const participant = { identity: "sip-caller" };
    room.remoteParticipants.set(participant.identity, participant);
    const ctx = createContext(room);
    const logger = { log: vi.fn() };

    attachSipParticipantShutdown(ctx, participant, {
      isTransferred: () => true,
      logger,
    });

    room.disconnectParticipant(participant);

    expect(ctx.shutdown).toHaveBeenCalledTimes(1);
    expect(ctx.shutdown).toHaveBeenCalledWith(
      "sip participant disconnected: sip-caller",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "[call] SIP participant sip-caller disconnected (transferred=true), shutting down job",
    );
  });

  it("signals startup abandonment before requesting LiveKit shutdown", () => {
    const room = new TestRoom();
    const participant = { identity: "sip-caller" };
    room.remoteParticipants.set(participant.identity, participant);
    const ctx = createContext(room);
    const events: string[] = [];
    ctx.shutdown.mockImplementation(() => {
      events.push("shutdown");
    });

    attachSipParticipantShutdown(ctx, participant, {
      logger: { log: vi.fn() },
      onShutdownRequested: () => {
        events.push("abandon");
      },
    });

    room.disconnectParticipant(participant);

    expect(events).toEqual(["abandon", "shutdown"]);
  });

  it("ignores other participants and duplicate disconnect events", () => {
    const room = new TestRoom();
    const participant = { identity: "sip-caller" };
    room.remoteParticipants.set(participant.identity, participant);
    const ctx = createContext(room);

    attachSipParticipantShutdown(ctx, participant, {
      logger: { log: vi.fn() },
    });

    room.disconnectParticipant({ identity: "agent-monitor" });
    room.disconnectParticipant(participant);
    room.emit("participantDisconnected", participant);

    expect(ctx.shutdown).toHaveBeenCalledTimes(1);
  });

  it("shuts down immediately if the SIP participant already left", () => {
    const room = new TestRoom();
    const participant = { identity: "sip-caller" };
    const ctx = createContext(room);

    attachSipParticipantShutdown(ctx, participant, {
      isTransferred: () => {
        throw new Error("userData not initialized");
      },
      logger: { log: vi.fn() },
    });

    expect(ctx.shutdown).toHaveBeenCalledTimes(1);
    expect(ctx.shutdown).toHaveBeenCalledWith(
      "sip participant disconnected: sip-caller",
    );
  });
});
