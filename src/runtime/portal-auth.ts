export function getPortalSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.LIVEKIT_FORWARD_SYNC_SECRET;
}

export function getProductInteractionConfig(
  env: NodeJS.ProcessEnv = process.env,
): { secret?: string; url?: string } {
  return {
    secret: trimmed(env.ACUITY_PRODUCT_SERVICE_SECRET),
    url: trimmed(env.ACUITY_PRODUCT_INTERACTION_URL),
  };
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
