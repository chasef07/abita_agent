import { describe, expect, it } from "vitest";
import { activatePreloadedCandidate } from "../identity/preloaded-patient.js";
import { createTestCallState } from "./support/call-state.js";
import {
  activePatientId,
  activatePatient,
  resetPatientScopedWork,
} from "../state/identity.js";
import {
  applySchedulingLaneToState,
  availabilitySlotsForState,
  lastInsuranceEligibilityCheck,
  storeAvailabilityBookingToken,
} from "../state/scheduling.js";

function createState() {
  const state = createTestCallState({
    patientId: "patient-1",
    patientName: "Jane Doe",
    dob: "01/01/1980",
    insuranceCarrier: "self pay",
    insPlanId: null,
    respPartyId: null,
    checkedInsurancePlan: "self pay",
    checkedInsuranceCoverageType: "medical",
    routing: "all_three",
    lastAvailabilityRouting: "all_three",
    lastAvailabilitySlots: [],
    allowedProviders: [],
  });
  state.identity.patient.identityConfirmed = true;
  return state;
}

describe("identity state", () => {
  it("clears all patient-scoped work through one transition", () => {
    const state = createState();
    applySchedulingLaneToState(state, "medical_md");
    state.availability.slots = [
      {
        slotId: "S1",
        spoken: "June 1 at 9:00 AM with Doctor Smith",
        provider: "Doctor Smith",
        date: "2026-06-01",
        time: "9:00 AM",
        datetime: "2026-06-01T09:00:00",
        routing: "all_three",
      },
    ];
    storeAvailabilityBookingToken(state, "S1", "private-token");
    state.identity.latestBookedAppointmentId = 123;
    state.insurance.lastEligibilityCheck = {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
      accepted: true,
    };

    resetPatientScopedWork(state);

    expect(activePatientId(state)).toBe("patient-1");
    expect(availabilitySlotsForState(state)).toEqual([]);
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(lastInsuranceEligibilityCheck(state)).toBeNull();
    expect(state.workflow.current).toBeUndefined();
  });

  it("activates a different patient and replaces patient-scoped work", () => {
    const state = createState();
    applySchedulingLaneToState(state, "medical_md");
    storeAvailabilityBookingToken(state, "S1", "private-token");
    state.identity.latestBookedAppointmentId = 123;

    activatePatient(state, {
      status: "verified",
      patientId: "patient-2",
      name: "John Doe",
      dob: "02/02/1982",
      phone: "+17275551213",
      appointments: [],
      appointmentsStatus: "none",
      insuranceCarrier: "Florida Blue",
      insPlanId: "plan-2",
      respPartyId: "party-2",
      routing: "bach_only",
      allowedProviders: ["Doctor Bach"],
      routingAmbiguous: false,
      preauthRequired: false,
    });

    expect(activePatientId(state)).toBe("patient-2");
    expect(state.identity.patient.name).toBe("John Doe");
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(state.workflow.routing.routing).toBe("bach_only");
  });

  it("clears patient-scoped work when confirming the preloaded active patient", () => {
    const state = createState();
    applySchedulingLaneToState(state, "medical_md");
    storeAvailabilityBookingToken(state, "S1", "private-token");
    state.identity.latestBookedAppointmentId = 123;
    const candidate = {
      ref: "caller",
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      patientId: "patient-1",
      appointments: [],
      appointmentsStatus: "none" as const,
    };
    state.identity.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: state.runtime.callerPhone,
      candidates: [candidate],
      selectedCandidateRef: candidate.ref,
      identityPromotion: "none",
    };

    activatePreloadedCandidate(state, candidate, "confirmed_by_transcript");

    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(state.workflow.current).toBeUndefined();
  });
});
