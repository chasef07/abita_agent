import { describe, expect, it } from "vitest";
import {
  completedCancellations,
  latestBookedAppointmentId,
  removeActiveAppointment,
  replaceActiveAppointments,
  setLatestBookedAppointment,
} from "../state/appointments.js";
import { createTestCallState } from "./support/call-state.js";

describe("appointment state", () => {
  it("owns appointment references and completed cancellations", () => {
    const state = createTestCallState();
    const appointment = {
      id: 123,
      date: "June 1, 2026",
      time: "9:00 AM",
      provider: "Doctor Smith",
      type: "Follow-up",
      facility: "Spring Hill",
      confirmed: true,
    };

    state.identity.patient.identityConfirmed = true;
    state.identity.patient.patientId = "patient-1";
    replaceActiveAppointments(state, [appointment], "found");
    setLatestBookedAppointment(state, appointment.id);

    removeActiveAppointment(state, appointment.id);

    expect(latestBookedAppointmentId(state)).toBeNull();
    expect(state.identity.patient.appointments).toEqual([]);
    expect(completedCancellations(state)).toEqual([
      { patientId: "patient-1", appointment },
    ]);
  });
});
