// LiveKit worker entry point; call startup owns the production lifecycle.
import { ServerOptions, cli, defineAgent } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { validateRuntimeConfig } from "./runtime/portal-auth.js";
import { setupGoogleCloudTracing } from "./runtime/google-cloud-tracing.js";
import { startSimulation } from "./runtime/simulation.js";
import { startVoiceCall } from "./runtime/session-startup.js";

validateRuntimeConfig();

export default defineAgent({
  entry: async (ctx) => {
    try {
      setupGoogleCloudTracing(ctx);
      if (ctx.simulationContext()) return await startSimulation(ctx);
      await startVoiceCall(ctx);
    } catch (error) {
      console.error("[entry] FATAL:", error);
      throw error;
    }
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "abita-agent",
    shutdownProcessTimeout: 60_000, // Allow closeout delivery to finish.
  }),
);
