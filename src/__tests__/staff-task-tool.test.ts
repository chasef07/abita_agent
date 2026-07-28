import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customers/abita/profile.js";
import type { InitialCallStateInput } from "../state/call-state.js";
import { staffTaskReceipts } from "../state/observability.js";
import { create_staff_task } from "../tools/index.js";
import { getStaffTasksUrl } from "../tools/create-staff-task.js";
import { createConfirmedPatientState } from "./support/call-state.js";

function createState(overrides: Partial<InitialCallStateInput> = {}) {
  return createConfirmedPatientState({
    trunkPhone: "+18135484830",
    ...overrides,
  });
}

function createToolContext(state: ReturnType<typeof createState>) {
  return {
    disallowInterruptions: vi.fn(),
    session: { userData: state },
  };
}

describe("create_staff_task", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("derives the task URL from the analytics call URL", () => {
    expect(
      getStaffTasksUrl({
        ANALYTICS_URL: "https://portal.example/api/livekit/calls",
      }),
    ).toBe("https://portal.example/api/livekit/tasks");
    expect(
      getStaffTasksUrl({
        ANALYTICS_URL: "https://portal.example/api/livekit/calls/",
      }),
    ).toBe("https://portal.example/api/livekit/tasks");
  });

  it("posts a non-Spring Hill task with bearer auth and backend-owned office state", async () => {
    vi.stubEnv("ANALYTICS_URL", "https://portal.example/api/livekit/calls");
    vi.stubEnv("LIVEKIT_FORWARD_SYNC_SECRET", "task-secret");
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "created",
        taskId: "task-1",
        category: "billing",
        urgency: "high_priority",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState({
      amdOfficePhone: SWEETWATER_OFFICE_PHONE,
      officeKey: "sweetwater",
      trunkPhone: SWEETWATER_TRUNK_PHONES[1],
    });
    const ctx = createToolContext(state);

    const result = await create_staff_task.execute(
      {
        category: "billing",
        urgency: "high_priority",
        summary: "Caller has a billing question.",
        message: "Caller received a bill and wants the team to review it.",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toContain("Task sent to staff");
    expect(ctx.disallowInterruptions).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://portal.example/api/livekit/tasks",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer task-secret",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );

    const body = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      callId: "call-test",
      callerPhone: "+17275551212",
      category: "billing",
      inboundOfficePhone: SWEETWATER_TRUNK_PHONES[1],
      message: "Caller received a bill and wants the team to review it.",
      officeKey: "sweetwater",
      officePhone: SWEETWATER_OFFICE_PHONE,
      source: "agent",
      summary: "Caller has a billing question.",
      urgency: "high_priority",
    });
    expect(body.idempotencyKey).toMatch(/^staff_task_[a-f0-9]{64}$/);
    expect(body.patient).toEqual({
      dob: "01/01/1980",
      id: "patient-1",
      name: "Jane Doe",
    });
    expect(staffTaskReceipts(state)).toMatchObject([
      {
        category: "billing",
        idempotencyKey: body.idempotencyKey,
        message: "Caller received a bill and wants the team to review it.",
        status: "created",
        summary: "Caller has a billing question.",
        taskId: "task-1",
        urgency: "high_priority",
      },
    ]);
  });

  it("returns the existing receipt for a duplicate task in one call", async () => {
    vi.stubEnv("ANALYTICS_URL", "https://portal.example/api/livekit/calls");
    vi.stubEnv("LIVEKIT_FORWARD_SYNC_SECRET", "task-secret");
    const fetchMock = vi.fn(async () =>
      Response.json({ status: "created", taskId: "task-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    const ctx = createToolContext(state);
    const input = {
      category: "documentation" as const,
      urgency: "normal" as const,
      summary: "Caller needs paperwork sent.",
      message: "Caller wants the team to send the school form.",
    };

    await create_staff_task.execute(input, {
      ctx: ctx as never,
      toolCallId: "tool-1",
    } as never);
    const result = await create_staff_task.execute(input, {
      ctx: ctx as never,
      toolCallId: "tool-2",
    } as never);

    expect(result).toContain("Task already sent to staff");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(staffTaskReceipts(state)).toHaveLength(1);
  });

  it("fails honestly and stores no receipt when posting is unavailable", async () => {
    vi.stubEnv("ANALYTICS_URL", "https://portal.example/api/livekit/calls");
    vi.stubEnv("LIVEKIT_FORWARD_SYNC_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    const ctx = createToolContext(state);

    const result = await create_staff_task.execute(
      {
        category: "other",
        urgency: "normal",
        summary: "Caller wants a message sent.",
        message: "Caller wants Debbie to call them back about their glasses.",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toContain("Could not send the staff task");
    expect(result).toContain("transfer you to the office");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(staffTaskReceipts(state)).toEqual([]);
  });
});
