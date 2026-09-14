import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  HandoffConflictErrorMock,
  HandoffErrorMock,
  HandoffTaskErrorMock,
  validateHandoffTaskMock,
  transferCallerToOfficeMock,
} = vi.hoisted(() => ({
  HandoffConflictErrorMock: class HandoffConflictError extends Error {},
  HandoffErrorMock: class HandoffError extends Error {},
  HandoffTaskErrorMock: class HandoffTaskError extends Error {},
  validateHandoffTaskMock: vi.fn(),
  transferCallerToOfficeMock: vi.fn(),
}));

vi.mock("../tools/handoff.js", () => ({
  HandoffConflictError: HandoffConflictErrorMock,
  HandoffError: HandoffErrorMock,
  HandoffTaskError: HandoffTaskErrorMock,
  validateHandoffTask: validateHandoffTaskMock,
  transferCallerToOffice: transferCallerToOfficeMock,
}));

import {
  acceptTransfer,
  beginTransfer,
  markTransferAmbiguous,
  transferIsAccepted,
  transferStatus,
} from "../state/call-lifecycle.js";
import { domainOutcomeReceipts } from "../state/observability.js";
import { transfer_call } from "../tools/transfer-call.js";
import { createTestCallState } from "./support/call-state.js";
import {
  DEMO_OFFICE_KEYS,
  getOfficeProfile,
} from "../customers/abita/profile.js";

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
  return transfer_call.execute({ taskId: null }, {
    ctx: ctx as never,
    toolCallId,
  } as never);
}

describe("transfer call", () => {
  beforeEach(() => {
    validateHandoffTaskMock.mockImplementation((state, taskId) => {
      if (
        taskId &&
        !state.runtime.staffTasks.some(
          (receipt: { taskId: string }) => receipt.taskId === taskId,
        )
      ) {
        throw new HandoffTaskErrorMock(
          "Use the Task reference returned for this request.",
        );
      }
    });
    transferCallerToOfficeMock.mockImplementation(async (state) => {
      acceptTransfer(state);
      return {
        handoffOfficeKey: "spring-hill",
        handoffTarget: "sip:direct-handoff@example.test",
      };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    transferCallerToOfficeMock.mockReset();
    validateHandoffTaskMock.mockReset();
    vi.restoreAllMocks();
  });

  it("passes an explicit same-request Task to the handoff", async () => {
    const { state, ctx } = createToolContext();
    const taskId = "11111111-1111-4111-8111-111111111111";
    state.runtime.staffTasks.push({
      taskId,
      createdAt: new Date().toISOString(),
      idempotencyKey: "same-need",
      status: "created",
    });
    await transfer_call.execute({ taskId }, {
      ctx: ctx as never,
      toolCallId: "transfer-task",
    } as never);
    expect(transferCallerToOfficeMock).toHaveBeenCalledWith(state, taskId);
  });

  it("rejects an invented Task reference before speaking or transferring", async () => {
    const { ctx } = createToolContext();
    await expect(
      transfer_call.execute(
        { taskId: "11111111-1111-4111-8111-111111111111" },
        { ctx: ctx as never, toolCallId: "unknown-task" } as never,
      ),
    ).rejects.toThrow("Task reference returned");
    expect(ctx.session.say).not.toHaveBeenCalled();
    expect(transferCallerToOfficeMock).not.toHaveBeenCalled();
  });

  it("keeps a local reference error correctable without announcing or marking ambiguous", async () => {
    const { state, ctx } = createToolContext();
    const taskId = "11111111-1111-4111-8111-111111111111";
    state.runtime.staffTasks.push({
      taskId,
      createdAt: new Date().toISOString(),
      idempotencyKey: "same-need",
      status: "created",
    });
    transferCallerToOfficeMock.mockRejectedValueOnce(
      new HandoffErrorMock("HTTP 500"),
    );
    await expect(
      transfer_call.execute({ taskId }, {
        ctx: ctx as never,
        toolCallId: "first",
      } as never),
    ).rejects.toThrow("try once more");
    validateHandoffTaskMock.mockImplementationOnce(() => {
      throw new HandoffTaskErrorMock("Retry the original transfer with taskId");
    });
    await expect(
      transfer_call.execute({ taskId: null }, {
        ctx: ctx as never,
        toolCallId: "wrong-retry",
      } as never),
    ).rejects.toThrow("Retry the original transfer");
    expect(transferStatus(state)).toBe("idle");
    expect(ctx.session.say).toHaveBeenCalledTimes(1);
    expect(transferCallerToOfficeMock).toHaveBeenCalledTimes(1);
    await transfer_call.execute({ taskId }, {
      ctx: ctx as never,
      toolCallId: "corrected-retry",
    } as never);
    expect(transferStatus(state)).toBe("accepted");
  });

  it.each(DEMO_OFFICE_KEYS)(
    "blocks %s transfers before announcement or handoff",
    async (officeKey) => {
      const { ctx, state } = createToolContext();
      state.runtime.trunkPhone = getOfficeProfile(officeKey).trunkPhones[0]!;
      expect(await executeTransfer(ctx, "sandbox")).toContain(
        "No transfer was made",
      );
      expect(transferCallerToOfficeMock).not.toHaveBeenCalled();
      expect(ctx.session.say).not.toHaveBeenCalled();
      expect(domainOutcomeReceipts(state)).toMatchObject([
        { outcome: "transfer_blocked", status: "blocked" },
      ]);
    },
  );

  it("blocks real office transfers on staging", async () => {
    vi.stubEnv("LIVEKIT_AGENT_DEPLOYMENT", "staging");
    const { ctx } = createToolContext();
    expect(await executeTransfer(ctx, "staging")).toContain(
      "No transfer was made",
    );
    expect(transferCallerToOfficeMock).not.toHaveBeenCalled();
    expect(ctx.session.say).not.toHaveBeenCalled();
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
    expect(transferCallerToOfficeMock).toHaveBeenCalledWith(state, undefined);
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
    expect(transferCallerToOfficeMock).toHaveBeenCalledWith(state, undefined);
    expect(transferIsAccepted(state)).toBe(false);
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "tool-1",
        outcome: "transfer_failed",
        status: "failed",
        toolName: "transfer_call",
      },
    ]);
  });

  it("announces a transfer in the active Spanish call language", async () => {
    const { state, ctx } = createToolContext();
    state.runtime.voiceLanguage = {
      current: "es",
      speaker: "luz",
      ttsLanguage: "spa",
      ttsProvider: "rime",
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

    expect(first).toBe("The transfer may already be in progress.");
    expect(second).toBe(first);
    expect(transferCallerToOfficeMock).toHaveBeenCalledTimes(1);
    expect(transferStatus(state)).toBe("ambiguous");
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "tool-1",
        outcome: "transfer_ambiguous",
        status: "ambiguous",
      },
      {
        callId: "tool-2",
        outcome: "transfer_ambiguous",
        status: "ambiguous",
      },
    ]);
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

    expect(first).toBe("The transfer may already be in progress.");
    expect(second).toBe("The transfer may already be in progress.");
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

    expect(result).toBe("The transfer may already be in progress.");
    expect(transferStatus(state)).toBe("ambiguous");
    expect(transferIsAccepted(state)).toBe(false);
  });
});
