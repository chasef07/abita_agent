import { voice } from "@livekit/agents";

export function startTaskReply(
  session: voice.AgentSession<unknown>,
  instructions: string,
): void {
  // Task onEnter often runs during a parent tool execution. LiveKit defaults
  // generateReply() inside a tool to toolChoice="none", which blocks the task's
  // own tools unless we explicitly re-enable tool calling here.
  session.generateReply({
    instructions,
    toolChoice: "auto",
  });
}
