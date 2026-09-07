import { describe, it, expect, vi } from "vitest";
import { isFunctionTool, isToolset } from "@livekit/agents";
import { createVoiceAgent } from "../agent.js";
import type { OwnedMiddleware } from "../clients/owned-middleware.js";
import { getOfficeProfile } from "../customers/abita/profile.js";
import {
  simulationData,
  simulationMiddlewareConfig,
  readOnlySimulationMiddleware,
  newSimulationEvidence,
  simulationFailure,
  simulationTools,
  simulationFetch,
} from "../main.js";

// Importing main for unit checks must not start a LiveKit worker.
vi.mock("@livekit/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@livekit/agents")>();
  return { ...actual, cli: { ...actual.cli, runApp: vi.fn() } };
});

const patient = {
  firstName: "Avery",
  lastName: "Codextest",
  dob: "03/12/1990",
};
function fixture() {
  const client = {
    resolvePatient: vi.fn().mockResolvedValue({
      status: "verified",
      patientId: "test-id",
      routing: "all_three",
    }),
    getAvailability: vi.fn().mockResolvedValue({
      status: "found",
      slots: [{ provider: "Test", datetime: "2026-09-09T10:00:00" }],
    }),
    createPatient: vi.fn(),
    updateInsurance: vi.fn(),
    bookAppointment: vi.fn(),
    cancelAppointment: vi.fn(),
  };
  const evidence = newSimulationEvidence();
  return {
    client,
    evidence,
    middleware: readOnlySimulationMiddleware(
      client as unknown as OwnedMiddleware,
      patient,
      evidence,
    ),
  };
}
const env = {
  SANDBOX_AMD_API_URL: "https://abita-middleware-sandbox-test.run.app",
  SANDBOX_AMD_API_TOKEN: "test-only-token",
};
describe("simulation setup", () => {
  it("disables redirects on simulation requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    try {
      await simulationFetch(
        "https://abita-middleware-sandbox-test.run.app/api/patient/resolve",
        { method: "POST", body: "{}", redirect: "follow" },
      );
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
      await expect(
        simulationFetch(
          "https://abita-middleware-sandbox-test.run.app/api/patient/resolve",
        ),
      ).rejects.toThrow("redirect disallowed");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("selects existing office profile and forces dev without mutating environment", () => {
    const result = simulationMiddlewareConfig("spring-hill", env);
    expect(result.office).toBe(getOfficeProfile("spring-hill"));
    expect(result.config.officeOverride).toBe("spring_hill");
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
  it("validates YAML userdata", () => {
    expect(simulationData.parse({ office: "spring-hill", patient })).toEqual({
      office: "spring-hill",
      patient,
    });
    expect(() =>
      simulationData.parse({ office: "spring-hill", patient: {} }),
    ).toThrow();
    expect(() =>
      simulationData.parse({
        office: "spring-hill",
        patient,
        backend: "production",
      }),
    ).toThrow();
  });
});
describe("read-only middleware", () => {
  it("permits the fixture lookup and availability", async () => {
    const f = fixture();
    await f.middleware.resolvePatient({
      office: "spring_hill",
      identity: patient,
    });
    await f.middleware.getAvailability({
      office: "spring_hill",
      dob: patient.dob,
      routing: "all_three",
      rangeDays: 14,
    });
    expect(simulationFailure(f.evidence)).toBeNull();
  });
  it("accepts ISO date spelling", async () => {
    const f = fixture();
    await f.middleware.resolvePatient({
      office: "spring_hill",
      identity: { ...patient, dob: "1990-03-12" },
    });
    expect(f.client.resolvePatient).toHaveBeenCalledOnce();
  });
  it("blocks another patient before network access", async () => {
    const f = fixture();
    await expect(
      f.middleware.resolvePatient({
        office: "spring_hill",
        identity: { ...patient, firstName: "SomeoneElse" },
      }),
    ).rejects.toThrow();
    expect(f.client.resolvePatient).not.toHaveBeenCalled();
  });
  it("blocks guessed IDs before verification", async () => {
    const f = fixture();
    await expect(
      f.middleware.resolvePatient({
        office: "spring_hill",
        identity: { patientId: "test-id" },
      }),
    ).rejects.toThrow();
    expect(f.client.resolvePatient).not.toHaveBeenCalled();
  });
  it("blocks availability before verification", async () => {
    const f = fixture();
    await expect(
      f.middleware.getAvailability({
        office: "spring_hill",
        dob: patient.dob,
        routing: "all_three",
        rangeDays: 14,
      }),
    ).rejects.toThrow();
    expect(f.client.getAvailability).not.toHaveBeenCalled();
  });
  it.each([
    "createPatient",
    "updateInsurance",
    "bookAppointment",
    "cancelAppointment",
  ] as const)("blocks %s", async (method) => {
    const f = fixture();
    await expect(f.middleware[method]({} as never)).rejects.toThrow();
    expect(f.client[method]).not.toHaveBeenCalled();
  });
  it("blocks transfers and staff tasks at the real tool boundary", async () => {
    const f = fixture();
    const { agent } = createVoiceAgent(
      getOfficeProfile("spring-hill").trunkPhones[0]!,
      { ownedMiddleware: f.middleware },
    );
    const tools = simulationTools(agent.toolCtx.tools, f.evidence);
    for (const name of [
      "transfer_call",
      "create_staff_task",
      "book_appointment",
    ]) {
      const tool = tools.find((t) => isFunctionTool(t) && t.name === name);
      expect(tool && isFunctionTool(tool)).toBe(true);
      if (tool && isFunctionTool(tool))
        await tool.execute!({} as never, {} as never);
    }
    expect(f.evidence.blocked).toEqual([
      "transfer_call",
      "create_staff_task",
      "book_appointment",
    ]);
    expect(tools.some((t) => isToolset(t) && t.id === "end_call")).toBe(true);
  });
});
describe("result verification", () => {
  it("requires actual lookup and inventory evidence", () => {
    expect(simulationFailure(newSimulationEvidence())).not.toBeNull();
    expect(simulationFailure(undefined)).toContain("invalid-run");
  });
  it("does not hide blocked writes behind successful reads", () => {
    const e = {
      ...newSimulationEvidence(),
      verified: true,
      slotCount: 2,
      blocked: ["book"],
    };
    expect(simulationFailure(e)).toContain("prohibited");
  });
  it("classifies read failures separately", () =>
    expect(
      simulationFailure({ ...newSimulationEvidence(), readFailures: 1 }),
    ).toContain("invalid-run"));
});
