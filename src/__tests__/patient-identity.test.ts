import { describe, expect, it, vi } from "vitest";
import {
  beginPatientCreation,
  beginNewPatientRegistration,
  commitPatientCreation,
  confirmCandidateFromTranscript,
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
  it("activates only a unique transcript match", async () => {
    const state = createTestCallState({
      preCallCandidates: [verifiedCandidate("one", "Jane", "patient-1")],
    });
    const lookup = vi.fn();

    await expect(
      confirmCandidateFromTranscript(state, "J-A-N-E", lookup),
    ).resolves.toBe("activated");

    expect(lookup).not.toHaveBeenCalled();
    expect(state.identity.activePatient).toMatchObject({
      kind: "existing",
      patientId: "patient-1",
      name: "Jane Doe",
    });
    expect(state.identity.registration).toBeNull();
  });

  it("does not activate an ambiguous transcript match", async () => {
    const state = createTestCallState({
      preCallCandidates: [
        verifiedCandidate("one", "Jane", "patient-1"),
        verifiedCandidate("two", "Jane", "patient-2"),
      ],
    });

    await expect(
      confirmCandidateFromTranscript(state, "Jane", vi.fn()),
    ).resolves.toBe("ambiguous");
    expect(state.identity.activePatient).toBeNull();
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
          appointments: [],
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
    expect(state.runtime.preCallLookup.hydrationOutcome).toBe("incomplete");
  });

  it("preserves the active patient and scoped work when a switch fails", async () => {
    const state = createConfirmedPatientState();
    state.availability.slots = [
      {
        slotId: "slot-1",
        spoken: "tomorrow",
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
      async () => ({ status: "not_found", message: null }),
    );

    expect(state.identity.activePatient?.patientId).toBe("patient-1");
    expect(state.availability.bookingTokensBySlotId).toEqual({
      "slot-1": "private-token",
    });
  });

  it("atomically replaces the patient and clears old patient-scoped work", async () => {
    const state = createConfirmedPatientState();
    state.identity.latestBookedAppointmentId = 42;
    state.availability.bookingTokensBySlotId = { "slot-1": "private-token" };
    state.workflow.current = {
      intent: "schedule",
      appointmentLane: "medical_md",
    };
    state.insurance.lastEligibilityCheck = {
      ...insuranceSnapshot({ plan: "Aetna", coverageType: "medical" }),
      accepted: true,
    };

    const result = await resolveExistingPatient(
      state,
      { firstName: "John", lastName: "Smith", dob: "02/02/1982" },
      async () => verifiedResult("patient-2", "John Smith", "02/02/1982"),
    );

    expect(result.outcome).toBe("switched");
    expect(state.identity.activePatient?.patientId).toBe("patient-2");
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.workflow.current).toBeUndefined();
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
    await expect(
      confirmCandidateFromTranscript(state, "Jane", vi.fn()),
    ).resolves.toBe("unmatched");
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
        allowedProviders: [],
        routingAmbiguous: false,
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
      allowedProviders: [],
      routingAmbiguous: false,
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
        allowedProviders: [],
        routingAmbiguous: false,
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
    appointments: [],
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
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointmentsStatus: "none" as const,
    appointmentsMessage: null,
    appointments: [],
    message: null,
  };
}
