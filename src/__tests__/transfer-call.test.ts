import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transferCallerToOfficeMock = vi.hoisted(() => vi.fn());

vi.mock("../tools/handoff.js", () => ({
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
  return {
    state,
    ctx: {
      session: { userData: state },
      speechHandle,
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

  it("starts the transfer without waiting for speech playout", async () => {
    const { state, ctx } = createToolContext();

    const result = await executeTransfer(ctx, "tool-1");

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(ctx.waitForPlayout).not.toHaveBeenCalled();
    expect(transferCallerToOfficeMock).toHaveBeenCalledWith(state);
    expect(result).toBe("Transfer started to the spring-hill office.");
    expect(transferStatus(state)).toBe("accepted");
    expect(transferIsAccepted(state)).toBe(true);
  });

  it("does not mark the call transferred when handoff fails", async () => {
    const { state, ctx } = createToolContext();
    transferCallerToOfficeMock.mockRejectedValueOnce(
      new Error("handoff failed"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await executeTransfer(ctx, "tool-1");

    expect(result).toBe("Could not transfer the call.");
    expect(transferCallerToOfficeMock).toHaveBeenCalledWith(state);
    expect(transferIsAccepted(state)).toBe(false);
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
