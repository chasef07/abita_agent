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
  it("asks for a spelled surname before any non-phone lookup", async () => {
    const state = createTestCallState();
    const lookup = vi.fn().mockResolvedValue(receipt);
    const result = await resolveExistingPatient(
      state,
      { firstName: "Jane", dob: identity.dob },
      lookup,
    );
    expect(result.outcome).toBe("needs_identity");
    expect(result.reply).toContain("spell");
    expect(result.reply).toContain("last name");
    expect(lookup).not.toHaveBeenCalled();
    expect(
      (await resolveExistingPatient(state, { lastName: "Meyer" }, lookup))
        .outcome,
    ).toBe("verified");
    expect(lookup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      firstName: "Jane",
      lastName: "Meyer",
      dob: identity.dob,
    });
  });
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
        lookup.mockResolvedValueOnce(receipt);
        const result = await resolveExistingPatient(
          state,
          phoneStatus === "absent"
            ? { ...supplied, lastName: "Meyer", dob: identity.dob }
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
            { firstName: "Jane", lastName: "Meyer", dob: identity.dob },
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
  it("looks up full identity in one request", async () => {
    const state = createTestCallState();
    const lookup = vi.fn().mockResolvedValue(receipt);
    const supplied = { ...identity, lastName: "Meyer" };
    expect(
      (await resolveExistingPatient(state, supplied, lookup)).outcome,
    ).toBe("verified");
    expect(lookup).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      supplied,
    );
  });
  it.each([
    { ...receipt, dob: "01/01/1990" },
    { ...receipt, name: "Other,Jane" },
    { ...receipt, name: "Meyer,Janet" },
    { ...search, complete: false },
    { status: "error" as const, reason: "middleware_error" as const },
  ])(
    "never activates an invalid or incomplete full-name result %#",
    async (result) => {
      const state = createTestCallState();
      const lookup = vi.fn().mockResolvedValue(result);
      expect(
        (
          await resolveExistingPatient(
            state,
            { ...identity, lastName: "Meyer" },
            lookup,
          )
        ).outcome,
      ).toBe("lookup_failed");
      expect(state.identity.activePatient).toBeNull();
      expect(state.identity.unregisteredPatientReceipt).toBeNull();
    },
  );
  it("keeps full-name collisions ambiguous", async () => {
    const state = createTestCallState();
    const result = await resolveExistingPatient(state, identity, async () => ({
      status: "multiple_matches",
      matches: [candidate, { ...candidate, patientId: "2" }],
    }));
    expect(result.outcome).toBe("multiple_matches");
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.unregisteredPatientReceipt).toBeNull();
  });
  it("records absence only after a completed full-name lookup", async () => {
    const state = createTestCallState();
    expect(
      (
        await resolveExistingPatient(state, identity, async () => ({
          status: "not_found",
        }))
      ).outcome,
    ).toBe("not_found");
    expect(state.identity.unregisteredPatientReceipt?.identity).toEqual(
      identity,
    );
  });
});
