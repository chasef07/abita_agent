import { AgentSessionEventTypes, type AgentSession } from "@livekit/agents";
import {
  snapshotSttProfileTransition,
  type SttProfileTransitionAnalytics,
} from "./stt-profile-observability.js";
import { voiceEndpointingProfiles } from "../session-options.js";
import type { CallState } from "../state/call-state.js";
import {
  type AssemblyAISttProfileOptions,
  type SttProfile,
  getAssemblyAIAgentContext,
  getAssemblyAISttProfileOptions,
  selectSttProfileForAssistantText,
} from "../stt-config.js";

type ProfileStt = {
  updateOptions: (options: AssemblyAISttProfileOptions) => void;
};

export type TurnProfileController = {
  applySttProfile: (
    profile: SttProfile,
    reason: string,
    details?: {
      createdAt?: number;
    },
    extraOptions?: AssemblyAISttProfileOptions,
  ) => void;
  commitUserTurn: () => void;
  commitAssistantTurn: (committedText: string) => void;
  observeAssistantText: (assistantText: string, complete: boolean) => void;
  sttProfiles: SttProfileTransitionAnalytics[];
  readonly activeSttProfile: SttProfile;
};

export function createTurnProfileController(
  stt: ProfileStt,
  options: {
    startedAt: Date;
    updateEndpointing: (options: {
      minDelay: number;
      maxDelay: number;
    }) => void;
  },
): TurnProfileController {
  let activeSttProfile: SttProfile = "default";
  let committedPromptProfile: SttProfile | null = null;
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
    extraOptions: AssemblyAISttProfileOptions = {},
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
    if ((profile === "default") !== (previousProfile === "default")) {
      options.updateEndpointing(
        profile === "default"
          ? voiceEndpointingProfiles.conversation
          : voiceEndpointingProfiles.deliberate,
      );
    }
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

  const profileForAssistantText = (text: string) =>
    selectSttProfileForAssistantText(text, {
      fallbackProfile: committedPromptProfile,
    });

  return {
    applySttProfile,
    commitUserTurn: () => applySttProfile("default", "user_turn_committed"),
    // TTS input may include discarded text. It can arm recognition, while
    // only SDK-committed output advances context and follow-up history.
    observeAssistantText: (text, complete) => {
      const profile = profileForAssistantText(text);
      if (!complete && profile === "default") return;
      applySttProfile(profile, "assistant_prompt");
    },
    commitAssistantTurn: (committedText) => {
      const agentContext = getAssemblyAIAgentContext(committedText.trim());
      if (!agentContext) return;
      const profile = profileForAssistantText(committedText);
      committedPromptProfile = profile === "default" ? null : profile;
      applySttProfile(profile, "assistant_prompt", {}, { agentContext });
    },
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
  session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
    if (event.item.type !== "message") return;
    if (event.item.role === "user") {
      controller.commitUserTurn();
    } else if (event.item.role === "assistant" && event.item.textContent) {
      controller.commitAssistantTurn(event.item.textContent);
    }
  });
}
