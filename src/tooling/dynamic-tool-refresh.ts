import type { voice } from "@livekit/agents";
import type { CallState } from "./call-state.js";

type ToolRefreshReason =
  | "startup"
  | "turn_update_pending"
  | "turn_understanding_recorded"
  | "tools_executed";

type ToolRefresher = (reason: ToolRefreshReason) => Promise<void>;

const dynamicToolRefreshers = new WeakMap<
  voice.AgentSession<CallState>,
  ToolRefresher
>();

export function bindDynamicToolRefresher(
  session: voice.AgentSession<CallState>,
  refresher: ToolRefresher,
): void {
  dynamicToolRefreshers.set(session, refresher);
}

export async function refreshDynamicToolsForSession(
  session: voice.AgentSession<CallState>,
  reason: ToolRefreshReason,
): Promise<void> {
  if (!session.userData.runtime.dynamicToolsEnabled) return;
  const refresher = dynamicToolRefreshers.get(session);
  if (!refresher) return;
  await refresher(reason);
}
