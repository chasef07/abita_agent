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

import { transferIsAccepted, transferStatus } from "../state/call-lifecycle.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEMO_TRANSFER_NUMBER,
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
  NEW_TAMPA_DEMO_TRUNK_PHONE,
  OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
  getOfficeProfileByPhone,
  getProductOfficeKeyByPhone,
  HOLLYWOOD_OFFICE_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SPRING_HILL_813_TRUNK_PHONE,
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_OPTICAL_TRUNK_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customers/abita/profile.js";
import {
  HandoffConflictError,
  HandoffError,
  transferCallerToOffice,
} from "../tools/handoff.js";
import {
  confirmedActivePatient,
  createTestCallState,
} from "./support/call-state.js";

const DIRECT_TOKEN = "a".repeat(43);
const DIRECT_RESPONSE = {
  type: "DIRECT",
  handoffId: "handoff-test",
  sipUri: `sip:one-time-route~ah1~${DIRECT_TOKEN}@handoff.example`,
  expiresAt: "2099-07-13T12:00:30.000Z",
};
const PRODUCT_RESPONSE = {
  id: "930926a1-986e-4a9c-8f49-2adbc90def9d",
  sipDestination: "sip:acuity-handoff@acuity-product.sip.telnyx.com",
  expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
};
const PRODUCT_PRACTICE_ID = "861dd557-eb44-4754-bbd6-40d58a624419";
const DEMO_PRODUCT_PRACTICE_ID = "f84079ac-df10-491b-8196-9c670c1bc78f";

function createState() {
  return createTestCallState();
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    body: null,
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function configureProductHandoff() {
  vi.stubEnv(
    "ACUITY_PRODUCT_HANDOFF_URL",
    "https://acuity-product.example/v1/handoffs",
  );
  vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "production-secret");
  vi.stubEnv("ACUITY_PRODUCT_SERVICE_SECRET", "legacy-wrong-secret");
  vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_PRACTICE_ID", PRODUCT_PRACTICE_ID);
}

function configureDemoProductHandoff() {
  vi.stubEnv(
    "ACUITY_PRODUCT_HANDOFF_URL",
    "https://acuity-product.example/v1/handoffs",
  );
  vi.stubEnv("ACUITY_DEMO_PRODUCT_SERVICE_SECRET", "demo-secret");
  vi.stubEnv("ACUITY_DEMO_PRODUCT_PRACTICE_ID", DEMO_PRODUCT_PRACTICE_ID);
}

