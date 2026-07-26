import {
  AgentSession,
  initializeLogger,
  isToolset,
  type ToolContextEntry,
} from "@livekit/agents";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createVoiceAgent } from "../agent.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_DEMO_TRANSFER_NUMBER,
  DEV_OFFICE_PHONE,
  HOLLYWOOD_OFFICE_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  SPRING_HILL_813_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
  type OfficeKey,
  type OfficeSchedulingPolicy,
} from "../customers/abita/profile.js";
import {
  buildInsuranceToolResponse,
  matchInsurancePlanForOffice,
  type InsuranceCoverageType,
  type InsuranceToolResponse,
} from "../insurance-rules.js";
import { transferCallerToOffice } from "../tools/handoff.js";
import {
  medicalSchedulingUnavailable,
  routineVisionSchedulingUnavailable,
} from "../scheduling/routing.js";
import {
  createRimeVoiceLanguageState,
  getRimeTtsLanguageOptions,
  getRimeTtsOptions,
} from "../tts-config.js";
import { createTestCallState } from "./support/call-state.js";

const transferSipParticipantMock = vi.hoisted(() => vi.fn());

vi.mock("livekit-server-sdk", () => ({
  SipClient: vi.fn(function SipClientMock() {
    return {
      transferSipParticipant: transferSipParticipantMock,
    };
  }),
}));

function toolNames(entries: readonly ToolContextEntry[]): string[] {
  return entries.flatMap((entry) =>
    isToolset(entry) ? toolNames(entry.tools) : [entry.id],
  );
}

type OfficeBehavior = {
  amdOfficePhone: string;
  displayName: string;
  englishSpeaker: string;
  greeting: string;
  handoff: {
    mode: "call-center" | "phone";
    target: string;
  };
  insurance: {
    medical: InsuranceBehavior;
    routineVision: InsuranceBehavior;
  };
  key: OfficeKey;
  knowledgeSource: string;
  middlewareBaseUrl: string;
  promptMarker: string;
  scheduling: {
    medical: OfficeSchedulingPolicy;
    routineVision: OfficeSchedulingPolicy;
  };
  staffTaskCapture: boolean;
  trunks: readonly string[];
};

type InsuranceBehavior = {
  query: string;
  response: InsuranceToolResponse;
};

const PRODUCTION_MIDDLEWARE =
  "https://advancedmd-token-management-production.up.railway.app";
const DIRECT_HANDOFF_RESPONSE = {
  type: "DIRECT",
  handoffId: "handoff-test",
  sipUri: `sip:one-time-route~ah1~${"a".repeat(43)}@handoff.example`,
  expiresAt: "2099-07-13T12:00:30.000Z",
};
const COMMON_TOOL_NAMES = [
  "add_patient",
  "book_appointment",
  "cancel_appointment",
  "check_insurance",
  "end_call",
  "get_availability",
  "reschedule_appointment",
  "resolve_patient",
  "transfer_call",
  "update_insurance",
] as const;

