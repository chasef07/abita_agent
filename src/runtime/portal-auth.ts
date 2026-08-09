import type { OfficeKey } from "../customers/abita/profile.js";

const PRODUCT_INTERACTION_CONFIGURATION = [
  "ACUITY_PRODUCT_INTERACTION_URL",
  "ACUITY_DEMO_PRODUCT_SERVICE_SECRET",
  "ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET",
] as const;

export function getPortalSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.LIVEKIT_FORWARD_SYNC_SECRET;
}

export function getProductInteractionConfig(
  officeKey: OfficeKey,
  env: NodeJS.ProcessEnv = process.env,
): { secret?: string; url?: string } {
  const secretName =
    officeKey === "dev"
      ? "ACUITY_DEMO_PRODUCT_SERVICE_SECRET"
      : "ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET";
  const config = {
    secret: trimmed(env[secretName]),
    url: trimmed(env.ACUITY_PRODUCT_INTERACTION_URL),
  };
  if (env.NODE_ENV === "production" && (!config.url || !config.secret)) {
    throw new Error(
      `ACUITY_PRODUCT_INTERACTION_URL and ${secretName} are required for ${officeKey} Product interactions`,
    );
  }
  return config;
}

export function validateProductInteractionConfig(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    env.NODE_ENV === "production" &&
    PRODUCT_INTERACTION_CONFIGURATION.some((name) => !trimmed(env[name]))
  ) {
    throw new Error(
      "ACUITY_PRODUCT_INTERACTION_URL, ACUITY_DEMO_PRODUCT_SERVICE_SECRET, and ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET are required in production",
    );
  }
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
