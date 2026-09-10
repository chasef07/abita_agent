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
  DEMO_TRANSFER_NUMBER,
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
  HOLLYWOOD_OFFICE_PHONE,
  NEW_TAMPA_DEMO_TRUNK_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
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
import { getRimeTtsOptions } from "../tts-config.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { createTestCallState } from "./support/call-state.js";

const middleware = new InMemoryOwnedMiddleware();

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
  promptMarker: string;
  scheduling: {
    medical: OfficeSchedulingPolicy;
    routineVision: OfficeSchedulingPolicy;
  };
  staffTaskEnabled: boolean;
  trunks: readonly string[];
};

type InsuranceBehavior = {
  query: string;
  response: InsuranceToolResponse;
};

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
  "list_available_appointments",
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
    greeting: "Hi, this is Maya at Abeeta Eye Group. How can I help?",
    handoff: {
      mode: "call-center",
      target: DIRECT_HANDOFF_RESPONSE.sipUri,
    },
    insurance: {
      routineVision: {
        query: "VSP",
        response: "Yes, we take VSP.",
      },
      medical: {
        query: "Ambetter Premier",
        response: "Yes, we take Ambetter Premier.",
      },
    },
    key: "spring-hill",
    knowledgeSource: "KNOWLEDGE_SPRINGHILL.md",
    promptMarker: "an ophthalmology clinic",
    scheduling: {
      medical: { supported: true },
      routineVision: { supported: true },
    },
    staffTaskEnabled: true,
    trunks: [SPRING_HILL_OFFICE_PHONE, SPRING_HILL_813_TRUNK_PHONE],
  },
  {
    amdOfficePhone: CRYSTAL_RIVER_OFFICE_PHONE,
    displayName: "Eye Radiance",
    englishSpeaker: "wawona",
    greeting:
      "Hi, this is Maya at Eye Radiance, powered by Abeeta Eye Group. How can I help?",
    handoff: { mode: "phone", target: "tel:+13527941244" },
    insurance: {
      medical: {
        query: "Cigna Open Access",
        response: "Yes, we take Cigna Open Access.",
      },
      routineVision: {
        query: "VSP",
        response: "No, we don't accept VSP.",
      },
    },
    key: "crystal-river",
    knowledgeSource: "KNOWLEDGE_EYERADIANCE.md",
    promptMarker: "an ophthalmology clinic",
    scheduling: {
      medical: { supported: true },
      routineVision: {
        supported: false,
        message:
          "Eye Radiance handles medical eye care, including cataract evaluations. Route routine eye exams, glasses prescriptions, and contact lens prescriptions through a routine-vision office.",
      },
    },
    staffTaskEnabled: false,
    trunks: [CRYSTAL_RIVER_OFFICE_PHONE],
  },
  {
    amdOfficePhone: HOLLYWOOD_OFFICE_PHONE,
    displayName: "Abita Eye Group Hollywood",
    englishSpeaker: "luz",
    greeting: "Hi, this is Maya at Abeeta Eye Group. How can I help?",
    handoff: {
      mode: "call-center",
      target: DIRECT_HANDOFF_RESPONSE.sipUri,
    },
    insurance: {
      medical: {
        query: "Aetna EPO North Broward",
        response: "Yes, we take Aetna EPO North Broward.",
      },
      routineVision: {
        query: "VSP",
        response: "Yes, we take VSP.",
      },
    },
    key: "hollywood",
    knowledgeSource: "KNOWLEDGE_HOLLYWOOD.md",
    promptMarker: "an ophthalmology clinic",
    scheduling: {
      medical: { supported: true },
      routineVision: { supported: true },
    },
    staffTaskEnabled: true,
    trunks: [HOLLYWOOD_OFFICE_PHONE],
  },
  {
    amdOfficePhone: SWEETWATER_OFFICE_PHONE,
    displayName: "Abita Eye Group Sweetwater",
    englishSpeaker: "luz",
    greeting: "Hi, this is Maya at Abeeta Eye Group. How can I help?",
    handoff: {
      mode: "call-center",
      target: DIRECT_HANDOFF_RESPONSE.sipUri,
    },
    insurance: {
      medical: {
        query: "Aetna EPO North Broward",
        response: "Yes, we take Aetna EPO North Broward.",
      },
      routineVision: {
        query: "VSP",
        response: "Yes, we take VSP.",
      },
    },
    key: "sweetwater",
    knowledgeSource: "KNOWLEDGE_SWEETWATER.md",
    promptMarker: "an ophthalmology clinic",
    scheduling: {
      medical: { supported: true },
      routineVision: { supported: true },
    },
    staffTaskEnabled: true,
    trunks: SWEETWATER_TRUNK_PHONES,
  },
  {
    amdOfficePhone: NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
    displayName: "North Miami Beach Optical",
    englishSpeaker: "luz",
    greeting: "Hi, this is Maya at Abeeta Eye Group. How can I help?",
    handoff: {
      mode: "call-center",
      target: DIRECT_HANDOFF_RESPONSE.sipUri,
    },
    insurance: {
      medical: {
        query: "Aetna",
        response: "No, we don't accept Aetna.",
      },
      routineVision: {
        query: "VSP",
        response: "Yes, we take VSP.",
      },
    },
    key: "north-miami-beach-optical",
    knowledgeSource: "KNOWLEDGE_NORTH_MIAMI_BEACH_OPTICAL.md",
    promptMarker: "an ophthalmology clinic",
    scheduling: {
      medical: {
        supported: false,
        message:
          "North Miami Beach Optical supports routine vision and optical scheduling. Route medical eye care through a medical office or live staff.",
      },
      routineVision: { supported: true },
    },
    staffTaskEnabled: true,
    trunks: [NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE],
  },
  {
    amdOfficePhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE,
    displayName: "Clearbrook Eye Center",
    englishSpeaker: "wawona",
    greeting: "Hi, this is Maya at Clearbrook Eye Center. How can I help?",
    handoff: {
      mode: "phone",
      target: `tel:${DEMO_TRANSFER_NUMBER}`,
    },
    insurance: {
      medical: {
        query: "Ambetter Premier",
        response: "Yes, we take Ambetter Premier.",
      },
      routineVision: {
        query: "VSP",
        response: "Yes, we take VSP.",
      },
    },
    key: "ophthalmology-demo",
    knowledgeSource: "KNOWLEDGE_OPHTHALMOLOGY_DEMO.md",
    promptMarker: "a fictional ophthalmology clinic",
    scheduling: {
      medical: { supported: true },
      routineVision: { supported: true },
    },
    staffTaskEnabled: true,
    trunks: [OPHTHALMOLOGY_DEMO_TRUNK_PHONE],
  },
  {
    amdOfficePhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE,
    displayName: "New Tampa Eye Institute",
    englishSpeaker: "wawona",
    greeting:
      "Hi, this is Maya at the New Tampa Eye Institute demo. How can I help you today?",
    handoff: {
      mode: "phone",
      target: `tel:${DEMO_TRANSFER_NUMBER}`,
    },
    insurance: {
      medical: {
        query: "Ambetter Premier",
        response:
          "Yes, we take Ambetter Premier. This is a demo insurance match. The office still needs to verify your exact plan, provider network, benefits, and any referral or authorization.",
      },
      routineVision: {
        query: "VSP",
        response:
          "Yes, we take VSP. This is a demo insurance match. The office still needs to verify your exact plan, provider network, benefits, and any referral or authorization.",
      },
    },
    key: "new-tampa-demo",
    knowledgeSource: "KNOWLEDGE_NEW_TAMPA_DEMO.md",
    promptMarker: "a personalized New Tampa Eye Institute demonstration",
    scheduling: {
      medical: { supported: true },
      routineVision: { supported: true },
    },
    staffTaskEnabled: true,
    trunks: [NEW_TAMPA_DEMO_TRUNK_PHONE],
  },
  {
    amdOfficePhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE,
    displayName: "Juniper Ridge Rheumatology & Arthritis Care",
    englishSpeaker: "wawona",
    greeting:
      "Hi, this is Julia, the virtual assistant at Juniper Ridge Rheumatology and Arthritis Care. How can I help you today?",
    handoff: {
      mode: "phone",
      target: `tel:${DEMO_TRANSFER_NUMBER}`,
    },
    insurance: {
      medical: {
        query: "Ambetter Premier",
        response: "Yes, we take Ambetter Premier.",
      },
      routineVision: {
        query: "VSP",
        response: "No, we don't accept VSP.",
      },
    },
    key: "rheumatology-demo",
    knowledgeSource: "KNOWLEDGE_RHEUM_DEMO.md",
    promptMarker: "a fictional rheumatology practice",
    scheduling: {
      medical: { supported: true },
      routineVision: {
        supported: false,
        message:
          "Juniper Ridge Rheumatology & Arthritis Care schedules rheumatology care. Route routine eye exams, glasses prescriptions, and contact lens prescriptions through an eye-care practice.",
      },
    },
    staffTaskEnabled: true,
    trunks: [RHEUMATOLOGY_DEMO_TRUNK_PHONE],
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
  const selection = createVoiceAgent(trunkPhone, {
    ownedMiddleware: middleware,
  }).office.availabilityOfficeFor(requestedOffice);

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
        const voiceAgent = createVoiceAgent(trunkPhone, {
          ownedMiddleware: middleware,
        });
        const { office } = voiceAgent;
        const instructions = String(voiceAgent.agent.instructions);
        const tools = toolNames(voiceAgent.agent.toolCtx.tools);
        const medicalState = createTestCallState({
          amdOfficePhone: office.amdOfficePhone,
          officeKey: office.key,
          trunkPhone,
        });
        medicalState.workflow.visitType = "medical";
        const routineVisionState = createTestCallState({
          amdOfficePhone: office.amdOfficePhone,
          officeKey: office.key,
          trunkPhone,
        });
        routineVisionState.workflow.visitType = "routine_vision";

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
          staffTaskEnabled: office.staffTaskEnabled,
          tools: tools.sort(),
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
          staffTaskEnabled: expected.staffTaskEnabled,
          tools: [
            ...COMMON_TOOL_NAMES,
            ...(expected.key === "new-tampa-demo"
              ? ["triage_eye_care", "notify_after_hours_physician"]
              : []),
            ...(expected.staffTaskEnabled ? ["create_staff_task"] : []),
          ].sort(),
        });
      });
    }
  }

  it("rejects unsupported and malformed trunks at Voice Agent creation", () => {
    const errors = ["+19999999999", "not-a-phone-number", ""].map(
      (trunkPhone) => {
        try {
          createVoiceAgent(trunkPhone, { ownedMiddleware: middleware });
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
          "Abita Eye Group calls use their current office. Check availability again with office omitted.",
      },
    });
  });
});
