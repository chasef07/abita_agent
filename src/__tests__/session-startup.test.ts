import { EventEmitter } from "node:events";
import { AgentSession, type JobContext } from "@livekit/agents";
import { STT } from "@livekit/agents-plugin-assemblyai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agentEntry from "../main.js";
import { HttpOwnedMiddleware } from "../clients/owned-middleware.js";
import { HttpCallPortal } from "../runtime/call-closeout.js";
import { InMemoryCallPortal } from "./support/call-portal.js";

// Replace external voice providers, not startup or closeout orchestration.
vi.mock("@livekit/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@livekit/agents")>();
  const { EventEmitter } = await import("node:events");
  class VAD {
    updateOptions() {}
  }
  return {
    ...actual,
    cli: { runApp: vi.fn() },
    ServerOptions: class {},
    FallbackAdapter: class {},
    inference: { ...actual.inference, VAD, TurnDetector: class {} },
    AgentSession: class extends EventEmitter {
      userData;
      vad = new VAD();
      constructor(options: { userData: unknown }) {
        super();
        this.userData = options.userData;
      }
      async start() {}
      shutdown() {}
    },
  };
});
vi.mock("@livekit/agents-plugin-assemblyai", () => ({
  STT: vi.fn(
    class {
      updateOptions() {}
    },
  ),
}));
vi.mock("@livekit/agents-plugin-krisp", () => ({
  voiceIsolationTelephony: vi.fn(),
  auth: { livekitCloud: vi.fn() },
}));
vi.mock("../model-config.js", () => ({
  createLlmPair: () => ({ primary: {}, fallback: { model: "fallback" } }),
}));
vi.mock("../tts-runtime.js", () => ({
  createTtsRuntime: () => ({
    provider: "rime",
    optionsByLanguage: { en: { speaker: "test", ttsLanguage: "eng" } },
    tts: {},
  }),
}));
vi.mock("../agent.js", () => ({ createVoiceAgent: () => ({ agent: {} }) }));
vi.mock("../runtime/google-cloud-tracing.js", () => ({
  setupGoogleCloudTracing: vi.fn(),
}));
vi.mock("../runtime/simulation.js", () => ({ startSimulation: vi.fn() }));

function createCall(trunkPhone = "+17275919997") {
  const participant = {
    identity: "sip-caller",
    attributes: {
      "sip.phoneNumber": "+17275551212",
      "sip.trunkPhoneNumber": trunkPhone,
      "sip.callID": "call-test",
    },
  };
  const room = Object.assign(new EventEmitter(), {
    name: "room-test",
    creationTime: new Date(),
    remoteParticipants: new Map([[participant.identity, participant]]),
  });
  const callbacks: Array<() => Promise<unknown>> = [];
  const ctx = {
    room,
    job: { id: "job-test", room: { sid: "room-sid" } },
    connect: vi.fn(async () => undefined),
    waitForParticipant: vi.fn(async () => participant),
    addShutdownCallback: (callback: () => Promise<unknown>) =>
      callbacks.push(callback),
    shutdown: vi.fn(),
    simulationContext: () => null,
    makeSessionReport: () => {
      throw new Error("No report in test");
    },
  };
  return {
    start: () => agentEntry.entry!(ctx as unknown as JobContext),
    close: () => Promise.all(callbacks.map((callback) => callback())),
    disconnect: () => {
      room.remoteParticipants.delete(participant.identity);
      room.emit("participantDisconnected", participant);
    },
    ctx,
  };
}

