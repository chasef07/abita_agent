import { isDemoOfficeKey, type OfficeKey } from "../customers/abita/profile.js";

// LiveKit sets an empty deployment name for production. Any named deployment
// must remain isolated, including future preview/development deployments.
export function isNonProductionDeployment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.LIVEKIT_AGENT_DEPLOYMENT?.trim());
}

export function usesSandboxMiddleware(
  officeKey: OfficeKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isNonProductionDeployment(env) || isDemoOfficeKey(officeKey);
}

export function getMiddlewareConfig(
  officeKey: OfficeKey,
  env: NodeJS.ProcessEnv = process.env,
): {
  authToken: string;
  middlewareBaseUrl: string;
  officeOverride?: "spring_hill";
} {
  if (!usesSandboxMiddleware(officeKey, env)) {
    return {
      authToken: env.AMD_API_TOKEN?.trim() ?? "",
      middlewareBaseUrl: env.AMD_API_URL?.trim() ?? "",
    };
  }

  const middlewareBaseUrl = env.SANDBOX_AMD_API_URL?.trim();
  const authToken = env.SANDBOX_AMD_API_TOKEN?.trim();
  if (!middlewareBaseUrl || !authToken) {
    throw new Error(
      "SANDBOX_AMD_API_URL and SANDBOX_AMD_API_TOKEN are required for demo and non-production calls",
    );
  }
  let sandboxUrl: URL;
  try {
    sandboxUrl = new URL(middlewareBaseUrl);
  } catch {
    throw new Error("SANDBOX_AMD_API_URL must be an HTTPS service URL");
  }
  if (
    sandboxUrl.protocol !== "https:" ||
    sandboxUrl.username ||
    sandboxUrl.password ||
    sandboxUrl.search ||
    sandboxUrl.hash
  ) {
    throw new Error(
      "SANDBOX_AMD_API_URL must be an HTTPS service URL without credentials, query, or fragment",
    );
  }
  let productionOrigin: string | undefined;
  if (env.AMD_API_URL?.trim()) {
    try {
      productionOrigin = new URL(env.AMD_API_URL.trim()).origin;
    } catch {
      throw new Error(
        "AMD_API_URL is invalid; cannot verify sandbox isolation",
      );
    }
  }
  if (sandboxUrl.origin === productionOrigin) {
    throw new Error(
      "Sandbox and production middleware must use separate service origins",
    );
  }
  if (authToken === env.AMD_API_TOKEN?.trim()) {
    throw new Error(
      "Sandbox and production middleware must use separate API tokens",
    );
  }
  return { authToken, middlewareBaseUrl, officeOverride: "spring_hill" };
}
