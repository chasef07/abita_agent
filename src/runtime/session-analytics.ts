import { AgentSessionEventTypes, type AgentSession } from "@livekit/agents";
import {
  createEmptySessionEventAnalytics,
  snapshotCloseEvent,
  snapshotErrorEvent,
  snapshotFalseInterruptionEvent,
  snapshotOverlappingSpeechEvent,
  snapshotToolExecutions,
  type SessionEventAnalytics,
  type SttProfileTransitionAnalytics,
  type ToolExecutionAnalytics,
} from "../call-observability.js";
import type { CallState } from "../state/call-state.js";
import type { SttProfileSwitcher } from "./stt-profile-switcher.js";

export type TurnMetricSnapshot = {
  itemId: string;
  role: string;
  type: string;
  createdAt: number;
  interrupted: boolean;
  metrics: Record<string, unknown>;
};

export type SessionAnalyticsBuffers = {
  turnMetrics: TurnMetricSnapshot[];
  toolExecutions: ToolExecutionAnalytics[];
  sessionEvents: SessionEventAnalytics;
  sttProfiles: SttProfileTransitionAnalytics[];
  latestUsage: Record<string, unknown> | undefined;
};

export function attachSessionAnalytics(
  session: AgentSession<CallState>,
  options: { sttProfileSwitcher: SttProfileSwitcher },
): SessionAnalyticsBuffers {
  const { sttProfileSwitcher } = options;

  const buffers: SessionAnalyticsBuffers = {
    turnMetrics: [],
    toolExecutions: [],
    sessionEvents: createEmptySessionEventAnalytics(),
    sttProfiles: sttProfileSwitcher.sttProfiles,
    latestUsage: undefined,
  };

  session.on(AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    if (ev.item.type !== "message") return;

    const metrics = Object.fromEntries(
      Object.entries(ev.item.metrics ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    );
    if (Object.keys(metrics).length > 0) {
      buffers.turnMetrics.push({
        itemId: ev.item.id,
        role: ev.item.role,
        type: ev.item.type,
        createdAt: ev.createdAt,
        interrupted: ev.item.interrupted,
        metrics,
      });
    }

    if (ev.item.role !== "assistant") return;

    const assistantText = ev.item.textContent ?? "";
    sttProfileSwitcher.applyAssistantPromptProfile(assistantText, {
      createdAt: ev.createdAt,
    });
  });

  session.on(AgentSessionEventTypes.SessionUsageUpdated, (ev) => {
    buffers.latestUsage = ev.usage as unknown as Record<string, unknown>;
  });

  session.on(AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
    buffers.toolExecutions.push(...snapshotToolExecutions(ev));
  });

  session.on(AgentSessionEventTypes.Error, (ev) => {
    buffers.sessionEvents.errors.push(snapshotErrorEvent(ev));
  });

  session.on(AgentSessionEventTypes.Close, (ev) => {
    buffers.sessionEvents.close = snapshotCloseEvent(ev);
  });

  session.on(AgentSessionEventTypes.AgentFalseInterruption, (ev) => {
    buffers.sessionEvents.falseInterruptions.push(
      snapshotFalseInterruptionEvent(ev),
    );
  });

  session.on(AgentSessionEventTypes.OverlappingSpeech, (ev) => {
    buffers.sessionEvents.overlappingSpeech.push(
      snapshotOverlappingSpeechEvent(ev),
    );
  });

  session.on(AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (ev.isFinal) {
      sttProfileSwitcher.applySttProfile("default", "user_final", {
        callerText: ev.transcript,
        createdAt: ev.createdAt,
      });
    }
  });

  return buffers;
}
