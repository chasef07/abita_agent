import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  HandoffConflictErrorMock,
  HandoffErrorMock,
  transferCallerToOfficeMock,
} = vi.hoisted(() => ({
  HandoffConflictErrorMock: class HandoffConflictError extends Error {},
  HandoffErrorMock: class HandoffError extends Error {},
  transferCallerToOfficeMock: vi.fn(),
}));

vi.mock("../tools/handoff.js", () => ({
  HandoffConflictError: HandoffConflictErrorMock,
  HandoffError: HandoffErrorMock,
  transferCallerToOffice: transferCallerToOfficeMock,
}));

import {
  acceptTransfer,
  beginTransfer,
  markTransferAmbiguous,
  transferIsAccepted,
  transferStatus,
} from "../state/call-lifecycle.js";
import { transfer_call } from "../tools/transfer-call.js";
import { createTestCallState } from "./support/call-state.js";

function createToolContext() {
  const state = createTestCallState();
  const speechHandle = { allowInterruptions: true };
  const announcementHandle = {
    waitForPlayout: vi.fn(async () => undefined),
  };
  return {
    state,
    ctx: {
      session: {
        userData: state,
        say: vi.fn(() => announcementHandle),
      },
      speechHandle,
      announcementHandle,
      disallowInterruptions: vi.fn(() => {
        speechHandle.allowInterruptions = false;
      }),
      waitForPlayout: vi.fn(async () => undefined),
    },
  };
}

async function executeTransfer(
  ctx: ReturnType<typeof createToolContext>["ctx"],
  toolCallId: string,
) {
  return transfer_call.execute({}, { ctx: ctx as never, toolCallId } as never);
}

