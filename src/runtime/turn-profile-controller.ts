import { AgentSessionEventTypes, type AgentSession } from "@livekit/agents";
import {
  snapshotSttProfileTransition,
  type SttProfileTransitionAnalytics,
} from "./stt-profile-observability.js";
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
  observeAssistantText: (assistantText: string, complete: boolean) => void;
  sttProfiles: SttProfileTransitionAnalytics[];
  readonly activeSttProfile: SttProfile;
};

export function createTurnProfileController(
  stt: ProfileStt,
  options: {
    startedAt: Date;
  },
): TurnProfileController {
  let activeSttProfile: SttProfile = "default";
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
      agentContext ? { agentContext } : {},
    );
  };

  return {
    applySttProfile,
    commitUserTurn: () => applySttProfile("default", "user_turn_committed"),
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
  session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
    if (event.item.type === "message" && event.item.role === "user") {
      controller.commitUserTurn();
    }
  });
}
