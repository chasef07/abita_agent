const REQUIRED_RUNTIME_ENV = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "ASSEMBLYAI_API_KEY",
  "BASETEN_API_KEY",
  "ELEVENLABS_API_KEY",
  "AMD_API_TOKEN",
] as const;

let validated = false;

export function validateRuntimeEnv(): void {
  if (validated) return;

  const missing = REQUIRED_RUNTIME_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required runtime environment variables: ${missing.join(", ")}`,
    );
  }

  if (!process.env.ANALYTICS_URL) {
    console.warn(
      "[env] ANALYTICS_URL is not set; post-call analytics disabled",
    );
  }

  if (process.env.ANALYTICS_URL && !process.env.WEBHOOK_SECRET) {
    console.warn("[env] WEBHOOK_SECRET is not set; analytics POST is unsigned");
  }

  validated = true;
}
