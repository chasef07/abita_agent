import { afterEach, describe, expect, it, vi } from "vitest";
import {
  add_patient,
  book_appt,
  cancel_appt,
  makeCurrentSpeechUninterruptible,
  transfer_call,
  update_insurance,
  type CallState,
} from "../tools.js";

type SpeechContext = Parameters<typeof makeCurrentSpeechUninterruptible>[0];
type ToolContext = Parameters<typeof book_appt.execute>[1]["ctx"];

describe("tool interruption handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("marks the active speech handle as uninterruptible", () => {
    const speechHandle = { allowInterruptions: true };

    const result = makeCurrentSpeechUninterruptible({
      speechHandle,
    } as SpeechContext);

    expect(result).toBe(true);
    expect(speechHandle.allowInterruptions).toBe(false);
  });

  it("does not throw if the active speech was already interrupted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const speechHandle = {};
    Object.defineProperty(speechHandle, "allowInterruptions", {
      get: () => true,
      set: () => {
        throw new Error("speech already interrupted");
      },
    });

    const result = makeCurrentSpeechUninterruptible({
      speechHandle,
    } as SpeechContext);

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("marks side-effecting tools as uninterruptible before the side effect", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "ok", patientId: "patient-2" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const mutationTools = [
      {
        name: "add_patient",
        run: (ctx: ToolContext) =>
          add_patient.execute(
            {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/01/1980",
              street: "123 Main St",
              aptSuite: "",
              city: "Spring Hill",
              state: "FL",
              zip: "34609",
              sex: "female",
              insurance: "Aetna",
              subscriberName: "Jane Doe",
              subscriberNum: "ABC123",
            },
            { ctx, toolCallId: "test-add" },
          ),
      },
      {
        name: "update_insurance",
        run: (ctx: ToolContext) =>
          update_insurance.execute(
            {
              insurance: "Aetna",
              subscriberName: "Jane Doe",
              subscriberNum: "ABC123",
            },
            { ctx, toolCallId: "test-update" },
          ),
      },
      {
        name: "cancel_appt",
        run: (ctx: ToolContext) =>
          cancel_appt.execute(
            { appointmentId: 12345 },
            { ctx, toolCallId: "test-cancel" },
          ),
      },
      {
        name: "book_appt",
        run: (ctx: ToolContext) =>
          book_appt.execute(
            {
              columnId: 1,
              profileId: 2,
              startDatetime: "2026-04-28T09:00",
              duration: 15,
              appointmentTypeId: 1007,
            },
            { ctx, toolCallId: "test-book" },
          ),
      },
    ];

    for (const mutationTool of mutationTools) {
      const { ctx, speechHandle } = createToolContext();

      await mutationTool.run(ctx);

      expect(speechHandle.allowInterruptions, mutationTool.name).toBe(false);
    }

    expect(fetchMock).toHaveBeenCalledTimes(mutationTools.length);

    const { ctx, speechHandle, state } = createToolContext();
    state.sipRoomName = "";

    await transfer_call.execute({}, { ctx, toolCallId: "test-transfer" });

    expect(speechHandle.allowInterruptions).toBe(false);
    expect(ctx.waitForPlayout).toHaveBeenCalledOnce();
  });

  it("does not run side effects if the speech already became interrupted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const mutationTools = [
      {
        name: "add_patient",
        run: (ctx: ToolContext) =>
          add_patient.execute(
            {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/01/1980",
              street: "123 Main St",
              aptSuite: "",
              city: "Spring Hill",
              state: "FL",
              zip: "34609",
              sex: "female",
              insurance: "Aetna",
              subscriberName: "Jane Doe",
              subscriberNum: "ABC123",
            },
            { ctx, toolCallId: "test-add" },
          ),
      },
      {
        name: "update_insurance",
        run: (ctx: ToolContext) =>
          update_insurance.execute(
            {
              insurance: "Aetna",
              subscriberName: "Jane Doe",
              subscriberNum: "ABC123",
            },
            { ctx, toolCallId: "test-update" },
          ),
      },
      {
        name: "cancel_appt",
        run: (ctx: ToolContext) =>
          cancel_appt.execute(
            { appointmentId: 12345 },
            { ctx, toolCallId: "test-cancel" },
          ),
      },
      {
        name: "book_appt",
        run: (ctx: ToolContext) =>
          book_appt.execute(
            {
              columnId: 1,
              profileId: 2,
              startDatetime: "2026-04-28T09:00",
              duration: 15,
              appointmentTypeId: 1007,
            },
            { ctx, toolCallId: "test-book" },
          ),
      },
    ];

    for (const mutationTool of mutationTools) {
      const { ctx } = createInterruptedToolContext();
      const result = await mutationTool.run(ctx);

      expect(result, mutationTool.name).toMatch(/interrupted/i);
    }

    const { ctx } = createInterruptedToolContext();
    const transferResult = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer" },
    );

    expect(transferResult).toMatch(/interrupted/i);
    expect(ctx.waitForPlayout).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

function createToolContext() {
  const speechHandle = { allowInterruptions: true };
  const state: CallState = {
    officeKey: "spring-hill",
    officePhone: "+17275919997",
    amdOfficePhone: "+17275919997",
    sipRoomName: "room",
    sipParticipantIdentity: "caller",
    callerPhone: "+17275551212",
    patientId: "patient-1",
    patientName: "Jane Doe",
    dob: "01/01/1980",
    insuranceCarrier: "Old Plan",
    insPlanId: "plan-1",
    respPartyId: "resp-1",
    checkedInsurancePlan: "Aetna",
    routing: "accepted",
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointments: [],
    transferred: false,
  };
  const ctx = {
    session: { userData: state },
    speechHandle,
    waitForPlayout: vi.fn(),
  } as unknown as ToolContext;

  return { ctx, speechHandle, state };
}

function createInterruptedToolContext() {
  const { state } = createToolContext();
  const speechHandle = {};
  Object.defineProperty(speechHandle, "allowInterruptions", {
    get: () => true,
    set: () => {
      throw new Error("speech already interrupted");
    },
  });
  const ctx = {
    session: { userData: state },
    speechHandle,
    waitForPlayout: vi.fn(),
  } as unknown as ToolContext;

  return { ctx, speechHandle, state };
}
