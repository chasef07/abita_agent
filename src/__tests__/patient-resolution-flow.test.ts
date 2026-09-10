import { describe, expect, it } from "vitest";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
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

  it("returns the patient acknowledgment without exposing DOB", async () => {
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
    expect(reply).toContain("I found you in our system, Jane Doe.");
    expect(reply).toContain("DOB is on file. Do not ask for DOB.");
    expect(reply).not.toContain(candidate.dob);
    expect(middleware.operations).toHaveLength(0);
  });

  it("looks up first name and DOB when phone candidates are absent", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [
        {
          status: "candidates",
          source: "first_name",
          complete: true,
          matches: [],
        },
      ],
    });
    const state = createTestCallState();
    const tool = createResolvePatientTool(middleware);
    const firstNameReply = await tool.execute(
      { firstName: "Jane", dob: null },
      { ctx: createToolContext(state), toolCallId: "first-name" } as never,
    );
    expect(firstNameReply).toContain("date of birth");
    expect(middleware.operations).toEqual([]);
    expect(state.identity.activePatient).toBeNull();
    await tool.execute(
      { firstName: "Jane", dob: "01/02/1980" } as never,
      {
        ctx: createToolContext(state),
        toolCallId: "lookup",
      } as never,
    );
    expect(state.identity.activePatient).toBeNull();
    expect(middleware.requests.resolvePatient).toEqual([
      {
        office: state.runtime.trunkPhone,
        identity: { firstName: "Jane", dob: "01/02/1980" },
      },
    ]);
  });

  it("asks for DOB after an unmatched first name, then accepts clarified phone-match identity", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [
        {
          status: "candidates",
          source: "first_name",
          complete: true,
          matches: [],
        },
      ],
    });
    const state = createTestCallState({ preCallCandidates: [candidate] });
    const tool = createResolvePatientTool(middleware);
    const options = {
      ctx: createToolContext(state),
      toolCallId: "clarify",
    } as never;
    const first = await tool.execute({ firstName: "Jame", dob: null }, options);
    expect(first).toContain("date of birth");
    expect(middleware.operations).toHaveLength(0);
    const second = await tool.execute(
      { firstName: "Jame", dob: "02/02/1980" },
      options,
    );
    expect(second).toContain("couldn't find a matching patient");
    expect(state.identity.activePatient).toBeNull();
    const corrected = await tool.execute(
      { firstName: "J-A-N-E", dob: candidate.dob },
      options,
    );
    expect(corrected).toContain("I found you in our system, Jane Doe");
    expect(state.identity.activePatient?.patientId).toBe(candidate.patientId);
  });

  it("requests identity clarification and a retry for a middleware collision", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [
        {
          status: "candidates",
          source: "first_name",
          complete: true,
          matches: [
            candidate,
            { ...candidate, patientId: "synthetic-2", ref: "second" },
          ],
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
    expect(reply).toBe("I found more than one matching patient.");
    expect(tool.description).toContain(
      "clarify DOB and first-name spelling and retry before offering staff",
    );
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
    expect(second).toBe("I found more than one matching patient.");
    expect(state.identity.activePatient).toBeNull();
    expect(middleware.operations).toHaveLength(0);
  });
});
