import { describe, expect, it, vi } from "vitest";
import type { PatientResolveVerified } from "../clients/owned-middleware.js";
import {
  activatePatient,
  patientRegistrationStatus,
  resolveExistingPatient,
} from "../identity/patient-identity.js";
import { buildPreCallCandidates } from "../runtime/precall-bootstrap.js";
import { createTestCallState } from "./support/call-state.js";

function patient(name: string): PatientResolveVerified {
  return {
    status: "verified",
    patientId: "patient-synthetic",
    name,
    dob: "01/01/1980",
    phone: null,
    insuranceCarrier: null,
    insPlanId: null,
    respPartyId: null,
    routing: null,
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointmentsStatus: "none",
    appointmentsMessage: null,
    appointments: [],
    message: null,
  };
}

function candidates(name: string) {
  return buildPreCallCandidates({ ...patient(name), phone: "+17275550100" });
}

describe.each(["preload", "lookup", "active"] as const)(
  "existing surname matching through %s",
  (source) => {
    it.each([
      ["Sample Rivera, Jane", "Sample", true],
      ["Sample Rivera, Jane", "Rivera", true],
      ["Sample Rivera, Jane", "Sample Rivera", true],
      ["Sample-Rivera, Jane", "Sample", true],
      ["Sample-Rivera, Jane", "Rivera", true],
      ["Sampleton Rivera, Jane", "Sample", false],
      ["Sample Rivera, Jane", "Smith", false],
      ["Jane Marie Doe", "Marie", false],
      ["Jane Marie Doe", "Marie Doe", true],
      ["Jane O'Neil", "O", false],
      ["Jane O'Neil", "O'Neil", true],
      ["O'Neil, Jane", "O", false],
      ["O'Neil, Jane", "Neil", false],
    ])(
      "record %s and supplied surname %s: accepted=%s",
      async (name, lastName, accepted) => {
        const state = createTestCallState({
          preCallCandidates: source === "preload" ? candidates(name) : [],
        });
        if (source === "active") {
          activatePatient(
            state,
            { ...patient(name), kind: "existing" },
            "resolve_patient",
          );
        }
        const lookup = vi.fn(async () => patient(name));
        const result = await resolveExistingPatient(
          state,
          {
            firstName: "Jane",
            lastName,
            dob: "01/01/1980",
          },
          lookup,
        );
        expect(result.outcome).toBe(accepted ? "verified" : "lookup_failed");
        if (accepted) {
          expect(state.identity.activePatient?.patientId).toBe(
            "patient-synthetic",
          );
          expect(lookup).toHaveBeenCalledTimes(source === "lookup" ? 1 : 0);
        } else if (source !== "active") {
          expect(state.identity.activePatient).toBeNull();
        }
      },
    );
  },
);

it("keeps the surname boundary after activating and clearing the phone candidates", async () => {
  const state = createTestCallState({
    preCallCandidates: candidates("Sample Rivera, Jane"),
  });
  const lookup = vi.fn();
  const identity = { firstName: "Jane", lastName: "Sample" };
  expect((await resolveExistingPatient(state, identity, lookup)).outcome).toBe(
    "verified",
  );
  state.identity.privateCandidates = [];
  expect((await resolveExistingPatient(state, identity, lookup)).outcome).toBe(
    "verified",
  );
  expect(lookup).not.toHaveBeenCalled();
});

it("hydrates a structured compound surname candidate only by its private patient ID", async () => {
  const state = createTestCallState({
    preCallCandidates: buildPreCallCandidates({
      status: "multiple_matches",
      message: "multiple",
      matches: [
        {
          status: "candidate",
          patientId: "patient-synthetic",
          firstName: "Jane",
          lastName: "Sample Rivera",
          dob: "01/01/1980",
        },
      ],
    }),
  });
  const lookup = vi.fn(async () => patient("Sample Rivera, Jane"));
  expect(
    (
      await resolveExistingPatient(
        state,
        { firstName: "Jane", lastName: "Rivera" },
        lookup,
      )
    ).outcome,
  ).toBe("verified");
  expect(lookup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    patientId: "patient-synthetic",
  });
});

it("does not let a surname part override a conflicting DOB", async () => {
  const state = createTestCallState({
    preCallCandidates: candidates("Sample Rivera, Jane"),
  });
  const lookup = vi.fn(async () => patient("Sample Rivera, Jane"));
  expect(
    (
      await resolveExistingPatient(
        state,
        { firstName: "Jane", lastName: "Sample", dob: "02/02/1982" },
        lookup,
      )
    ).outcome,
  ).toBe("lookup_failed");
  expect(state.identity.activePatient).toBeNull();
});

it("preserves ambiguity between candidates sharing a surname part and DOB", async () => {
  const state = createTestCallState({
    preCallCandidates: [
      ...candidates("Sample Rivera, Jane"),
      ...candidates("Sample Lopez, Jane").map((candidate) => ({
        ...candidate,
        patientId: "patient-other",
        ref: "other",
      })),
    ],
  });
  const lookup = vi.fn();
  expect(
    (
      await resolveExistingPatient(
        state,
        { firstName: "Jane", lastName: "Sample", dob: "01/01/1980" },
        lookup,
      )
    ).outcome,
  ).toBe("multiple_matches");
  expect(state.identity.activePatient).toBeNull();
  expect(lookup).not.toHaveBeenCalled();
});

it.each(["Sample", "Rivera"])(
  "guards registration for existing surname part %s",
  (lastName) => {
    const state = createTestCallState({
      preCallCandidates: candidates("Sample Rivera, Jane"),
    });
    expect(
      patientRegistrationStatus(state, {
        firstName: "Jane",
        lastName,
        dob: "01/01/1980",
      }),
    ).toBe("pre_call_candidate");
  },
);
