import { candidateSearchResult } from "./support/owned-middleware.js";
import { describe, expect, it, vi } from "vitest";
import {
  beginPatientCreation,
  beginNewPatientRegistration,
  commitPatientCreation,
  resolveExistingPatient,
} from "../identity/patient-identity.js";
import {
  insuranceSnapshot,
  setLastInsuranceEligibilityCheck,
} from "../scheduling/state.js";
import {
  createConfirmedPatientState,
  createTestCallState,
} from "./support/call-state.js";

describe("patient identity", () => {
  it.each(["02/30/1980", "13/01/1980", "01/01/2999", "1980-01-01"])(
    "rejects invalid DOB %s before reading or activating a record",
    async (dob) => {
      const state = createTestCallState();
      const lookup = vi.fn();
      const result = await resolveExistingPatient(
        state,
        {
          firstName: "Jane",
          lastName: "Doe",
          dob,
        },
        lookup,
      );
      expect(result.outcome).toBe("needs_identity");
      expect(result.reply).toContain("corrected date");
      expect(lookup).not.toHaveBeenCalled();
      expect(state.identity.activePatient).toBeNull();
    },
  );

  it("uses supplied DOB to distinguish shared first names", async () => {
    const state = createTestCallState({
      preCallCandidates: [
        verifiedCandidate("one", "Jane", "patient-1"),
        { ...verifiedCandidate("two", "Jane", "patient-2"), dob: "02/02/1982" },
      ],
    });
    const lookup = vi.fn();
    const ambiguous = await resolveExistingPatient(
      state,
      { firstName: "Jane" },
      lookup,
    );
    expect(ambiguous.outcome).toBe("multiple_matches");
    expect(ambiguous.reply).toContain("date of birth");
    expect(ambiguous.reply).not.toContain("confirm");
    expect(state.identity.activePatient).toBeNull();
    const result = await resolveExistingPatient(
      state,
      {
        firstName: "Jane",
        dob: "02/02/1982",
      },
      lookup,
    );
    expect(result.outcome).toBe("verified");
    expect(state.identity.activePatient?.patientId).toBe("patient-2");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("requests DOB below the threshold and does not promote from surname alone", async () => {
    const state = createTestCallState({
      preCallCandidates: [verifiedCandidate("one", "Jane", "patient-1")],
    });
    const lookup = vi.fn();
    expect(
      await resolveExistingPatient(state, { firstName: "Jame" }, lookup),
    ).toMatchObject({
      outcome: "needs_identity",
      reply: expect.stringContaining("date of birth"),
    });
    expect(state.identity.activePatient).toBeNull();
    expect(
      await resolveExistingPatient(
        state,
        { firstName: "Jame", lastName: "Doe" },
        lookup,
      ),
    ).toMatchObject({
      outcome: "needs_identity",
      reply: expect.stringContaining("date of birth"),
    });
    expect(state.identity.activePatient).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["Amy", "Emmy"],
    ["Jonatham", "Jonathan"],
  ])(
    "promotes a unique qualifying phone match for %s / %s",
    async (provided, stored) => {
      const state = createTestCallState({
        preCallCandidates: [verifiedCandidate("one", stored, "patient-1")],
      });
      const lookup = vi.fn();

      const result = await resolveExistingPatient(
        state,
        { firstName: provided },
        lookup,
      );

      expect(result.outcome).toBe("verified");
      expect(state.identity.activePatient?.patientId).toBe("patient-1");
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Amy", "Emma"],
    ["Ann", "Joanne"],
    ["Alex", "Alexander"],
  ])(
    "does not promote a below-threshold phone match for %s / %s",
    async (provided, stored) => {
      const state = createTestCallState({
        preCallCandidates: [verifiedCandidate("one", stored, "patient-1")],
      });
      const lookup = vi.fn();
      const result = await resolveExistingPatient(
        state,
        { firstName: provided },
        lookup,
      );
      expect(result.outcome).toBe("needs_identity");
      expect(result.reply).toContain("date of birth");
      expect(state.identity.activePatient).toBeNull();
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("does not choose an exact name when another phone candidate also qualifies", async () => {
    const state = createTestCallState({
      preCallCandidates: [
        verifiedCandidate("one", "Amy", "patient-1"),
        verifiedCandidate("two", "Emmy", "patient-2"),
      ],
    });
    const lookup = vi.fn();
    const result = await resolveExistingPatient(
      state,
      { firstName: "Amy" },
      lookup,
    );
    expect(result.outcome).toBe("multiple_matches");
    expect(state.identity.activePatient).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("activates the candidate after the caller spells a below-threshold first name", async () => {
    const state = createTestCallState({
      preCallCandidates: [verifiedCandidate("one", "Jane", "patient-1")],
    });
    const lookup = vi.fn();
    expect(
      (await resolveExistingPatient(state, { firstName: "Jame" }, lookup))
        .outcome,
    ).toBe("needs_identity");
    expect(
      (await resolveExistingPatient(state, { firstName: "J-A-N-E" }, lookup))
        .outcome,
    ).toBe("verified");
    expect(state.identity.activePatient?.patientId).toBe("patient-1");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("requests DOB before distinguishing shared first names by surname", async () => {
    const state = createTestCallState({
      preCallCandidates: [
        verifiedCandidate("one", "Jane", "patient-1"),
        { ...verifiedCandidate("two", "Jane", "patient-2"), lastName: "Smith" },
      ],
    });
    const lookup = vi.fn();
    const result = await resolveExistingPatient(
      state,
      {
        firstName: "Jane",
        lastName: "Smith",
      },
      lookup,
    );
    expect(result.outcome).toBe("multiple_matches");
    expect(state.identity.activePatient).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("hydrates a matching surname variant by patient ID among shared-phone candidates", async () => {
    const state = createTestCallState({
      preCallCandidates: [
        {
          ...verifiedCandidate("one", "Jane", "patient-1"),
          status: "candidate",
          lastName: "Marlow",
        },
        verifiedCandidate("two", "Maria", "patient-2"),
      ],
    });
    const lookup = vi.fn(async () =>
      verifiedResult("patient-1", "Marlow,Jane", "01/01/1980"),
    );

    const result = await resolveExistingPatient(
      state,
      { firstName: "Jane", lastName: "Marlov", dob: "01/01/1980" },
      lookup,
    );

    expect(result.outcome).toBe("verified");
    expect(state.identity.activePatient?.patientId).toBe("patient-1");
    expect(lookup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      patientId: "patient-1",
    });
  });

  it("keeps exact and approximate surname matches ambiguous when first name and DOB agree", async () => {
    const state = createTestCallState({
      preCallCandidates: [
        { ...verifiedCandidate("one", "Jane", "patient-1"), lastName: "Meyer" },
        {
          ...verifiedCandidate("two", "Jane", "patient-2"),
          lastName: "Meyers",
        },
      ],
    });
    const lookup = vi.fn();

    const result = await resolveExistingPatient(
      state,
      { firstName: "Jane", lastName: "Meyer", dob: "01/01/1980" },
      lookup,
    );

    expect(result.outcome).toBe("multiple_matches");
    expect(state.identity.activePatient).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("reuses a matching active patient without collecting identity again", async () => {
    const state = createConfirmedPatientState();
    const lookup = vi.fn();
    expect(
      await resolveExistingPatient(state, { firstName: "Jane" }, lookup),
    ).toMatchObject({
      outcome: "verified",
      reply: "Jane Doe is already the active patient.",
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("activates a unique supplied first name without requesting DOB", async () => {
    const state = createTestCallState({
      preCallCandidates: [verifiedCandidate("one", "Jane", "patient-1")],
    });
    const lookup = vi.fn();

    await expect(
      resolveExistingPatient(state, { firstName: "J-A-N-E" }, lookup),
    ).resolves.toMatchObject({ outcome: "verified" });

    expect(lookup).not.toHaveBeenCalled();
    expect(state.identity.activePatient).toMatchObject({
      kind: "existing",
      patientId: "patient-1",
      name: "Jane Doe",
    });
    expect(state.identity.registration).toBeNull();
  });

  it("does not activate an ambiguous first name", async () => {
    const state = createTestCallState({
      preCallCandidates: [
        verifiedCandidate("one", "Jane", "patient-1"),
        verifiedCandidate("two", "Jane", "patient-2"),
      ],
    });

    await expect(
      resolveExistingPatient(state, { firstName: "Jane" }, vi.fn()),
    ).resolves.toMatchObject({ outcome: "multiple_matches" });
    expect(state.identity.activePatient).toBeNull();
  });

  it("refreshes a matching active pre-call patient after appointment loading failed", async () => {
    const candidate = verifiedCandidate("one", "Jane", "patient-1");
    const state = createConfirmedPatientState({
      preCallCandidates: [candidate],
      activePatient: {
        ...createConfirmedPatientState().identity.activePatient!,
        appointmentsStatus: "error",
      },
    });
    const lookup = vi.fn(async () =>
      verifiedResult("patient-1", "Jane Doe", "01/01/1980"),
    );

    await expect(
      resolveExistingPatient(state, { firstName: "Jane" }, lookup),
    ).resolves.toMatchObject({ outcome: "verified" });

    expect(lookup).toHaveBeenCalledWith(expect.any(String), {
      patientId: "patient-1",
    });
    expect(state.identity.activePatient?.appointmentsStatus).toBe("none");
  });

  it("rejects an invalid verified receipt while hydrating a private candidate", async () => {
    const state = createTestCallState({
      preCallCandidates: [
        {
          status: "candidate",
          ref: "one",
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
          patientId: "patient-1",
          appointments: [] as [],
        },
      ],
    });

    const result = await resolveExistingPatient(
      state,
      { firstName: "Jane" },
      async () => verifiedResult("different-patient", "", "01/01/1980"),
    );

    expect(result).toMatchObject({
      outcome: "lookup_failed",
      failure: { status: "error", reason: "invalid_response" },
    });
    expect(state.identity.activePatient).toBeNull();
  });

  it("hydrates a qualifying fuzzy candidate before promoting it", async () => {
    const state = createTestCallState({
      preCallCandidates: [
        {
          status: "candidate",
          ref: "one",
          firstName: "Emmy",
          dob: "01/01/1980",
          lastName: "Example",
          patientId: "patient-1",
          appointments: [] as [],
        },
      ],
    });
    const lookup = vi.fn(async () =>
      verifiedResult("patient-1", "Emmy Example", "01/01/1980"),
    );

    expect(
      (await resolveExistingPatient(state, { firstName: "Amy" }, lookup))
        .outcome,
    ).toBe("verified");
    expect(lookup).toHaveBeenCalledWith(expect.any(String), {
      patientId: "patient-1",
    });
    expect(state.identity.activePatient?.patientId).toBe("patient-1");
  });

  it("clears the active patient and scoped work when conflicting identity is unresolved", async () => {
    const state = createConfirmedPatientState();
    state.availability.slots = [
      {
        slotId: "slot-1",
        provider: "Doctor Test",
        date: "2026-08-13",
        time: "9:00 AM",
        datetime: "2026-08-13T09:00:00-04:00",
        routing: null,
      },
    ];
    state.availability.bookingTokensBySlotId = { "slot-1": "private-token" };

    await resolveExistingPatient(
      state,
      { firstName: "John", lastName: "Smith", dob: "02/02/1982" },
      async () => candidateSearchResult(),
    );

    expect(state.identity.activePatient).toBeNull();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it("invalidates an unregistered-patient receipt when a preloaded patient is activated", async () => {
    const state = createConfirmedPatientState({
      preCallCandidates: [verifiedCandidate("two", "John", "patient-2")],
    });

    await resolveExistingPatient(
      state,
      { firstName: "Maria", lastName: "Santos", dob: "03/03/1990" },
      async () => candidateSearchResult(),
    );
    expect(state.identity.unregisteredPatientReceipt?.identity).toEqual({
      firstName: "Maria",
      lastName: "Santos",
      dob: "03/03/1990",
    });

    await resolveExistingPatient(state, { firstName: "John" }, async () => {
      throw new Error("The verified preloaded candidate should not reload.");
    });

    expect(state.identity.activePatient?.patientId).toBe("patient-2");
    expect(state.identity.unregisteredPatientReceipt).toBeNull();
  });

  it("atomically replaces the patient and clears old patient-scoped work", async () => {
    const state = createConfirmedPatientState();
    state.availability.bookingTokensBySlotId = { "slot-1": "private-token" };
    state.workflow.visitType = "medical";
    state.insurance.lastEligibilityCheck = {
      ...insuranceSnapshot({ plan: "Aetna", coverageType: "medical" }),
      accepted: true,
    };

    const result = await resolveExistingPatient(
      state,
      { firstName: "John", lastName: "Smith", dob: "02/02/1982" },
      async (_office, query) =>
        "patientId" in query
          ? verifiedResult("patient-2", "John Smith", "02/02/1982")
          : candidateSearchResult(
              verifiedResult("patient-2", "John Smith", "02/02/1982"),
            ),
    );

    expect(result.outcome).toBe("switched");
    expect(state.identity.activePatient?.patientId).toBe("patient-2");
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.workflow.visitType).toBeNull();
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("keeps registration current until a successful chart receipt activates it", async () => {
    const state = createConfirmedPatientState({
      preCallCandidates: [verifiedCandidate("one", "Jane", "patient-1")],
    });
    beginNewPatientRegistration(state, {
      firstName: "New",
      lastName: "Patient",
      dob: "03/03/1990",
    });

    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.registration).toEqual({
      firstName: "New",
      lastName: "Patient",
      dob: "03/03/1990",
    });
    expect(state.identity.activePatient).toBeNull();

    const creation = beginPatientCreation(state);
    expect(creation).not.toBeNull();
    expect(
      commitPatientCreation(state, creation!, {
        status: "error",
        patientId: "must-not-activate",
      } as never),
    ).toMatchObject({ outcome: "failed" });
    expect(state.identity.registration).not.toBeNull();

    const retry = beginPatientCreation(state);
    expect(retry).not.toBeNull();
    expect(
      commitPatientCreation(state, retry!, {
        status: "created",
        patientId: "patient-new",
        name: "New Patient",
        dob: "03/03/1990",
        phone: "+17275551212",
        insuranceCarrier: null,
        insPlanId: null,
        respPartyId: null,
        routing: null,
        preauthRequired: false,
      }),
    ).toMatchObject({ outcome: "activated" });
    expect(state.identity.activePatient).toMatchObject({
      kind: "created",
      patientId: "patient-new",
    });
    expect(state.identity.registration).toBeNull();
  });

  it("keeps a patient creation operation scoped to its originating call", () => {
    const original = createTestCallState();
    const otherCall = createTestCallState();
    const registration = {
      firstName: "New",
      lastName: "Patient",
      dob: "03/03/1990",
    };
    beginNewPatientRegistration(original, registration);
    beginNewPatientRegistration(otherCall, registration);
    const creation = beginPatientCreation(original);
    expect(creation).not.toBeNull();

    const receipt = {
      status: "created" as const,
      patientId: "patient-new",
      name: "New Patient",
      dob: "03/03/1990",
      phone: "+17275551212",
      insuranceCarrier: null,
      insPlanId: null,
      respPartyId: null,
      routing: null,
      preauthRequired: false,
    };
    expect(commitPatientCreation(otherCall, creation!, receipt)).toMatchObject({
      outcome: "invalid_receipt",
    });
    expect(otherCall.identity.activePatient).toBeNull();
    expect(commitPatientCreation(original, creation!, receipt)).toMatchObject({
      outcome: "activated",
    });
    expect(original.identity.activePatient).toMatchObject({
      patientId: "patient-new",
    });
  });

  it("commits the insurance check captured when patient creation began", () => {
    const state = createTestCallState();
    beginNewPatientRegistration(state, {
      firstName: "New",
      lastName: "Patient",
      dob: "03/03/1990",
    });
    setLastInsuranceEligibilityCheck(state, {
      accepted: true,
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
    });
    const creation = beginPatientCreation(state);
    expect(creation).not.toBeNull();
    setLastInsuranceEligibilityCheck(state, {
      accepted: true,
      plan: "VSP",
      canonicalPlan: "VSP",
      coverageType: "routine_vision",
      currentCarrier: "VSP",
    });

    expect(
      commitPatientCreation(state, creation!, {
        status: "created",
        patientId: "patient-new",
        name: "New Patient",
        dob: "03/03/1990",
        phone: "+17275551212",
        insuranceCarrier: null,
        insPlanId: null,
        respPartyId: null,
        routing: null,
        preauthRequired: false,
      }),
    ).toMatchObject({ outcome: "activated" });
    expect(state.insurance.onFile).toEqual({
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });
});

function verifiedCandidate(ref: string, firstName: string, patientId: string) {
  return {
    status: "verified" as const,
    ref,
    firstName,
    lastName: "Doe",
    dob: "01/01/1980",
    patientId,
    appointments: [] as [],
    appointmentsStatus: "none" as const,
  };
}

function verifiedResult(patientId: string, name: string, dob: string) {
  return {
    status: "verified" as const,
    patientId,
    name,
    dob,
    phone: null,
    insuranceCarrier: null,
    insPlanId: null,
    respPartyId: null,
    routing: null,
    preauthRequired: false,
    appointmentsStatus: "none" as const,
    appointmentsMessage: null,
    appointments: [] as [],
    message: null,
  };
}