const officeBehaviors: OfficeBehavior[] = [
  {
    amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
    displayName: "Abita Eye Group",
    englishSpeaker: "wawona",
    greeting: "Hey this is Maya at Abeeta Eye Group. How are you doing today?",
    handoff: {
      mode: "call-center",
      target: DIRECT_HANDOFF_RESPONSE.sipUri,
    },
    insurance: {
      routineVision: {
        query: "VSP",
        response: { status: "accepted", plan: "VSP" },
      },
      medical: {
        query: "Ambetter Premier",
        response: { status: "accepted", plan: "Ambetter Premier" },
      },
    },
    key: "spring-hill",
    knowledgeSource: "KNOWLEDGE_SPRINGHILL.md",
    middlewareBaseUrl: PRODUCTION_MIDDLEWARE,
    promptMarker: "an ophthalmology clinic",
    scheduling: {
      medical: { supported: true },
      routineVision: { supported: true },
    },
    staffTaskCapture: true,
    trunks: [SPRING_HILL_OFFICE_PHONE, SPRING_HILL_813_TRUNK_PHONE],
  },
  {
    amdOfficePhone: CRYSTAL_RIVER_OFFICE_PHONE,
    displayName: "Eye Radiance",
    englishSpeaker: "wawona",
    greeting:
      "Hey this is Maya at Eye Radiance, powered by Abeeta Eye Group. How are you doing today?",
    handoff: { mode: "phone", target: "tel:+13527941244" },
    insurance: {
      medical: {
        query: "Cigna Open Access",
        response: { status: "accepted", plan: "Cigna Open Access" },
      },
      routineVision: {
        query: "VSP",
        response: { status: "not_accepted", plan: "VSP" },
      },
    },
    key: "crystal-river",
    knowledgeSource: "KNOWLEDGE_EYERADIANCE.md",
    middlewareBaseUrl: PRODUCTION_MIDDLEWARE,
    promptMarker: "an ophthalmology clinic",
    scheduling: {
      medical: { supported: true },
      routineVision: {
        supported: false,
        message:
          "Eye Radiance handles medical eye care, including cataract evaluations, but does not schedule routine eye exams, glasses prescriptions, or contact lens prescriptions. Do not schedule routine vision through this office.",
      },
    },
    staffTaskCapture: true,
    trunks: [CRYSTAL_RIVER_OFFICE_PHONE],
  },
  {
    amdOfficePhone: HOLLYWOOD_OFFICE_PHONE,
    displayName: "Abita Eye Group Hollywood",
    englishSpeaker: "wawona",
    greeting: "Hey this is Maya at Abeeta Eye Group. How are you doing today?",
    handoff: {
      mode: "call-center",
      target: DIRECT_HANDOFF_RESPONSE.sipUri,
    },
    insurance: {
      medical: {
        query: "Aetna EPO North Broward",
        response: { status: "accepted", plan: "Aetna EPO North Broward" },
      },
      routineVision: {
        query: "VSP",
        response: { status: "accepted", plan: "VSP" },
      },
    },
    key: "hollywood",
    knowledgeSource: "KNOWLEDGE_HOLLYWOOD.md",
    middlewareBaseUrl: PRODUCTION_MIDDLEWARE,
    promptMarker: "an ophthalmology clinic",
    scheduling: {
      medical: { supported: true },
      routineVision: { supported: true },
    },
    staffTaskCapture: true,
    trunks: [HOLLYWOOD_OFFICE_PHONE],
  },
  {
    amdOfficePhone: SWEETWATER_OFFICE_PHONE,
    displayName: "Abita Eye Group Sweetwater",
    englishSpeaker: "luz",
    greeting: "Hey this is Maya at Abeeta Eye Group. How are you doing today?",
    handoff: {
      mode: "call-center",
      target: DIRECT_HANDOFF_RESPONSE.sipUri,
    },
    insurance: {
      medical: {
        query: "Aetna EPO North Broward",
        response: { status: "accepted", plan: "Aetna EPO North Broward" },
      },
      routineVision: {
        query: "VSP",
        response: { status: "accepted", plan: "VSP" },
      },
    },
    key: "sweetwater",
    knowledgeSource: "KNOWLEDGE_SWEETWATER.md",
    middlewareBaseUrl: PRODUCTION_MIDDLEWARE,
    promptMarker: "an ophthalmology clinic",
    scheduling: {
      medical: { supported: true },
      routineVision: { supported: true },
    },
    staffTaskCapture: true,
    trunks: SWEETWATER_TRUNK_PHONES,
  },
  {
    amdOfficePhone: NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
    displayName: "North Miami Beach Optical",
    englishSpeaker: "luz",
    greeting: "Hey this is Maya at Abeeta Eye Group. How are you doing today?",
    handoff: {
      mode: "call-center",
      target: DIRECT_HANDOFF_RESPONSE.sipUri,
    },
    insurance: {
      medical: {
        query: "Aetna",
        response: { status: "not_accepted", plan: "Aetna" },
      },
      routineVision: {
        query: "VSP",
        response: { status: "accepted", plan: "VSP" },
      },
    },
    key: "north-miami-beach-optical",
    knowledgeSource: "KNOWLEDGE_NORTH_MIAMI_BEACH_OPTICAL.md",
    middlewareBaseUrl: PRODUCTION_MIDDLEWARE,
    promptMarker: "an ophthalmology clinic",
    scheduling: {
      medical: {
        supported: false,
        message:
          "North Miami Beach Optical supports routine vision and optical scheduling only. Do not schedule medical eye care through this office.",
      },
      routineVision: { supported: true },
    },
    staffTaskCapture: true,
    trunks: [NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE],
  },
  {
    amdOfficePhone: DEV_OFFICE_PHONE,
    displayName: "Harborleaf Dermatology & Aesthetics",
    englishSpeaker: "wawona",
    greeting:
      "Hi, this is Julia, the virtual assistant at Harborleaf Dermatology and Aesthetics. How can I help you today?",
    handoff: {
      mode: "phone",
      target: `tel:${DEV_DEMO_TRANSFER_NUMBER}`,
    },
    insurance: {
      medical: {
        query: "Ambetter Premier",
        response: { status: "accepted", plan: "Ambetter Premier" },
      },
      routineVision: {
        query: "VSP",
        response: { status: "not_accepted", plan: "VSP" },
      },
    },
    key: "dev",
    knowledgeSource: "KNOWLEDGE_DERM_DEMO.md",
    middlewareBaseUrl: "https://advancedmd-token-management-dev.up.railway.app",
    promptMarker: "a fictional dermatology practice",
    scheduling: {
      medical: { supported: true },
      routineVision: {
        supported: false,
        message:
          "Harborleaf Dermatology & Aesthetics does not schedule routine eye exams, glasses prescriptions, or contact lens prescriptions. Do not schedule routine vision through this office.",
      },
    },
    staffTaskCapture: false,
    trunks: [DEV_OFFICE_PHONE],
  },
];