describe("call-center handoff", () => {
  beforeEach(() => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "");
    vi.stubEnv("ACUITY_DEMO_PRODUCT_PRACTICE_ID", "");
    vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_PRACTICE_ID", "");
    vi.stubEnv("ACUITY_PRODUCT_HANDOFF_URL", "");
    vi.stubEnv("ACUITY_DEMO_PRODUCT_SERVICE_SECRET", "");
    vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "");
    vi.stubEnv("ACUITY_PRODUCT_SERVICE_SECRET", "");
    vi.stubEnv("DEV_HANDOFF_TARGET", "");
    transferSipParticipantMock.mockReset();
    transferSipParticipantMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fails closed when direct handoff is not configured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity handoff API configuration is incomplete.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
    expect(transferStatus(state)).toBe("idle");
    expect(transferIsAccepted(state)).toBe(false);
  });

  it("routes Crystal River directly to its configured phone target", async () => {
    vi.resetModules();
    const { transferCallerToOffice } = await import("../tools/handoff.js");
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    configureProductHandoff();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    state.runtime.trunkPhone = CRYSTAL_RIVER_OFFICE_PHONE;
    const target = "tel:+13527941244";

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
    expect(SipClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(SipClient).mock.calls.at(-1)?.[3]).toBeUndefined();
  });

  it("routes the demo directly to the configured demo cellphone", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    state.runtime.trunkPhone = RHEUMATOLOGY_DEMO_TRUNK_PHONE;

    const result = await transferCallerToOffice(state);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      handoffOfficeKey: "rheumatology-demo",
      handoffTarget: `tel:${DEMO_TRANSFER_NUMBER}`,
    });
    expect(transferSipParticipantMock).toHaveBeenCalledWith(
      "test-room",
      "sip-caller",
      `tel:${DEMO_TRANSFER_NUMBER}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Acuity-Handoff-Target": `tel:${DEMO_TRANSFER_NUMBER}`,
          "X-Acuity-Office-Key": "rheumatology-demo",
        }),
        playDialtone: true,
        ringingTimeout: 20,
      }),
    );
  });

  it.each([
    ["spring-hill", SPRING_HILL_OFFICE_PHONE],
    ["hollywood", HOLLYWOOD_OFFICE_PHONE],
    ["sweetwater", SWEETWATER_OFFICE_PHONE],
    ["north-miami-beach-optical", NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE],
  ] as const)(
    "routes the %s office through the Acuity Product handoff contract",
    async (officeKey, trunkPhone) => {
      vi.stubEnv("ACUITY_HANDOFF_URL", "https://legacy.example/internal");
      vi.stubEnv("ACUITY_HANDOFF_SECRET", "legacy-secret");
      configureProductHandoff();
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse(PRODUCT_RESPONSE, 201),
      );
      vi.stubGlobal("fetch", fetchMock);
      const state = createTestCallState({
        activePatient: confirmedActivePatient({ name: "Maria Alvarez" }),
      });
      state.runtime.trunkPhone = trunkPhone;
      const contact = {
        phone: "+17275551212",
        phoneSource: "livekit.sip.callerPhoneNumber",
        displayName: "Maria Alvarez",
        nameSource: "abita.patient-context",
      };
      const identity = {
        practiceId: PRODUCT_PRACTICE_ID,
        officeKey,
        sourceCallId: "call-test",
      };
      const payload = {
        ...identity,
        contact,
        idempotencyKey: createHash("sha256")
          .update(JSON.stringify(identity))
          .digest("hex"),
      };

      const result = await transferCallerToOffice(state);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://acuity-product.example/v1/handoffs",
        expect.objectContaining({
          body: JSON.stringify(payload),
          headers: {
            Authorization: "Bearer production-secret",
            "Content-Type": "application/json",
          },
          method: "POST",
        }),
      );
      expect(result).toEqual({
        handoffOfficeKey: officeKey,
        handoffTarget: PRODUCT_RESPONSE.sipDestination,
      });
      expect(transferSipParticipantMock).toHaveBeenCalledWith(
        "test-room",
        "sip-caller",
        PRODUCT_RESPONSE.sipDestination,
        {
          playDialtone: true,
          ringingTimeout: 20,
        },
      );
    },
  );

  it.each([
    [SPRING_HILL_OFFICE_PHONE, "spring-hill"],
    [SPRING_HILL_813_TRUNK_PHONE, "spring-hill"],
    [CRYSTAL_RIVER_OFFICE_PHONE, "crystal-river"],
    [HOLLYWOOD_OFFICE_PHONE, "hollywood"],
    ...SWEETWATER_TRUNK_PHONES.map(
      (phone) =>
        [
          phone,
          phone === SWEETWATER_OPTICAL_TRUNK_PHONE
            ? "sweetwater-optical"
            : "sweetwater",
        ] as const,
    ),
    [NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE, "north-miami-beach-optical"],
    [RHEUMATOLOGY_DEMO_TRUNK_PHONE, "rheumatology-demo"],
    [OPHTHALMOLOGY_DEMO_TRUNK_PHONE, "ophthalmology-demo"],
    [NEW_TAMPA_DEMO_TRUNK_PHONE, "new-tampa-demo"],
  ] as const)("maps handoff trunk %s to %s", (trunkPhone, officeKey) => {
    expect(getProductOfficeKeyByPhone(trunkPhone)).toBe(officeKey);
  });

  it("routes the Sweetwater optical trunk without changing its office profile", async () => {
    configureProductHandoff();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(PRODUCT_RESPONSE, 201),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    state.runtime.trunkPhone = SWEETWATER_OPTICAL_TRUNK_PHONE;

    const result = await transferCallerToOffice(state);
    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);

    expect(getOfficeProfileByPhone(SWEETWATER_OPTICAL_TRUNK_PHONE).key).toBe(
      "sweetwater",
    );
    expect(request.officeKey).toBe("sweetwater-optical");
    expect(result.handoffOfficeKey).toBe("sweetwater");
    expect(transferSipParticipantMock).toHaveBeenCalledWith(
      "test-room",
      "sip-caller",
      PRODUCT_RESPONSE.sipDestination,
      { playDialtone: true, ringingTimeout: 20 },
    );
  });

  it("routes the demo through Product with the Demo tenant credential", async () => {
    configureDemoProductHandoff();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(PRODUCT_RESPONSE, 201),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    state.runtime.trunkPhone = RHEUMATOLOGY_DEMO_TRUNK_PHONE;

    await expect(transferCallerToOffice(state)).resolves.toEqual({
      handoffOfficeKey: "rheumatology-demo",
      handoffTarget: PRODUCT_RESPONSE.sipDestination,
    });
    const request = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(request).toMatchObject({
      officeKey: "rheumatology-demo",
      practiceId: DEMO_PRODUCT_PRACTICE_ID,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://acuity-product.example/v1/handoffs",
      expect.objectContaining({
        body: expect.stringContaining(
          `"practiceId":"${DEMO_PRODUCT_PRACTICE_ID}"`,
        ),
        headers: {
          Authorization: "Bearer demo-secret",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it.each([
    [OPHTHALMOLOGY_DEMO_TRUNK_PHONE, "ophthalmology-demo"],
    [NEW_TAMPA_DEMO_TRUNK_PHONE, "new-tampa-demo"],
  ] as const)(
    "routes the %s demo profile through its matching Product office",
    async (trunkPhone, profileOfficeKey) => {
      configureDemoProductHandoff();
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse(PRODUCT_RESPONSE, 201),
      );
      vi.stubGlobal("fetch", fetchMock);
      const state = createState();
      state.runtime.trunkPhone = trunkPhone;

      await expect(transferCallerToOffice(state)).resolves.toEqual({
        handoffOfficeKey: profileOfficeKey,
        handoffTarget: PRODUCT_RESPONSE.sipDestination,
      });
      const request = JSON.parse(
        fetchMock.mock.calls[0]?.[1]?.body as string,
      ) as Record<string, unknown>;
      expect(request).toMatchObject({
        officeKey: profileOfficeKey,
        practiceId: DEMO_PRODUCT_PRACTICE_ID,
      });
    },
  );

  it("fails closed when the Demo Product handoff configuration is incomplete", async () => {
    vi.stubEnv(
      "ACUITY_PRODUCT_HANDOFF_URL",
      "https://acuity-product.example/v1/handoffs",
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    state.runtime.trunkPhone = RHEUMATOLOGY_DEMO_TRUNK_PHONE;

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity Product handoff configuration is incomplete.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when any Product handoff route is present but incomplete", async () => {
    vi.stubEnv(
      "ACUITY_PRODUCT_HANDOFF_URL",
      "https://acuity-product.example/v1/handoffs",
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    state.runtime.trunkPhone = HOLLYWOOD_OFFICE_PHONE;

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity Product handoff configuration is incomplete.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("rejects an unstable Product source call identity", async () => {
    configureProductHandoff();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    state.runtime.trunkPhone = HOLLYWOOD_OFFICE_PHONE;
    state.runtime.callId = "unknown";

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity Product handoff requires a stable source call ID.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an insecure Product handoff URL before sending data", async () => {
    configureProductHandoff();
    vi.stubEnv(
      "ACUITY_PRODUCT_HANDOFF_URL",
      "http://acuity-product.example/v1/handoffs",
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    state.runtime.trunkPhone = HOLLYWOOD_OFFICE_PHONE;

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity handoff API URL must use HTTPS.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the Product handoff request has no definitive response", async () => {
    configureProductHandoff();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("request failed");
      }),
    );
    const state = createState();
    state.runtime.trunkPhone = HOLLYWOOD_OFFICE_PHONE;

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity Product handoff API request failed.",
    );
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("reuses the exact Product request after an ambiguous API response", async () => {
    configureProductHandoff();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(jsonResponse(PRODUCT_RESPONSE, 201));
    vi.stubGlobal("fetch", fetchMock);
    const state = createTestCallState({
      activePatient: confirmedActivePatient({
        patientId: "patient-maria",
        name: "Maria Alvarez",
      }),
    });
    state.runtime.trunkPhone = HOLLYWOOD_OFFICE_PHONE;

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity Product handoff API request failed.",
    );
    state.identity.activePatient!.name = "Changed after first attempt";

    await expect(transferCallerToOffice(state)).resolves.toEqual({
      handoffOfficeKey: "hollywood",
      handoffTarget: PRODUCT_RESPONSE.sipDestination,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      fetchMock.mock.calls[0]?.[1]?.body,
    );
  });

  it("fails closed when the Product handoff conflicts", async () => {
    configureProductHandoff();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 409)),
    );
    const state = createState();
    state.runtime.trunkPhone = HOLLYWOOD_OFFICE_PHONE;

    const failure = transferCallerToOffice(state);
    await expect(failure).rejects.toThrow(
      "Acuity Product handoff conflicts with an existing transfer.",
    );
    await expect(failure).rejects.toBeInstanceOf(HandoffConflictError);
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("fails closed when the Product handoff endpoint is unavailable", async () => {
    configureProductHandoff();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 503)),
    );
    const state = createState();
    state.runtime.trunkPhone = HOLLYWOOD_OFFICE_PHONE;

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity Product handoff API returned 503.",
    );
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("keeps a permanent handoff rejection as an internal error", async () => {
    configureProductHandoff();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 400)),
    );
    const state = createState();
    state.runtime.trunkPhone = HOLLYWOOD_OFFICE_PHONE;

    const failure = transferCallerToOffice(state);
    await expect(failure).rejects.toThrow(
      "Acuity Product handoff API returned 400.",
    );
    await expect(failure).rejects.not.toBeInstanceOf(HandoffError);
    await expect(failure).rejects.not.toBeInstanceOf(HandoffConflictError);
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("fails closed when the Product handoff response is not JSON", async () => {
    configureProductHandoff();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => {
          throw new Error("invalid JSON");
        },
      })),
    );
    const state = createState();
    state.runtime.trunkPhone = HOLLYWOOD_OFFICE_PHONE;

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity Product handoff API returned an invalid response.",
    );
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "invalid id",
      response: { ...PRODUCT_RESPONSE, id: "not-a-uuid" },
    },
    {
      name: "unexpected SIP user",
      response: {
        ...PRODUCT_RESPONSE,
        sipDestination: "sip:patient-name@acuity-product.sip.telnyx.com",
      },
    },
    {
      name: "SIP credentials",
      response: {
        ...PRODUCT_RESPONSE,
        sipDestination:
          "sip:acuity-handoff:password@acuity-product.sip.telnyx.com",
      },
    },
    {
      name: "expired destination",
      response: {
        ...PRODUCT_RESPONSE,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    },
    {
      name: "long-lived destination",
      response: {
        ...PRODUCT_RESPONSE,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    },
  ])("rejects a Product response with $name", async ({ response }) => {
    configureProductHandoff();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(response, 201)),
    );
    const state = createState();
    state.runtime.trunkPhone = HOLLYWOOD_OFFICE_PHONE;

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "Acuity Product handoff API returned an invalid response.",
    );
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("reserves and transfers once to the direct SIP target", async () => {
    vi.resetModules();
    const { transferCallerToOffice } = await import("../tools/handoff.js");
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(DIRECT_RESPONSE),
    );
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
    expect(SipClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(SipClient).mock.calls.at(-1)?.[3]).toEqual({
      failover: false,
    });
    expect(transferStatus(state)).toBe("accepted");
    expect(transferIsAccepted(state)).toBe(true);
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

  it("fails closed when direct handoff resolution fails", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 503)),
    );

    await expect(transferCallerToOffice(createState())).rejects.toThrow(
      "Acuity handoff API returned 503.",
    );
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("fails closed on an existing-transfer conflict", async () => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 409)),
    );

    const failure = transferCallerToOffice(createState());
    await expect(failure).rejects.toThrow(
      "Acuity handoff conflicts with an existing transfer.",
    );
    await expect(failure).rejects.toBeInstanceOf(HandoffConflictError);
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
    const fetchMock = vi.fn<typeof fetch>();
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(DIRECT_RESPONSE)),
    );
    transferSipParticipantMock.mockRejectedValueOnce(new Error("timeout"));

    const state = createState();
    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "SIP transfer outcome is unknown.",
    );
    expect(transferStatus(state)).toBe("ambiguous");
    expect(transferIsAccepted(state)).toBe(false);
    expect(transferSipParticipantMock).toHaveBeenCalledTimes(1);
    expect(transferSipParticipantMock.mock.calls[0]?.[2]).toBe(
      DIRECT_RESPONSE.sipUri,
    );
  });

  it("does not make a phone REFER retryable after an ambiguous failure", async () => {
    transferSipParticipantMock.mockRejectedValueOnce(new Error("rejected"));
    const state = createState();
    state.runtime.trunkPhone = CRYSTAL_RIVER_OFFICE_PHONE;

    await expect(transferCallerToOffice(state)).rejects.toThrow(
      "SIP transfer outcome is unknown.",
    );

    expect(transferStatus(state)).toBe("ambiguous");
    expect(transferIsAccepted(state)).toBe(false);
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
      expect(transferStatus(state)).toBe("pending");
    });
    expect(transferIsAccepted(state)).toBe(false);

    accept();
    await expect(transfer).resolves.toEqual({
      handoffOfficeKey: "spring-hill",
      handoffTarget: DIRECT_RESPONSE.sipUri,
    });
    expect(transferStatus(state)).toBe("accepted");
  });
});
