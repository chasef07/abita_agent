export function getAnalyticsSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.LIVEKIT_FORWARD_SYNC_SECRET || env.WEBHOOK_SECRET;
}
