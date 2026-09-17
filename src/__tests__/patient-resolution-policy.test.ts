import { describe, expect, it, vi } from "vitest";
import { resolveExistingPatient } from "../identity/patient-identity.js";
import { createTestCallState } from "./support/call-state.js";

const identity = { firstName: "Jane", lastName: "Smith", dob: "01/01/1980" };
const candidate = {
  status: "candidate" as const,
  patientId: "1",
  firstName: "Jane",
  lastName: "Meyer",
  dob: identity.dob,
};
const receipt = {
  status: "verified" as const,
  patientId: "1",
  name: "Meyer,Jane",
  dob: identity.dob,
  phone: null,
  insuranceCarrier: null,
  insPlanId: null,
  respPartyId: null,
  routing: null,
  preauthRequired: false,
  appointmentsStatus: "none" as const,
  appointmentsMessage: null,
  appointments: [],
  message: null,
};
const search = receipt;

describe("phone-first and spelled-first-name/DOB policy", () => {
  it.each([
    { firstName: "Jane" },
    { firstName: "Jane", lastName: "Meyr" },
    { firstName: "J-A-N-E" },
    { firstName: "J A N E", lastName: "S M I T H" },
  ])(
    "resolves each requested name form %# through phone or first-name/DOB fallback",
    async (supplied) => {
      for (const phoneStatus of ["verified", "candidate", "absent"] as const) {
        const state = createTestCallState({
          preCallCandidates:
            phoneStatus === "absent"
              ? []
              : [
                  {
                    ...candidate,
                    status: phoneStatus,
                    ref: "one",
                    appointments: [],
                    appointmentsStatus: "none",
                  },
                ],
        });
        const lookup = vi.fn();
        if (phoneStatus === "absent") lookup.mockResolvedValueOnce(search);
        lookup.mockResolvedValueOnce(receipt);
        const result = await resolveExistingPatient(
          state,
          phoneStatus === "absent"
            ? { ...supplied, dob: identity.dob }
            : supplied,
          lookup,
        );
        expect(result.outcome).toBe("verified");
        expect(state.identity.activePatient?.patientId).toBe("1");
        expect(lookup).toHaveBeenCalledTimes(
          phoneStatus === "verified" ? 0 : 1,
        );
        if (phoneStatus === "absent")
          expect(lookup.mock.calls.map((call) => call[1])).toEqual([
            { firstName: "Jane", dob: identity.dob },
          ]);
      }
    },
  );

  it.each([
    ["Vagner", "Wagner"],
    ["Meyr", "Meyer"],
    ["Marlov", "Marlow"],
    ["Lopez", "De Garcia Lopez"],
    ["Meyre", "Meyer"],
    ["Garcia-Lopez", "Garcia"],
    ["Smith", "Meyer"],
    ["Yu", "Wu"],
    ["Andersen", "Andorson"],
    ["De", "De Garcia Lopez"],
    ["Garcia Smith", "Garcia Lopez"],
  ])(
    "applies revised unique-phone policy to PR451 surname %s / %s",
    async (provided, stored) => {
      for (const dob of [undefined, identity.dob]) {
        for (const status of ["verified", "candidate"] as const) {
          const state = createTestCallState({
            preCallCandidates: [
              {
                ...candidate,
                firstName: "Jonathan",
                lastName: stored,
                status,
                ref: "one",
                appointments: [],
                appointmentsStatus: "none",
              },
            ],
          });
          const lookup = vi.fn(async () => ({
            ...receipt,
            name: `${stored},Jonathan`,
          }));
          expect(
            (
              await resolveExistingPatient(
                state,
                { firstName: "Jonatham", lastName: provided, dob },
                lookup,
              )
            ).outcome,
          ).toBe("verified");
          expect(state.identity.activePatient?.patientId).toBe("1");
          expect(lookup).toHaveBeenCalledTimes(status === "verified" ? 0 : 1);
        }
      }
    },
  );

  it.each([
    { ...identity, firstName: "Robert" },
    { ...identity, dob: "02/02/1980" },
  ])(
    "keeps first-name and DOB safeguards while ignoring surname %#",
    async (supplied) => {
      const state = createTestCallState({
        preCallCandidates: [
          {
            ...candidate,
            status: "verified",
            ref: "one",
            appointments: [],
            appointmentsStatus: "none",
          },
        ],
      });
      const lookup = vi.fn<Parameters<typeof resolveExistingPatient>[2]>(
        async () => ({ status: "not_found" }),
      );
      expect(
        (await resolveExistingPatient(state, supplied, lookup)).outcome,
      ).toBe("not_found");
      expect(state.identity.activePatient).toBeNull();
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup.mock.calls[0][1]).not.toHaveProperty("patientId");
    },
  );

  it.each([undefined, identity.dob])(
    "ignores volunteered surname on a unique phone match with DOB %s",
    async (dob) => {
      const state = createTestCallState({
        preCallCandidates: [
          {
            ...candidate,
            status: "verified",
            ref: "one",
            appointments: [],
            appointmentsStatus: "none",
          },
        ],
      });
      const lookup = vi.fn();
      expect(
        (
          await resolveExistingPatient(
            state,
            { firstName: "Jane", lastName: "Smith", dob },
            lookup,
          )
        ).outcome,
      ).toBe("verified");
      expect(state.identity.activePatient?.patientId).toBe("1");
      expect(lookup).not.toHaveBeenCalled();
    },
  );
  it("also ignores volunteered surname during hydration of a unique phone match", async () => {
    const state = createTestCallState({
      preCallCandidates: [{ ...candidate, ref: "one", appointments: [] }],
    });
    const lookup = vi.fn(async () => receipt);
    expect(
      (await resolveExistingPatient(state, identity, lookup)).outcome,
    ).toBe("verified");
    expect(lookup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      patientId: "1",
    });
  });
  it("searches first name and DOB without surname, then hydrates within one invocation", async () => {
    const state = createTestCallState();
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(receipt);
    expect(
      (await resolveExistingPatient(state, identity, lookup)).outcome,
    ).toBe("verified");
    expect(lookup.mock.calls.map((call) => call[1])).toEqual([
      { firstName: "Jane", dob: identity.dob },
    ]);
  });
  it("asks for DOB before fallback, preserving the first name", async () => {
    const state = createTestCallState();
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(receipt);
    expect(
      (await resolveExistingPatient(state, { firstName: "J-A-N-E" }, lookup))
        .reply,
    ).toContain("date of birth");
    expect(lookup).not.toHaveBeenCalled();
    expect(
      (await resolveExistingPatient(state, { dob: identity.dob }, lookup))
        .outcome,
    ).toBe("verified");
    expect(lookup.mock.calls[0][1]).toEqual({
      firstName: "Jane",
      dob: identity.dob,
    });
  });
  it("leaves first-name/DOB collisions to middleware and staff", async () => {
    const state = createTestCallState();
    const lookup = vi.fn(async () => ({
      status: "multiple_matches" as const,
      matches: [candidate, { ...candidate, patientId: "2" }],
    }));
    const result = await resolveExistingPatient(state, identity, lookup);
    expect(result.outcome).toBe("multiple_matches");
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.unregisteredPatientReceipt).toBeNull();
    expect(lookup).toHaveBeenCalledOnce();
  });
  it.each([{ matches: [] }, { matches: [candidate] }])(
    "refuses incomplete candidate sets %#",
    async () => {
      const state = createTestCallState();
      const lookup = vi.fn(async () => ({
        status: "unresolved" as const,
        reason: "incomplete_identity",
      }));
      for (let i = 0; i < 2; i++)
        expect(
          (await resolveExistingPatient(state, identity, lookup)).outcome,
        ).toBe("lookup_failed");
      expect(state.identity.activePatient).toBeNull();
      expect(state.identity.unregisteredPatientReceipt).toBeNull();
      expect(lookup).toHaveBeenCalledOnce();
    },
  );
  it("rejects a mismatched middleware receipt", async () => {
    const state = createTestCallState();
    const lookup = vi.fn(async () => ({
      ...receipt,
      name: "Meyer,Janet",
    }));
    expect(
      (await resolveExistingPatient(state, identity, lookup)).outcome,
    ).toBe("lookup_failed");
    expect(lookup).toHaveBeenCalledOnce();
  });
});