describe("production call startup", () => {
  let portal: InMemoryCallPortal;
  const calls: ReturnType<typeof createCall>[] = [];
  const call = (trunk?: string) => {
    const value = createCall(trunk);
    calls.push(value);
    return value;
  };
  beforeEach(() => {
    vi.stubEnv("LIVEKIT_AGENT_DEPLOYMENT", "");
    portal = new InMemoryCallPortal();
    vi.spyOn(HttpCallPortal.prototype, "deliver").mockImplementation(
      (delivery) => portal.deliver(delivery),
    );
    vi.spyOn(HttpOwnedMiddleware.prototype, "resolvePatient").mockResolvedValue(
      { status: "not_found" },
    );
    vi.spyOn(AgentSession.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await Promise.all(calls.splice(0).map((value) => value.close()));
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["+19999999999", "not-a-phone-number", ""])(
    "rejects unknown trunk %j without selecting a Product tenant",
    async (trunk) => {
      await expect(call(trunk).start()).rejects.toThrow(
        "Unsupported trunk phone number",
      );
      expect(portal.deliveries).toEqual([]);
      expect(
        HttpOwnedMiddleware.prototype.resolvePatient,
      ).not.toHaveBeenCalled();
      expect(AgentSession.prototype.start).not.toHaveBeenCalled();
    },
  );

  it("records a failed known call even if the STT constructor throws", async () => {
    vi.mocked(STT).mockImplementationOnce(function () {
      throw new Error("STT setup failed");
    });
    const lookup = Promise.withResolvers<{ status: "not_found" }>();
    vi.mocked(HttpOwnedMiddleware.prototype.resolvePatient).mockReturnValue(
      lookup.promise,
    );
    const current = call();
    await expect(current.start()).rejects.toThrow("STT setup failed");
    expect(
      vi.mocked(HttpOwnedMiddleware.prototype.resolvePatient).mock.calls[0]![0]
        .signal?.aborted,
    ).toBe(true);
    lookup.reject(new Error("lookup aborted"));
    await current.close();
    expect(portal.deliveries.map((delivery) => delivery.phase)).toEqual([
      "call-start",
      "shutdown",
    ]);
    expect(portal.deliveries[1]?.payload.status).toBe("FAILED");
    expect(AgentSession.prototype.start).not.toHaveBeenCalled();
  });

  it("overlaps lookup and registration, then starts with lookup applied and closes once", async () => {
    const lookup = Promise.withResolvers<{ status: "not_found" }>();
    const registered = Promise.withResolvers<{ ok: boolean }>();
    vi.mocked(HttpOwnedMiddleware.prototype.resolvePatient).mockReturnValue(
      lookup.promise,
    );
    vi.mocked(HttpCallPortal.prototype.deliver).mockImplementation(
      async (delivery) => {
        await portal.deliver(delivery);
        return delivery.phase === "call-start"
          ? registered.promise
          : { ok: true };
      },
    );
    vi.mocked(AgentSession.prototype.start).mockImplementation(
      async function () {
        expect(this.userData.runtime.preCallLookup.status).toBe("no_match");
      },
    );
    const current = call();
    const starting = current.start();
    await vi.waitFor(() => expect(portal.deliveries).toHaveLength(1));
    expect(HttpOwnedMiddleware.prototype.resolvePatient).toHaveBeenCalledOnce();
    expect(AgentSession.prototype.start).not.toHaveBeenCalled();
    registered.resolve({ ok: true });
    await vi.waitFor(() => expect(STT).toHaveBeenCalledOnce());
    expect(AgentSession.prototype.start).not.toHaveBeenCalled();
    lookup.resolve({ status: "not_found" });
    await starting;
    await current.close();
    expect(AgentSession.prototype.start).toHaveBeenCalledOnce();
    expect(portal.deliveries.map((delivery) => delivery.phase)).toEqual([
      "call-start",
      "shutdown",
    ]);
    expect(portal.deliveries[1]?.payload.status).toBe("COMPLETED");
  });

  it("aborts pending lookup on disconnect before registration finishes", async () => {
    const registered = Promise.withResolvers<{ ok: boolean }>();
    const lookup = Promise.withResolvers<{ status: "not_found" }>();
    vi.mocked(HttpOwnedMiddleware.prototype.resolvePatient).mockReturnValue(
      lookup.promise,
    );
    vi.mocked(HttpCallPortal.prototype.deliver).mockImplementation(
      async (delivery) => {
        await portal.deliver(delivery);
        return delivery.phase === "call-start"
          ? registered.promise
          : { ok: true };
      },
    );
    const current = call();
    const starting = current.start();
    await vi.waitFor(() =>
      expect(
        HttpOwnedMiddleware.prototype.resolvePatient,
      ).toHaveBeenCalledOnce(),
    );
    const signal = vi.mocked(HttpOwnedMiddleware.prototype.resolvePatient).mock
      .calls[0]![0].signal;
    current.disconnect();
    const aborted = signal?.aborted;
    registered.resolve({ ok: true });
    lookup.resolve({ status: "not_found" });
    await expect(starting).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(current.ctx.shutdown).toHaveBeenCalledOnce();
    expect(AgentSession.prototype.start).not.toHaveBeenCalled();
    await current.close();
    expect(portal.deliveries[1]?.payload.status).toBe("FAILED");
  });

  it("retains failure closeout when lookup rejects during registration", async () => {
    const registered = Promise.withResolvers<{ ok: boolean }>();
    vi.mocked(HttpOwnedMiddleware.prototype.resolvePatient).mockRejectedValue(
      new Error("lookup failed"),
    );
    vi.mocked(HttpCallPortal.prototype.deliver).mockImplementation(
      async (delivery) => {
        await portal.deliver(delivery);
        return delivery.phase === "call-start"
          ? registered.promise
          : { ok: true };
      },
    );
    const current = call();
    const starting = current.start();
    const rejected = expect(starting).rejects.toThrow("lookup failed");
    await vi.waitFor(() => expect(portal.deliveries).toHaveLength(1));
    expect(AgentSession.prototype.start).not.toHaveBeenCalled();
    registered.resolve({ ok: true });
    await rejected;
    await current.close();
    expect(portal.deliveries.map((delivery) => delivery.phase)).toEqual([
      "call-start",
      "shutdown",
    ]);
    expect(portal.deliveries[1]?.payload.status).toBe("FAILED");
  });

  it("reports FAILED when session.start rejects after lookup was applied", async () => {
    vi.mocked(AgentSession.prototype.start).mockRejectedValue(
      new Error("session start failed"),
    );
    const current = call();
    await expect(current.start()).rejects.toThrow("session start failed");
    await current.close();
    expect(portal.deliveries[1]?.payload.status).toBe("FAILED");
  });
});
