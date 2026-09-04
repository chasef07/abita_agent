import { isDemoOfficeKey, type OfficeKey } from "../customers/abita/profile.js";
import {
  getMiddlewareConfig,
  isNonProductionDeployment,
} from "./middleware-routing.js";

const PRODUCTION_CONFIGURATION = [
  "AMD_API_URL",
  "AMD_API_TOKEN",
  "ACUITY_PRODUCT_INTERACTION_URL",
  "ACUITY_PRODUCT_HANDOFF_URL",
  "ACUITY_DEMO_PRODUCT_SERVICE_SECRET",
  "ACUITY_DEMO_PRODUCT_PRACTICE_ID",
  "ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET",
  "ABITA_EYE_GROUP_PRODUCT_PRACTICE_ID",
] as const;

export function getProductInteractionConfig(
  officeKey: OfficeKey,
  env: NodeJS.ProcessEnv = process.env,
): { secret?: string; url?: string } {
  // Named deployments must never ingest simulated calls into Product.
  // Production demo calls retain their existing, demo-tenant-only history.
  if (isNonProductionDeployment(env)) return {};
  const tenant = getProductTenantConfig(officeKey, env);
  const config = {
    secret: tenant.secret,
    url: trimmed(env.ACUITY_PRODUCT_INTERACTION_URL),
  };
  if (env.NODE_ENV === "production" && (!config.url || !config.secret)) {
    throw new Error(
      `ACUITY_PRODUCT_INTERACTION_URL and ${tenant.secretName} are required for ${officeKey} Product interactions`,
    );
  }
  return config;
}

export function getProductTenantConfig(
  officeKey: OfficeKey,
  env: NodeJS.ProcessEnv = process.env,
): {
  practiceId?: string;
  practiceIdName:
    "ACUITY_DEMO_PRODUCT_PRACTICE_ID" | "ABITA_EYE_GROUP_PRODUCT_PRACTICE_ID";
  secretName:
    | "ACUITY_DEMO_PRODUCT_SERVICE_SECRET"
    | "ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET";
  secret?: string;
} {
  const isDemo = isDemoOfficeKey(officeKey);
  const practiceIdName = isDemo
    ? "ACUITY_DEMO_PRODUCT_PRACTICE_ID"
    : "ABITA_EYE_GROUP_PRODUCT_PRACTICE_ID";
  const secretName = isDemo
    ? "ACUITY_DEMO_PRODUCT_SERVICE_SECRET"
    : "ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET";
  return {
    practiceId: trimmed(env[practiceIdName]),
    practiceIdName,
    secret: trimmed(env[secretName]),
    secretName,
  };
}

export function validateRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isNonProductionDeployment(env)) {
    getMiddlewareConfig("rheumatology-demo", env);
    return;
  }
  if (
    env.NODE_ENV === "production" &&
    PRODUCTION_CONFIGURATION.some((name) => !trimmed(env[name]))
  ) {
    throw new Error(
      `${PRODUCTION_CONFIGURATION.join(", ")} are required in production`,
    );
  }
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
