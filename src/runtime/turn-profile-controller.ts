import { AgentSessionEventTypes, type AgentSession } from "@livekit/agents";
import {
  snapshotSttProfileTransition,
  type SttProfileTransitionAnalytics,
} from "./stt-profile-observability.js";
import { voiceEndpointingProfiles } from "../session-options.js";
import type { CallState } from "../state/call-state.js";
import {
  type AssemblyAIInferenceModelOptions,
  type SttProfile,
  getAssemblyAIAgentContext,
  getAssemblyAIInferenceSttProfileOptions,
  selectSttProfileForAssistantText,
} from "../stt-config.js";

type EndpointingProfile = keyof typeof voiceEndpointingProfiles;
type EndpointingOptions = (typeof voiceEndpointingProfiles)[EndpointingProfile];
type InferenceStt = {
  updateOptions: (options: {
    modelOptions: AssemblyAIInferenceModelOptions;
  }) => void;
};

export type TurnProfileController = {
  applySttProfile: (
    profile: SttProfile,
    reason: string,
    details?: {
      createdAt?: number;
    },
    extraOptions?: AssemblyAIInferenceModelOptions,
  ) => void;
  commitUserTurn: () => void;
  observeAssistantText: (assistantText: string, complete: boolean) => void;
  sttProfiles: SttProfileTransitionAnalytics[];
  readonly activeSttProfile: SttProfile;
};

export function createTurnProfileController(
  stt: InferenceStt,
  options: {
    startedAt: Date;
    updateEndpointing: (options: EndpointingOptions) => void;
  },
): TurnProfileController {
  let activeSttProfile: SttProfile = "default";
  let activeEndpointingProfile: EndpointingProfile = "conversation";
  let promptedSttProfile: SttProfile | null = null;
  const sttProfiles: SttProfileTransitionAnalytics[] = [
    snapshotSttProfileTransition({
      createdAt: options.startedAt,
      from: null,
      reason: "startup",
      to: activeSttProfile,
    }),
  ];

  const applySttProfile = (
    profile: SttProfile,
    reason: string,
    details: {
      createdAt?: number;
    } = {},
    extraOptions: AssemblyAIInferenceModelOptions = {},
  ) => {
    if (
      profile === activeSttProfile &&
      Object.keys(extraOptions).length === 0
    ) {
      return;
    }

    const previousProfile = activeSttProfile;
    stt.updateOptions({
      modelOptions: {
        ...getAssemblyAIInferenceSttProfileOptions(profile),
        ...extraOptions,
      },
    });
    if (profile === activeSttProfile) return;

    activeSttProfile = profile;
    sttProfiles.push(
      snapshotSttProfileTransition({
        ...details,
        createdAt: details.createdAt ?? Date.now(),
        from: previousProfile,
        reason,
        to: profile,
      }),
    );
    console.log(
      `[stt] AssemblyAI inference profile=${profile} reason=${reason}`,
    );
  };

  const applyEndpointingProfile = (profile: EndpointingProfile) => {
    if (profile === activeEndpointingProfile) return;
    activeEndpointingProfile = profile;
    options.updateEndpointing(voiceEndpointingProfiles[profile]);
  };

  const observeAssistantText = (assistantText: string, complete: boolean) => {
    const profile = selectSttProfileForAssistantText(assistantText, {
      fallbackProfile: promptedSttProfile,
    });
    if (!complete && profile === "default") return;

    promptedSttProfile = profile === "default" ? null : profile;
    const agentContext = complete
      ? getAssemblyAIAgentContext(assistantText)
      : undefined;
    applySttProfile(
      profile,
      "assistant_prompt",
      {},
      agentContext ? { agent_context: agentContext } : {},
    );
    if (profile !== "default") {
      applyEndpointingProfile(endpointingForPrompt(assistantText, profile));
    }
  };

  return {
    applySttProfile,
    commitUserTurn: () => applyEndpointingProfile("conversation"),
    observeAssistantText,
    sttProfiles,
    get activeSttProfile() {
      return activeSttProfile;
    },
  };
}

function endpointingForPrompt(
  assistantText: string,
  sttProfile: SttProfile,
): EndpointingProfile {
  const text = assistantText.toLowerCase().replace(/\s+/g, " ");
  // A combined question keeps enough time for its slowest requested detail.
  const needsDeliberateAnswer =
    /\b(?:spell(?:ing|ed)?|letter[ -]by[ -]letter|birth|dob|d o b|birthday|phone|number|address|street|apartment|suite|zip|email|e-mail)\b/.test(
      text,
    );
  const asksForName = sttProfile === "intake" && /\bname\b/.test(text);
  // Generic repeats can refer to spelling; shorten only an explicit question.
  const asksForInsurance =
    sttProfile === "insurance" && /\b(?:insurance|plan name)\b/.test(text);
  return !needsDeliberateAnswer && (asksForInsurance || asksForName)
    ? "shortAnswer"
    : "deliberate";
}

export function attachTurnProfileLifecycle(
  session: AgentSession<CallState>,
  controller: TurnProfileController,
): void {
  session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
    if (!event.isFinal) return;
    controller.applySttProfile("default", "user_final", {
      createdAt: event.createdAt,
    });
  });

  session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
    if (event.item.type === "message" && event.item.role === "user") {
      controller.commitUserTurn();
    }
  });
}
