import { AgentSessionEventTypes, type AgentSession } from "@livekit/agents";
import * as assemblyai from "@livekit/agents-plugin-assemblyai";
import {
  snapshotSttProfileTransition,
  type SttProfileTransitionAnalytics,
} from "../call-observability.js";
import { voiceEndpointingProfiles } from "../session-options.js";
import type { CallState } from "../state/call-state.js";
import {
  type SttProfile,
  getAssemblyAIAgentContext,
  getAssemblyAISttProfileOptions,
  selectSttProfileForAssistantText,
} from "../stt-config.js";

type EndpointingProfile = keyof typeof voiceEndpointingProfiles;
type EndpointingOptions = (typeof voiceEndpointingProfiles)[EndpointingProfile];

export type TurnProfileController = {
  applySttProfile: (
    profile: SttProfile,
    reason: string,
    details?: {
      assistantText?: string;
      callerText?: string;
      createdAt?: number;
    },
    extraOptions?: Partial<assemblyai.STTOptions>,
  ) => void;
  commitUserTurn: () => void;
  observeAssistantText: (assistantText: string, complete: boolean) => void;
  sttProfiles: SttProfileTransitionAnalytics[];
  readonly activeSttProfile: SttProfile;
};

export function createTurnProfileController(
  stt: assemblyai.STT,
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
      assistantText?: string;
      callerText?: string;
      createdAt?: number;
    } = {},
    extraOptions: Partial<assemblyai.STTOptions> = {},
  ) => {
    if (
      profile === activeSttProfile &&
      Object.keys(extraOptions).length === 0
    ) {
      return;
    }

    const previousProfile = activeSttProfile;
    stt.updateOptions({
      ...getAssemblyAISttProfileOptions(profile),
      ...extraOptions,
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
    console.log(`[stt] AssemblyAI profile=${profile} reason=${reason}`);
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
      { assistantText },
      agentContext ? { agentContext } : {},
    );
    if (profile !== "default") {
      applyEndpointingProfile("deliberate");
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

export function attachTurnProfileLifecycle(
  session: AgentSession<CallState>,
  controller: TurnProfileController,
): void {
  session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
    if (!event.isFinal) return;
    controller.applySttProfile("default", "user_final", {
      callerText: event.transcript,
      createdAt: event.createdAt,
    });
  });

  session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
    if (event.item.type === "message" && event.item.role === "user") {
      controller.commitUserTurn();
    }
  });
}
