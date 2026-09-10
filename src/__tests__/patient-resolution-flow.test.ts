import { describe, expect, it } from "vitest";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import { patientModelProjection } from "../identity/patient-identity.js";
import { createTestCallState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

const candidate = {
  status: "verified" as const,
  ref: "synthetic-jane",
  patientId: "synthetic-1",
  firstName: "Jane",
  lastName: "Doe",
  dob: "01/02/1980",
  appointments: [],
  appointmentsStatus: "none" as const,
};

describe("patient resolution conversation contract", () => {
  it("accepts first name and DOB without exposing surname", () => {
    const tool = createResolvePatientTool(new InMemoryOwnedMiddleware());
    expect(Object.keys(tool.parameters.shape)).toEqual(["firstName", "dob"]);
    expect(
      tool.parameters.safeParse({ firstName: "Jane", dob: null }).success,
    ).toBe(true);
  });

  it("acknowledges promotion and tells the next turn DOB is already on file", async () => {
    const middleware = new InMemoryOwnedMiddleware();
    const state = createTestCallState({ preCallCandidates: [candidate] });
    const tool = createResolvePatientTool(middleware);
    const reply = await tool.execute(
      { firstName: "Jane", dob: null } as never,
      {
        ctx: createToolContext(state),
        toolCallId: "promote",
      } as never,
    );
    expect(state.identity.activePatient?.dob).toBe(candidate.dob);
    expect(reply).toContain("I found you in the system, Jane Doe.");
    expect(patientModelProjection(state)).toContain("DOB is already on file");
    expect(patientModelProjection(state)).toContain(
      "Do not ask for or reconfirm",
    );
    expect(middleware.operations).toHaveLength(0);
  });

  it("looks up first name and DOB when phone candidates are absent", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [{ status: "not_found" }],
    });
    const state = createTestCallState();
    const tool = createResolvePatientTool(middleware);
    await tool.execute(
      { firstName: "Jane", dob: "01/02/1980" } as never,
      {
        ctx: createToolContext(state),
        toolCallId: "lookup",
      } as never,
    );
    expect(patientModelProjection(state)).toContain(
      "collect surname only for new-patient chart creation",
    );
    expect(middleware.requests.resolvePatient).toEqual([
      {
        office: state.runtime.trunkPhone,
        identity: { firstName: "Jane", dob: "01/02/1980" },
      },
    ]);
  });

  it("routes a middleware first-name/DOB collision to staff", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [
        {
          status: "multiple_matches",
          matches: [],
        },
      ],
    });
    const state = createTestCallState();
    const tool = createResolvePatientTool(middleware);
    const reply = await tool.execute(
      { firstName: "Jane", dob: candidate.dob },
      {
        ctx: createToolContext(state),
        toolCallId: "fallback-collision",
      } as never,
    );
    expect(reply).toContain("office staff");
    expect(reply).not.toContain("confirm");
    expect(state.identity.activePatient).toBeNull();
  });

  it("uses DOB for different surnames and leaves a first-name/DOB collision unresolved", async () => {
    const middleware = new InMemoryOwnedMiddleware();
    const state = createTestCallState({
      preCallCandidates: [
        candidate,
        {
          ...candidate,
          ref: "second",
          patientId: "synthetic-2",
          lastName: "Smith",
        },
      ],
    });
    const tool = createResolvePatientTool(middleware);
    const options = {
      ctx: createToolContext(state),
      toolCallId: "ambiguous",
    } as never;
    const first = await tool.execute(
      { firstName: "Jane", dob: null } as never,
      options,
    );
    expect(first).toContain("date of birth");
    expect(first).not.toContain("last name");
    const second = await tool.execute(
      { firstName: "Jane", dob: candidate.dob } as never,
      options,
    );
    expect(second).toContain("office staff");
    expect(state.identity.activePatient).toBeNull();
    expect(middleware.operations).toHaveLength(0);
  });
});
