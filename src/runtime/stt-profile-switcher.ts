import * as assemblyai from "@livekit/agents-plugin-assemblyai";
import {
  snapshotSttProfileTransition,
  type SttProfileTransitionAnalytics,
} from "../call-observability.js";
import {
  type SttProfile,
  getAssemblyAIAgentContext,
  getAssemblyAISttProfileOptions,
  selectSttProfileForAssistantText,
} from "../stt-config.js";

export type SttProfileSwitcher = {
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
  applyAssistantPromptProfile: (
    assistantText: string,
    details: { createdAt?: number },
  ) => void;
  sttProfiles: SttProfileTransitionAnalytics[];
  readonly activeSttProfile: SttProfile;
};

export function createSttProfileSwitcher(
  stt: assemblyai.STT,
  options: { startedAt: Date },
): SttProfileSwitcher {
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

  const applyAssistantPromptProfile = (
    assistantText: string,
    details: { createdAt?: number },
  ) => {
    const profile = selectSttProfileForAssistantText(assistantText, {
      fallbackProfile: promptedSttProfile,
    });
    promptedSttProfile = profile === "default" ? null : profile;
    const agentContext = getAssemblyAIAgentContext(assistantText);
    applySttProfile(
      profile,
      "assistant_prompt",
      {
        assistantText,
        createdAt: details.createdAt,
      },
      agentContext ? { agentContext } : {},
    );
  };

  return {
    applySttProfile,
    applyAssistantPromptProfile,
    sttProfiles,
    get activeSttProfile() {
      return activeSttProfile;
    },
  };
}
