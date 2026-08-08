export function getPortalSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.LIVEKIT_FORWARD_SYNC_SECRET;
}

export function getProductInteractionConfig(
  env: NodeJS.ProcessEnv = process.env,
): { secret?: string; url?: string } {
  const config = {
    secret: trimmed(env.ACUITY_PRODUCT_SERVICE_SECRET),
    url: trimmed(env.ACUITY_PRODUCT_INTERACTION_URL),
  };
  if (env.NODE_ENV === "production" && (!config.url || !config.secret)) {
    throw new Error(
      "ACUITY_PRODUCT_INTERACTION_URL and ACUITY_PRODUCT_SERVICE_SECRET are required in production",
    );
  }
  return config;
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