function insuranceResponse(
  officeKey: OfficeKey,
  coverageType: InsuranceCoverageType,
  behavior: InsuranceBehavior,
): InsuranceToolResponse {
  return buildInsuranceToolResponse(
    matchInsurancePlanForOffice(officeKey, behavior.query, coverageType),
  );
}

async function spokenGreeting(
  agent: ReturnType<typeof createVoiceAgent>["agent"],
): Promise<unknown[]> {
  const session = new AgentSession({ vad: null });
  const say = vi.spyOn(session, "say").mockReturnValue(undefined as never);

  try {
    await session.start({ agent, record: false });
  } finally {
    await session.close();
  }

  return say.mock.calls.map(([text]) => text);
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

async function selectedHandoff(trunkPhone: string, officeKey: OfficeKey) {
  const fetchMock = vi.fn(async () => jsonResponse(DIRECT_HANDOFF_RESPONSE));
  vi.stubGlobal("fetch", fetchMock);
  const state = createTestCallState({ officeKey, trunkPhone });
  const result = await transferCallerToOffice(state);

  return {
    mode: fetchMock.mock.calls.length > 0 ? "call-center" : "phone",
    officeKey: result.handoffOfficeKey,
    target: result.handoffTarget,
  };
}

function availabilityOfficeSelection(
  trunkPhone: string,
  requestedOffice?: "hollywood" | "sweetwater",
) {
  const selection = createVoiceAgent(
    "no_match",
    trunkPhone,
  ).office.availabilityOfficeFor(requestedOffice);

  return selection.status === "selected"
    ? { status: selection.status, officeKey: selection.office.key }
    : selection;
}

describe("Voice Agent office profile", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  beforeEach(() => {
    vi.stubEnv("ACUITY_HANDOFF_URL", "https://handoff.example/internal");
    vi.stubEnv("ACUITY_HANDOFF_SECRET", "test-secret");
    vi.stubEnv("DEV_HANDOFF_TARGET", "");
    transferSipParticipantMock.mockReset();
    transferSipParticipantMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  for (const expected of officeBehaviors) {
    for (const [trunkIndex, trunkPhone] of expected.trunks.entries()) {
      it(`creates ${expected.key} behavior for configured trunk ${trunkIndex + 1}`, async () => {
        const voiceAgent = createVoiceAgent("no_match", trunkPhone);
        const { office } = voiceAgent;
        const instructions = String(voiceAgent.agent.instructions);
        const tools = toolNames(voiceAgent.agent.toolCtx.tools);
        const medicalState = createTestCallState({
          amdOfficePhone: office.amdOfficePhone,
          officeKey: office.key,
          trunkPhone,
        });
        medicalState.workflow.current = {
          appointmentLane: "medical_md",
          intent: "schedule",
        };
        const routineVisionState = createTestCallState({
          amdOfficePhone: office.amdOfficePhone,
          officeKey: office.key,
          trunkPhone,
        });
        const voiceLanguageState = createTestCallState({
          voiceLanguage: createRimeVoiceLanguageState({
            language: "en",
            options: getRimeTtsLanguageOptions({
              language: "en",
              trunkPhone,
            }),
          }),
        }).runtime.voiceLanguage;
        routineVisionState.workflow.current = {
          appointmentLane: "routine_od",
          intent: "schedule",
        };

        expect({
          amdOfficePhone: office.amdOfficePhone,
          displayName: office.displayName,
          greeting: await spokenGreeting(voiceAgent.agent),
          handoff: await selectedHandoff(trunkPhone, office.key),
          insurance: {
            medical: insuranceResponse(
              office.key,
              "medical",
              expected.insurance.medical,
            ),
            routineVision: insuranceResponse(
              office.key,
              "routine_vision",
              expected.insurance.routineVision,
            ),
          },
          key: office.key,
          knowledgeSource: office.knowledgeSource,
          middlewareBaseUrl: office.middlewareBaseUrl(PRODUCTION_MIDDLEWARE),
          promptHasConfiguredRole: instructions.includes(expected.promptMarker),
          scheduling: {
            medical: office.schedulingFor("medical"),
            routineVision: office.schedulingFor("routine_vision"),
          },
          schedulingBehavior: {
            medical: medicalSchedulingUnavailable(medicalState),
            routineVision:
              routineVisionSchedulingUnavailable(routineVisionState),
          },
          speech: {
            english: getRimeTtsOptions({
              language: "en",
              trunkPhone,
            }),
            spanish: getRimeTtsOptions({
              language: "es",
              trunkPhone,
            }),
          },
          staffTaskCapture: tools.includes("create_staff_task"),
          tools: tools.sort(),
          voiceLanguageState,
        }).toEqual({
          amdOfficePhone: expected.amdOfficePhone,
          displayName: expected.displayName,
          greeting: [expected.greeting],
          handoff: {
            mode: expected.handoff.mode,
            officeKey: expected.key,
            target: expected.handoff.target,
          },
          insurance: {
            medical: expected.insurance.medical.response,
            routineVision: expected.insurance.routineVision.response,
          },
          key: expected.key,
          knowledgeSource: expected.knowledgeSource,
          middlewareBaseUrl: expected.middlewareBaseUrl,
          promptHasConfiguredRole: true,
          scheduling: expected.scheduling,
          schedulingBehavior: {
            medical: expected.scheduling.medical.supported
              ? null
              : expected.scheduling.medical.message,
            routineVision: expected.scheduling.routineVision.supported
              ? null
              : expected.scheduling.routineVision.message,
          },
          speech: {
            english: {
              baseURL: "wss://users-east-ws.rime.ai",
              lang: "eng",
              modelId: "coda",
              samplingRate: 16000,
              segment: "never",
              speaker: expected.englishSpeaker,
              useWebsocket: true,
            },
            spanish: {
              baseURL: "wss://users-east-ws.rime.ai",
              lang: "spa",
              modelId: "coda",
              samplingRate: 16000,
              segment: "never",
              speaker: "luz",
              useWebsocket: true,
            },
          },
          staffTaskCapture: expected.staffTaskCapture,
          tools: [
            ...COMMON_TOOL_NAMES,
            ...(expected.staffTaskCapture ? ["create_staff_task"] : []),
          ].sort(),
          voiceLanguageState: {
            current: "en",
            speaker: expected.englishSpeaker,
            ttsLanguage: "eng",
            ttsProvider: "rime",
          },
        });
      });
    }
  }

  it("rejects unsupported and malformed trunks at Voice Agent creation", () => {
    const errors = ["+19999999999", "not-a-phone-number", ""].map(
      (trunkPhone) => {
        try {
          createVoiceAgent("no_match", trunkPhone);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    );

    expect(errors).toEqual([
      "Unsupported trunk phone number: +19999999999",
      "Unsupported trunk phone number: not-a-phone-number",
      "Unsupported trunk phone number: (empty)",
    ]);
  });

  it("owns Hollywood and Sweetwater availability office selection", () => {
    expect({
      hollywoodMissing: availabilityOfficeSelection(HOLLYWOOD_OFFICE_PHONE),
      hollywoodSelected: availabilityOfficeSelection(
        HOLLYWOOD_OFFICE_PHONE,
        "hollywood",
      ),
      sweetwaterSelected: availabilityOfficeSelection(
        SWEETWATER_OFFICE_PHONE,
        "sweetwater",
      ),
    }).toEqual({
      hollywoodMissing: {
        status: "blocked",
        message:
          "Ask whether the caller wants the Hollywood or Sweetwater office, then check availability again with that office.",
      },
      hollywoodSelected: { status: "selected", officeKey: "hollywood" },
      sweetwaterSelected: { status: "selected", officeKey: "sweetwater" },
    });
  });

  it("keeps availability office selection unavailable elsewhere", () => {
    expect({
      current: availabilityOfficeSelection(SPRING_HILL_OFFICE_PHONE),
      rejected: availabilityOfficeSelection(
        SPRING_HILL_OFFICE_PHONE,
        "hollywood",
      ),
    }).toEqual({
      current: { status: "current" },
      rejected: {
        status: "blocked",
        message:
          "Abita Eye Group calls cannot search Hollywood or Sweetwater. Check availability again without office.",
      },
    });
  });
});