describe("transfer call", () => {
  beforeEach(() => {
    transferCallerToOfficeMock.mockImplementation(async (state) => {
      acceptTransfer(state);
      return {
        handoffOfficeKey: "spring-hill",
        handoffTarget: "sip:direct-handoff@example.test",
      };
    });
  });

  afterEach(() => {
    transferCallerToOfficeMock.mockReset();
    vi.restoreAllMocks();
  });

  it("rejects concurrent duplicate transfer calls", () => {
    expect(transfer_call.onDuplicate).toBe("reject");
  });

  it("announces the transfer after existing speech and before transferring", async () => {
    const { state, ctx } = createToolContext();

    const result = await executeTransfer(ctx, "tool-1");

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(ctx.waitForPlayout).toHaveBeenCalledTimes(1);
    expect(ctx.waitForPlayout.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.session.say.mock.invocationCallOrder[0] ?? 0,
    );
    expect(ctx.session.say).toHaveBeenCalledWith(
      "One moment while I transfer you to the office.",
      { allowInterruptions: false },
    );
    expect(ctx.announcementHandle.waitForPlayout).toHaveBeenCalledTimes(1);
    expect(
      ctx.announcementHandle.waitForPlayout.mock.invocationCallOrder[0],
    ).toBeLessThan(transferCallerToOfficeMock.mock.invocationCallOrder[0] ?? 0);
    expect(transferCallerToOfficeMock).toHaveBeenCalledWith(state);
    expect(result).toBe("Transfer started to the spring-hill office.");
    expect(transferStatus(state)).toBe("accepted");
    expect(transferIsAccepted(state)).toBe(true);
  });

  it("does not mark the call transferred when handoff fails", async () => {
    const { state, ctx } = createToolContext();
    transferCallerToOfficeMock.mockRejectedValueOnce(
      new HandoffErrorMock("handoff failed"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(executeTransfer(ctx, "tool-1")).rejects.toThrow(
      "I couldn't transfer the call. I can try once more.",
    );
    expect(ctx.session.say).toHaveBeenCalledWith(
      "One moment while I transfer you to the office.",
      { allowInterruptions: false },
    );
    expect(
      ctx.announcementHandle.waitForPlayout.mock.invocationCallOrder[0],
    ).toBeLessThan(transferCallerToOfficeMock.mock.invocationCallOrder[0] ?? 0);
    expect(transferCallerToOfficeMock).toHaveBeenCalledWith(state);
    expect(transferIsAccepted(state)).toBe(false);
  });

  it("announces a transfer in the active Spanish call language", async () => {
    const { state, ctx } = createToolContext();
    state.runtime.voiceLanguage = {
      current: "es",
      speaker: "luz",
      ttsLanguage: "es",
      ttsProvider: "rime-inference",
    };

    await executeTransfer(ctx, "tool-1");

    expect(ctx.session.say).toHaveBeenCalledWith(
      "Un momento mientras le transfiero a la oficina.",
      { allowInterruptions: false },
    );
  });

  it("leaves unexpected implementation errors masked by LiveKit", async () => {
    const { ctx } = createToolContext();
    const internalError = new Error("internal implementation detail");
    transferCallerToOfficeMock.mockRejectedValueOnce(internalError);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(executeTransfer(ctx, "tool-1")).rejects.toBe(internalError);
  });

  it("returns normally when the SIP call is no longer active", async () => {
    const { state, ctx } = createToolContext();
    state.runtime.sipRoomName = "";

    await expect(executeTransfer(ctx, "tool-1")).resolves.toBe(
      "I couldn't transfer because the call is no longer active.",
    );
    expect(ctx.session.say).not.toHaveBeenCalled();
    expect(transferCallerToOfficeMock).not.toHaveBeenCalled();
  });

  it("does not retry an existing-handoff conflict", async () => {
    const { state, ctx } = createToolContext();
    transferCallerToOfficeMock.mockRejectedValueOnce(
      new HandoffConflictErrorMock("handoff conflict"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await executeTransfer(ctx, "tool-1");
    const second = await executeTransfer(ctx, "tool-2");

    expect(first).toBe(
      "The transfer may already be in progress. Do not try again.",
    );
    expect(second).toBe(first);
    expect(transferCallerToOfficeMock).toHaveBeenCalledTimes(1);
    expect(transferStatus(state)).toBe("ambiguous");
  });

  it("does not retry after an ambiguous REFER result", async () => {
    const { state, ctx } = createToolContext();
    transferCallerToOfficeMock.mockImplementationOnce(async () => {
      markTransferAmbiguous(state);
      throw new Error("ambiguous transfer result");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await executeTransfer(ctx, "tool-1");
    const second = await executeTransfer(ctx, "tool-2");

    expect(first).toBe(
      "The transfer may already be in progress. Do not try again.",
    );
    expect(second).toBe(
      "The transfer may already be in progress. Do not try again.",
    );
    expect(transferCallerToOfficeMock).toHaveBeenCalledTimes(1);
    expect(transferIsAccepted(state)).toBe(false);
  });

  it("blocks a duplicate invocation while a late success is pending", async () => {
    const { state, ctx } = createToolContext();
    let accept!: () => void;
    transferCallerToOfficeMock.mockImplementationOnce(async () => {
      beginTransfer(state);
      await new Promise<void>((resolve) => {
        accept = resolve;
      });
      acceptTransfer(state);
      return {
        handoffOfficeKey: "spring-hill",
        handoffTarget: "sip:handoff@example.test",
      };
    });

    const first = executeTransfer(ctx, "tool-1");
    await vi.waitFor(() => {
      expect(transferStatus(state)).toBe("pending");
    });
    const second = await executeTransfer(ctx, "tool-2");

    expect(second).toBe("Transfer already in progress.");
    expect(transferCallerToOfficeMock).toHaveBeenCalledTimes(1);
    expect(transferIsAccepted(state)).toBe(false);

    accept();
    await expect(first).resolves.toBe(
      "Transfer started to the spring-hill office.",
    );
    expect(transferStatus(state)).toBe("accepted");
    expect(transferIsAccepted(state)).toBe(true);
  });

  it("keeps caller disconnect ambiguity out of final transferred state", async () => {
    const { state, ctx } = createToolContext();
    transferCallerToOfficeMock.mockImplementationOnce(async () => {
      beginTransfer(state);
      markTransferAmbiguous(state);
      throw new Error("caller disconnected while transfer was pending");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await executeTransfer(ctx, "tool-1");

    expect(result).toBe(
      "The transfer may already be in progress. Do not try again.",
    );
    expect(transferStatus(state)).toBe("ambiguous");
    expect(transferIsAccepted(state)).toBe(false);
  });
});
