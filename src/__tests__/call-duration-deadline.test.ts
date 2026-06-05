import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALL_DURATION_LIMIT_REASON,
  attachCallDurationDeadline,
} from "../runtime/call-duration-deadline.js";

describe("call duration deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes the room and shuts down when the deadline expires", async () => {
    const ctx = {
      deleteRoom: vi.fn(async () => undefined),
      shutdown: vi.fn(),
    };
    const logger = { error: vi.fn(), warn: vi.fn() };
    const onExceeded = vi.fn();
    const shutdownSession = vi.fn();

    const deadline = attachCallDurationDeadline(ctx, {
      callId: "call-1",
      logger,
      onExceeded,
      roomName: "room-1",
      shutdownSession,
      timeoutMs: 1_000,
    });

    vi.advanceTimersByTime(999);

    expect(deadline.exceeded()).toBe(false);
    expect(ctx.deleteRoom).not.toHaveBeenCalled();
    expect(ctx.shutdown).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await deadline.waitForRoomDeletion();

    expect(deadline.exceeded()).toBe(true);
    expect(deadline.roomDeletionStarted()).toBe(true);
    expect(deadline.roomDeletionCompleted()).toBe(true);
    expect(onExceeded).toHaveBeenCalledTimes(1);
    expect(shutdownSession).toHaveBeenCalledWith(CALL_DURATION_LIMIT_REASON);
    expect(ctx.deleteRoom).toHaveBeenCalledWith("room-1");
    expect(ctx.shutdown).toHaveBeenCalledWith(CALL_DURATION_LIMIT_REASON);
    expect(shutdownSession.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.deleteRoom.mock.invocationCallOrder[0] ?? 0,
    );
    expect(ctx.deleteRoom.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.shutdown.mock.invocationCallOrder[0] ?? 0,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[call] Maximum call duration reached for call-1; limitMs=1000, room=room-1",
    );
  });

  it("still deletes the room and shuts down the job if session shutdown fails", async () => {
    const ctx = {
      deleteRoom: vi.fn(async () => undefined),
      shutdown: vi.fn(),
    };
    const error = new Error("session already closing");
    const logger = { error: vi.fn(), warn: vi.fn() };

    const deadline = attachCallDurationDeadline(ctx, {
      callId: "call-1",
      logger,
      roomName: "room-1",
      shutdownSession: () => {
        throw error;
      },
      timeoutMs: 1_000,
    });

    vi.advanceTimersByTime(1_000);
    await deadline.waitForRoomDeletion();

    expect(ctx.deleteRoom).toHaveBeenCalledWith("room-1");
    expect(ctx.shutdown).toHaveBeenCalledWith(CALL_DURATION_LIMIT_REASON);
    expect(logger.error).toHaveBeenCalledWith(
      "[call] Failed to shut down agent session after duration limit for call-1:",
      error,
    );
  });

  it("does nothing after the deadline is cleared", () => {
    const ctx = {
      deleteRoom: vi.fn(async () => undefined),
      shutdown: vi.fn(),
    };
    const deadline = attachCallDurationDeadline(ctx, {
      callId: "call-1",
      logger: { error: vi.fn(), warn: vi.fn() },
      roomName: "room-1",
      timeoutMs: 1_000,
    });

    deadline.clear();
    vi.advanceTimersByTime(1_000);

    expect(deadline.exceeded()).toBe(false);
    expect(ctx.deleteRoom).not.toHaveBeenCalled();
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("shuts down even when the room name is missing", () => {
    const ctx = {
      deleteRoom: vi.fn(async () => undefined),
      shutdown: vi.fn(),
    };
    const deadline = attachCallDurationDeadline(ctx, {
      callId: "call-1",
      logger: { error: vi.fn(), warn: vi.fn() },
      roomName: "",
      shutdownSession: vi.fn(),
      timeoutMs: 1_000,
    });

    vi.advanceTimersByTime(1_000);

    expect(deadline.exceeded()).toBe(true);
    expect(deadline.roomDeletionStarted()).toBe(false);
    expect(ctx.deleteRoom).not.toHaveBeenCalled();
    expect(ctx.shutdown).toHaveBeenCalledWith(CALL_DURATION_LIMIT_REASON);
  });
});
