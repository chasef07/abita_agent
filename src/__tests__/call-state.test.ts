import { describe, expect, it } from "vitest";
import {
  appointmentCancelTokenMap,
  publicCallerAppointments,
  upcomingStoredCallerAppointments,
  type StoredCallerAppointment,
} from "../tooling/call-state.js";

describe("call state appointment helpers", () => {
  it("keeps only future appointments and cancel tokens from preloaded context", () => {
    const appointments: StoredCallerAppointment[] = [
      {
        id: 11111,
        date: "2020-01-01",
        time: "9:00 AM",
        provider: "Dr. Bach",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: true,
        cancelToken: "past-token",
      },
      {
        id: 22222,
        date: "2099-01-01",
        time: "9:00 AM",
        provider: "Dr. Bach",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: true,
        cancelToken: "future-token",
      },
    ];

    expect(upcomingStoredCallerAppointments(appointments)).toEqual([
      expect.objectContaining({ id: 22222 }),
    ]);
    expect(publicCallerAppointments(appointments)).toEqual([
      expect.objectContaining({ id: 22222 }),
    ]);
    expect(appointmentCancelTokenMap(appointments)).toEqual({
      "22222": "future-token",
    });
  });
});
