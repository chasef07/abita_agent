import { createHash } from "node:crypto";
import { SipClient } from "livekit-server-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transferSipParticipantMock = vi.hoisted(() => vi.fn());

vi.mock("livekit-server-sdk", () => ({
  SipClient: vi.fn(function SipClientMock() {
    return {
      transferSipParticipant: transferSipParticipantMock,
    };
  }),
}));

import { createCanonicalCallState } from "../state/call-state.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_DEMO_TRANSFER_NUMBER,
  DEV_OFFICE_PHONE,
  getOfficeHandoffTarget,
} from "../customers/profile.js";
import { transferCallerToOffice } from "../tools/handoff.js";

const DIRECT_TOKEN = "a".repeat(43);
const DIRECT_RESPONSE = {
  type: "DIRECT",
  handoffId: "handoff-test",
  sipUri: `sip:one-time-route~ah1~${DIRECT_TOKEN}@handoff.example`,
  expiresAt: "2099-07-13T12:00:30.000Z",
};

function createState() {
  return createCanonicalCallState({
    preCallLookup: { status: "not_attempted", durationMs: null },
    officeKey: "spring-hill",
    amdOfficePhone: "+17275919997",
    sipRoomName: "test-room",
    sipParticipantIdentity: "sip-caller",
    callId: "call-test",
    callerPhone: "+17275551212",
    trunkPhone: "+17275919997",
    patientId: null,
    patientName: null,
    dob: null,
    insuranceCarrier: null,
    insPlanId: null,
    respPartyId: null,
    checkedInsurancePlan: null,
    checkedInsuranceCoverageType: null,
    routing: null,
    lastAvailabilityRouting: null,
    lastAvailabilitySlots: [],
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointmentsStatus: null,
    appointments: [],
    transferred: false,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("call-center handoff", () => {
  beforeEach(() => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "");
    vi.stubEnv("ACUITY_HANDOFF_PHONE_FALLBACK_ENABLED", "");
    vi.stubEnv("SPRING_HILL_HANDOFF_TARGET", "");
    vi.stubEnv("TELNYX_VOICE_API_HANDOFF_TARGET", "");
    transferSipParticipantMock.mockReset();
    transferSipParticipantMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fails closed when direct handoff is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity handoff API configuration is incomplete.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
    expect(state.runtime.transferState).toBe("idle");
    expect(state.runtime.transferred).toBe(false);
  });

  it("routes Crystal River directly to its configured phone target", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    state.runtime.trunkPhone = CRYSTAL_RIVER_OFFICE_PHONE;
    const target = getOfficeHandoffTarget("crystal-river");

    const result = await transferCallerToOffice(state);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      handoffOfficeKey: "crystal-river",
      handoffTarget: target,
    });
    expect(transferSipParticipantMock).toHaveBeenCalledWith(
      "test-room",
      "sip-caller",
      target,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Acuity-Handoff-Target": target,
          "X-Acuity-Office-Key": "crystal-river",
        }),
        playDialtone: true,
        ringingTimeout: 20,
      }),
    );
    expect(vi.mocked(SipClient).mock.calls.at(-1)?.[3]).toBeUndefined();
  });

  it("routes the demo directly to the configured demo cellphone", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    state.runtime.trunkPhone = DEV_OFFICE_PHONE;

    const result = await transferCallerToOffice(state);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      handoffOfficeKey: "dev",
      handoffTarget: `tel:${DEV_DEMO_TRANSFER_NUMBER}`,
    });
    expect(transferSipParticipantMock).toHaveBeenCalledWith(
      "test-room",
      "sip-caller",
      `tel:${DEV_DEMO_TRANSFER_NUMBER}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Acuity-Handoff-Target": `tel:${DEV_DEMO_TRANSFER_NUMBER}`,
          "X-Acuity-Office-Key": "dev",
        }),
        playDialtone: true,
        ringingTimeout: 20,
      }),
    );
  });

  it("reserves and transfers once to the direct SIP target", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    const fetchMock = vi.fn(async () => jsonResponse(DIRECT_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);
    const payload = {
      sourceCallId: "call-test",
      routePhoneNumber: "+17275919997",
      callerPhone: "+17275551212",
    };
    const idempotencyKey = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");

    const state = createState();
    const result = await transferCallerToOffice(state);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://handoff.example/internal",
      expect.objectContaining({
        body: JSON.stringify(payload),
        headers: {
          Authorization: "Bearer test-secret",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        method: "POST",
      }),
    );
    expect(result).toEqual({
      handoffOfficeKey: "spring-hill",
      handoffTarget: DIRECT_RESPONSE.sipUri,
    });
    expect(transferSipParticipantMock).toHaveBeenCalledTimes(1);
    expect(transferSipParticipantMock).toHaveBeenCalledWith(
      "test-room",
      "sip-caller",
      DIRECT_RESPONSE.sipUri,
      {
        playDialtone: true,
        ringingTimeout: 20,
      },
    );
    expect(vi.mocked(SipClient).mock.calls.at(-1)?.[3]).toEqual({
      failover: false,
    });
    expect(state.runtime.transferState).toBe("accepted");
    expect(state.runtime.transferred).toBe(false);
  });

  it("fails before REFER when the direct response is invalid", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ...DIRECT_RESPONSE,
          handoffId: "",
        }),
      ),
    );

    await expect(transferCallerToOffice(createState())).rejects.toThrow(
      "Acuity handoff API returned an invalid response.",
    );
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("rejects a direct response whose SIP URI loses the token", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ...DIRECT_RESPONSE,
          sipUri: "sip:one-time-route@handoff.example",
        }),
      ),
    );

    await expect(transferCallerToOffice(createState())).rejects.toThrow(
      "Acuity handoff API returned an invalid response.",
    );
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("rejects a SIP URI carrying a malformed handoff token", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ...DIRECT_RESPONSE,
          sipUri: `sip:one-time-route~ah1~${"b".repeat(42)}@handoff.example`,
        }),
      ),
    );

    await expect(transferCallerToOffice(createState())).rejects.toThrow(
      "Acuity handoff API returned an invalid response.",
    );
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("uses the phone fallback only when explicitly enabled", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubEnv("ACUITY_HANDOFF_PHONE_FALLBACK_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 503)),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await transferCallerToOffice(createState());

    expect(result.handoffTarget).toBe("tel:+16182265883");
    expect(transferSipParticipantMock).toHaveBeenCalledTimes(1);
    expect(transferSipParticipantMock.mock.calls[0]?.[2]).toBe(
      "tel:+16182265883",
    );
    expect(warn).toHaveBeenCalledWith(
      "[tools] Acuity handoff resolution failed; using the configured phone fallback.",
    );
  });

  it("never phone-fallbacks an existing-transfer conflict", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubEnv("ACUITY_HANDOFF_PHONE_FALLBACK_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 409)),
    );

    await expect(transferCallerToOffice(createState())).rejects.toThrow(
      "Acuity handoff conflicts with an existing transfer.",
    );
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("uses a two-second API timeout and fails closed", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("request failed");
      }),
    );

    await expect(transferCallerToOffice(createState())).rejects.toThrow(
      "Acuity handoff API request failed.",
    );
    expect(timeout).toHaveBeenCalledWith(2_000);
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("rejects an insecure handoff API URL before sending data", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "http://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(transferCallerToOffice(createState())).rejects.toThrow(
      "Acuity handoff API URL must use HTTPS.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("rejects a SIP URI containing credentials", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ...DIRECT_RESPONSE,
          sipUri: "sip:user:password@handoff.example",
        }),
      ),
    );

    await expect(transferCallerToOffice(createState())).rejects.toThrow(
      "Acuity handoff API returned an invalid response.",
    );
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("records an upstream timeout as ambiguous without claiming success", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubEnv("ACUITY_HANDOFF_PHONE_FALLBACK_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(DIRECT_RESPONSE)),
    );
    transferSipParticipantMock.mockRejectedValueOnce(new Error("timeout"));

    const state = createState();
    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "SIP transfer outcome is unknown.",
    );
    expect(state.runtime.transferState).toBe("ambiguous");
    expect(state.runtime.transferred).toBe(false);
    expect(transferSipParticipantMock).toHaveBeenCalledTimes(1);
    expect(transferSipParticipantMock.mock.calls[0]?.[2]).toBe(
      DIRECT_RESPONSE.sipUri,
    );
  });

  it("does not make a phone REFER retryable after an ambiguous failure", async () => {
    vi.stubEnv("ACUITY_HANDOFF_PHONE_FALLBACK_ENABLED", "true");
    transferSipParticipantMock.mockRejectedValueOnce(new Error("rejected"));
    const state = createState();

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "SIP transfer outcome is unknown.",
    );

    expect(state.runtime.transferState).toBe("ambiguous");
    expect(state.runtime.transferred).toBe(false);
  });

  it("keeps a late provider success pending until it is accepted", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(DIRECT_RESPONSE)),
    );
    let accept!: () => void;
    transferSipParticipantMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const state = createState();

    const transfer = transferCallerToOffice(state);
    await vi.waitFor(() => {
      expect(state.runtime.transferState).toBe("pending");
    });
    expect(state.runtime.transferred).toBe(false);

    accept();
    await expect(transfer).resolves.toEqual({
      handoffOfficeKey: "spring-hill",
      handoffTarget: DIRECT_RESPONSE.sipUri,
    });
    expect(state.runtime.transferState).toBe("accepted");
  });
});
