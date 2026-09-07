import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { isFunctionTool, isToolset } from "@livekit/agents";
import { createVoiceAgent } from "../agent.js";
import type { OwnedMiddleware } from "../clients/owned-middleware.js";
import { getOfficeProfile } from "../customers/abita/profile.js";
import {
  simulationData,
  simulationMiddlewareConfig,
  simulationTools,
  simulationFetch,
} from "../runtime/simulation.js";

const env = {
  SANDBOX_AMD_API_URL: "https://abita-middleware-sandbox-test.run.app",
  SANDBOX_AMD_API_TOKEN: "test-only-token",
};

describe("simulation setup", () => {
  it("loads all six scenarios with office-only routing metadata", () => {
    const yaml = parse(readFileSync("evals/scenarios.yaml", "utf8"));
    expect(yaml.scenarios).toHaveLength(6);
    expect(
      new Set(yaml.scenarios.map((s: { label: string }) => s.label)).size,
    ).toBe(6);
    for (const scenario of yaml.scenarios) {
      expect(scenario.instructions.trim()).not.toBe("");
      expect(scenario.agent_expectations.trim()).not.toBe("");
      expect(simulationData.parse(scenario.userdata)).toEqual({
        office: "spring-hill",
      });
      expect(Object.keys(scenario.userdata)).toEqual(["office"]);
    }
  });
  it("keeps real EMR tools unchanged and removes external transfers and messages", () => {
    const client = {
      resolvePatient: vi.fn(),
      getAvailability: vi.fn(),
      createPatient: vi.fn(),
      updateInsurance: vi.fn(),
      bookAppointment: vi.fn(),
      cancelAppointment: vi.fn(),
    } satisfies OwnedMiddleware;
    const { agent } = createVoiceAgent(
      getOfficeProfile("spring-hill").trunkPhones[0]!,
      { ownedMiddleware: client },
    );
    const tools = simulationTools(agent.toolCtx.tools);
    for (const name of [
      "resolve_patient",
      "list_available_appointments",
      "check_insurance",
      "add_patient",
      "update_insurance",
      "book_appointment",
      "reschedule_appointment",
      "cancel_appointment",
    ]) {
      const original = agent.toolCtx.tools.find(
        (t) => isFunctionTool(t) && t.name === name,
      );
      expect(original).toBeDefined();
      expect(tools.find((t) => isFunctionTool(t) && t.name === name)).toBe(
        original,
      );
    }
    expect(
      tools.some(
        (t) =>
          isFunctionTool(t) &&
          ["transfer_call", "create_staff_task"].includes(t.name),
      ),
    ).toBe(false);
    expect(tools.some((t) => isToolset(t) && t.id === "end_call")).toBe(true);
    expect(client.resolvePatient).not.toHaveBeenCalled();
  });
  it("disables redirects on simulation requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    try {
      await simulationFetch(env.SANDBOX_AMD_API_URL, { redirect: "follow" });
      expect(fetcher.mock.calls[0]![1].redirect).toBe("error");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("propagates redirected-request rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("redirect disallowed")),
    );
    try {
      await expect(simulationFetch(env.SANDBOX_AMD_API_URL)).rejects.toThrow(
        "redirect disallowed",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("selects the office profile and forces dev without changing the environment", () => {
    const result = simulationMiddlewareConfig("spring-hill", env);
    expect(result.office).toBe(getOfficeProfile("spring-hill"));
    expect(result.config.officeOverride).toBe("spring_hill");
    expect(result.config.middlewareBaseUrl).toBe(env.SANDBOX_AMD_API_URL);
    expect(env).not.toHaveProperty("LIVEKIT_AGENT_DEPLOYMENT");
  });
  it("rejects unknown offices", () =>
    expect(() => simulationMiddlewareConfig("typo", env)).toThrow());
  it("requires dev credentials", () =>
    expect(() => simulationMiddlewareConfig("spring-hill", {})).toThrow());
  it("rejects production URL even under a sandbox variable", () =>
    expect(() =>
      simulationMiddlewareConfig("spring-hill", {
        ...env,
        SANDBOX_AMD_API_URL: "https://abita-middleware-prod.run.app",
      }),
    ).toThrow());
  it("rejects equal production credentials", () =>
    expect(() =>
      simulationMiddlewareConfig("spring-hill", {
        ...env,
        AMD_API_TOKEN: env.SANDBOX_AMD_API_TOKEN,
      }),
    ).toThrow());
  it("requires an office, but no patient for an anonymous insurance question", () => {
    expect(simulationData.parse({ office: "spring-hill" })).toEqual({
      office: "spring-hill",
    });
    expect(() => simulationData.parse({})).toThrow();
    expect(() => simulationData.parse({ office: "" })).toThrow();
  });
});
