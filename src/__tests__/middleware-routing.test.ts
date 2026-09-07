import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpOwnedMiddleware } from "../clients/owned-middleware.js";
import {
  getOfficeProfileByPhone,
  getOfficeProfiles,
  isDemoOfficeKey,
  NEW_TAMPA_DEMO_TRUNK_PHONE,
  OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import { getMiddlewareConfig } from "../runtime/middleware-routing.js";
import {
  getProductInteractionConfig,
  validateRuntimeConfig,
} from "../runtime/portal-auth.js";
import { HttpCallPortal } from "../runtime/call-closeout.js";
import { loadPreCallBootstrap } from "../runtime/precall-bootstrap.js";
import { create_staff_task } from "../tools/create-staff-task.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";

const env = {
  AMD_API_URL: "https://production.example",
  AMD_API_TOKEN: "production-token",
  SANDBOX_AMD_API_URL: "https://sandbox.example",
  SANDBOX_AMD_API_TOKEN: "sandbox-token",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("call-scoped middleware environment", () => {
  it.each([
    ["rheumatology-demo", RHEUMATOLOGY_DEMO_TRUNK_PHONE],
    ["ophthalmology-demo", OPHTHALMOLOGY_DEMO_TRUNK_PHONE],
    ["new-tampa-demo", NEW_TAMPA_DEMO_TRUNK_PHONE],
  ])("routes the %s demo number to sandbox on production", (key, phone) => {
    const office = getOfficeProfileByPhone(phone);
    expect(office.key).toBe(key);
    expect(
      getMiddlewareConfig(office.key, {
        ...env,
        LIVEKIT_AGENT_DEPLOYMENT: "",
      }),
    ).toEqual({
      authToken: env.SANDBOX_AMD_API_TOKEN,
      middlewareBaseUrl: env.SANDBOX_AMD_API_URL,
      officeOverride: "spring_hill",
    });
  });

  it.each(getOfficeProfiles())(
    "isolates $key on production without changing real offices",
    (office) => {
      const sandbox = isDemoOfficeKey(office.key);
      expect(getMiddlewareConfig(office.key, env)).toEqual(
        sandbox
          ? {
              authToken: env.SANDBOX_AMD_API_TOKEN,
              middlewareBaseUrl: env.SANDBOX_AMD_API_URL,
              officeOverride: "spring_hill",
            }
          : {
              authToken: env.AMD_API_TOKEN,
              middlewareBaseUrl: env.AMD_API_URL,
            },
      );
    },
  );

  it.each(["staging", "preview", "dev"])(
    "isolates every office in named deployment %s",
    (deployment) => {
      for (const office of getOfficeProfiles()) {
        expect(
          getMiddlewareConfig(office.key, {
            ...env,
            LIVEKIT_AGENT_DEPLOYMENT: deployment,
          }),
        ).toMatchObject({
          middlewareBaseUrl: env.SANDBOX_AMD_API_URL,
          authToken: env.SANDBOX_AMD_API_TOKEN,
          officeOverride: "spring_hill",
        });
      }
    },
  );

  it.each(["SANDBOX_AMD_API_URL", "SANDBOX_AMD_API_TOKEN"])(
    "fails closed when %s is missing",
    (name) => {
      const missing = { ...env, [name]: " " };
      expect(() => getMiddlewareConfig("rheumatology-demo", missing)).toThrow(
        "are required",
      );
      expect(() =>
        getMiddlewareConfig("spring-hill", {
          ...missing,
          LIVEKIT_AGENT_DEPLOYMENT: "staging",
        }),
      ).toThrow("are required");
      expect(() => getMiddlewareConfig("spring-hill", missing)).not.toThrow();
    },
  );

  it.each([
    "not-a-url",
    "http://sandbox.example",
    "https://user:password@sandbox.example",
    "https://sandbox.example?secret=value",
  ])("rejects an unsafe sandbox URL", (url) => {
    expect(() =>
      getMiddlewareConfig("rheumatology-demo", {
        ...env,
        SANDBOX_AMD_API_URL: url,
      }),
    ).toThrow("HTTPS service URL");
  });

  it("rejects reuse of either production origin or token", () => {
    expect(() =>
      getMiddlewareConfig("rheumatology-demo", {
        ...env,
        SANDBOX_AMD_API_URL: `${env.AMD_API_URL}/sandbox`,
      }),
    ).toThrow("separate service origins");
    expect(() =>
      getMiddlewareConfig("rheumatology-demo", {
        ...env,
        SANDBOX_AMD_API_TOKEN: env.AMD_API_TOKEN,
      }),
    ).toThrow("separate API tokens");
  });

  it("does not expose an invalid production URL in configuration errors", () => {
    expect(() =>
      getMiddlewareConfig("rheumatology-demo", {
        ...env,
        AMD_API_URL: "private-invalid-url",
      }),
    ).toThrow("AMD_API_URL is invalid; cannot verify sandbox isolation");
  });

  it.each(getOfficeProfiles())(
    "routes pre-call and later availability for $key to the sandbox office",
    async (office) => {
      const fetchMock = vi.fn(async () =>
        Response.json({ status: "not_found" }),
      );
      const middleware = new HttpOwnedMiddleware({
        ...getMiddlewareConfig(office.key, {
          ...env,
          LIVEKIT_AGENT_DEPLOYMENT: "staging",
        }),
        fetch: fetchMock,
      });
      await loadPreCallBootstrap({
        middleware,
        callerPhone: "+15555550100",
        trunkPhone: office.trunkPhones[0]!,
      });
      await middleware.getAvailability({ office: office.amdOfficePhone });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [url, request] of fetchMock.mock.calls as unknown as [
        string,
        RequestInit,
      ][]) {
        expect(url).toMatch(/^https:\/\/sandbox\.example\/api\//);
        expect(request.headers).toMatchObject({
          Authorization: "sandbox-token",
        });
        expect(JSON.parse(request.body as string).office).toBe("spring_hill");
      }
    },
  );

  it("keeps token-bound booking payloads office-free and cannot bypass office validation", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "error" }));
    const middleware = new HttpOwnedMiddleware({
      ...getMiddlewareConfig("rheumatology-demo", env),
      fetch: fetchMock,
    });
    await middleware.cancelAppointment({
      office: SPRING_HILL_OFFICE_PHONE,
      cancellationToken: "sandbox-token",
    });
    expect(
      JSON.parse(
        (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]![1]
          .body as string,
      ),
    ).toEqual({ cancellationToken: "sandbox-token" });
    expect(
      await middleware.resolvePatient({
        office: "unknown",
        identity: { patientId: "synthetic" },
      }),
    ).toEqual({ status: "error", reason: "unsupported_office" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("sandbox Product side effects", () => {
  it("skips all Product delivery in staging despite shared production secrets", async () => {
    const shared = {
      ...env,
      LIVEKIT_AGENT_DEPLOYMENT: "staging",
      NODE_ENV: "production",
      ACUITY_PRODUCT_INTERACTION_URL: "https://product.example",
      ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET: "production",
      ACUITY_DEMO_PRODUCT_SERVICE_SECRET: "demo",
    };
    expect(() => validateRuntimeConfig(shared)).not.toThrow();
    const fetchImpl = vi.fn();
    for (const office of getOfficeProfiles()) {
      const config = getProductInteractionConfig(office.key, shared);
      expect(config).toEqual({});
      expect(
        await new HttpCallPortal({ ...config, fetchImpl }).deliver({
          phase: "call-start",
          payload: {},
          timeoutMs: 1,
        }),
      ).toEqual({ ok: false, skipped: true });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks staff tasks for real office profiles in staging", async () => {
    vi.stubEnv("LIVEKIT_AGENT_DEPLOYMENT", "staging");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const state = createConfirmedPatientState();
    expect(
      await create_staff_task.execute(
        {
          category: "other",
          urgency: "normal",
          summary: "Synthetic request",
          message: "Synthetic request",
        },
        { ctx: createToolContext(state) as never, toolCallId: "test" } as never,
      ),
    ).toContain("No message was sent");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
