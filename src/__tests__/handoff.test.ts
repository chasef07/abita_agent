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
import { transferCallerToOffice } from "../tools/handoff.js";

const DIRECT_RESPONSE = {
  type: "DIRECT",
  handoffId: "handoff-test",
  sipUri: "sip:one-time-route@handoff.example",
  expiresAt: "2099-07-13T12:00:30.000Z",
  sipHeaders: {
    "X-Acuity-Handoff-Id": "handoff-test",
    "X-Acuity-Handoff-Token": "one-time-token",
  },
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

  it("keeps the current phone handoff when direct handoff is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await transferCallerToOffice(createState());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      handoffOfficeKey: "spring-hill",
      handoffTarget: "tel:+16182265883",
    });
    expect(transferSipParticipantMock).toHaveBeenCalledTimes(1);
    expect(transferSipParticipantMock).toHaveBeenCalledWith(
      "test-room",
      "sip-caller",
      "tel:+16182265883",
      expect.objectContaining({
        playDialtone: true,
        ringingTimeout: 20,
      }),
    );
    expect(vi.mocked(SipClient).mock.calls[0]?.[3]).toBeUndefined();
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

    const result = await transferCallerToOffice(createState());

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
        headers: DIRECT_RESPONSE.sipHeaders,
        playDialtone: true,
        ringingTimeout: 20,
      },
    );
    expect(vi.mocked(SipClient).mock.calls.at(-1)?.[3]).toEqual({
      failover: false,
    });
  });

  it("fails before REFER when the direct response is invalid", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ...DIRECT_RESPONSE,
          sipHeaders: {
            ...DIRECT_RESPONSE.sipHeaders,
            "X-Acuity-Handoff-Token": "",
          },
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

  it("never phone-fallbacks after a direct REFER attempt", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubEnv("ACUITY_HANDOFF_PHONE_FALLBACK_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(DIRECT_RESPONSE)),
    );
    transferSipParticipantMock.mockRejectedValueOnce(new Error("ambiguous"));

    const state = createState();
    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "SIP transfer failed.",
    );
    expect(state.runtime.transferred).toBe(true);
    expect(transferSipParticipantMock).toHaveBeenCalledTimes(1);
    expect(transferSipParticipantMock.mock.calls[0]?.[2]).toBe(
      DIRECT_RESPONSE.sipUri,
    );
  });

  it("preserves legacy retry state when the phone REFER fails", async () => {
    transferSipParticipantMock.mockRejectedValueOnce(new Error("rejected"));
    const state = createState();

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "SIP transfer failed.",
    );

    expect(state.runtime.transferred).toBe(false);
  });
});
