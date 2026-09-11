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
const search = {
  status: "candidates" as const,
  source: "first_name" as const,
  complete: true,
  matches: [candidate],
};

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
          phoneStatus === "verified" ? 0 : phoneStatus === "candidate" ? 1 : 2,
        );
        if (phoneStatus === "absent")
          expect(lookup.mock.calls.map((call) => call[1])).toEqual([
            { firstName: "Jane", dob: identity.dob },
            { patientId: "1" },
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
      const lookup = vi.fn(async () => search);
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
      { patientId: "1" },
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
  it("keeps first-name/DOB collisions ambiguous and reuses search candidates for surname disambiguation", async () => {
    const state = createTestCallState();
    const lookup = vi
      .fn()
      .mockResolvedValueOnce({
        ...search,
        matches: [
          candidate,
          { ...candidate, patientId: "2", lastName: "Smith" },
        ],
      })
      .mockResolvedValueOnce(receipt);
    const result = await resolveExistingPatient(
      state,
      { firstName: "Jane", dob: identity.dob },
      lookup,
    );
    expect(result.outcome).toBe("multiple_matches");
    expect(result.reply).toContain("more than one matching patient");
    expect(state.identity.activePatient).toBeNull();
    expect(
      (await resolveExistingPatient(state, { lastName: "Meyer" }, lookup))
        .outcome,
    ).toBe("verified");
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it.each([[], [candidate]])(
    "refuses incomplete candidate sets %#",
    async (matches) => {
      const state = createTestCallState();
      const lookup = vi.fn(async () => ({
        ...search,
        complete: false,
        matches,
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
  it("does not fuzzy-match a practice-wide prefix result", async () => {
    const state = createTestCallState();
    const lookup = vi.fn(async () => ({
      ...search,
      matches: [{ ...candidate, firstName: "Janet" }],
    }));
    expect(
      (await resolveExistingPatient(state, identity, lookup)).outcome,
    ).toBe("not_found");
    expect(lookup).toHaveBeenCalledOnce();
  });
});
