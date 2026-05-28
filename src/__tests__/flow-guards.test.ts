import { describe, expect, it } from "vitest";
import {
  createInitialFlowState,
  createPendingBookingAction,
  evaluateFlowToolPolicy,
  guardToolCall,
  hashToolArgs,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  recordAvailabilitySearchRange,
} from "../flow/index.js";

describe("flow report-only guards", () => {
  it("reports Crystal River routine vision availability before routing", () => {
    const flow = createInitialFlowState({ officeKey: "crystal-river" });
    flow.visitType = "routine_vision";
    flow.coverageType = "routine_vision";
    flow.routing = "optical_only";

    const observation = guardToolCall({
      flow,
      toolName: "get_availability",
      stateFacts: { officeKey: "crystal-river" },
      createdAt: 123,
    });

    expect(observation).toMatchObject({
      type: "flow_guard_observation",
      mode: "report_only",
      enforcement: "observe",
      allowed: false,
      reason: "routine_vision_crystal_river_requires_route_to_spring_hill",
      toolName: "get_availability",
      createdAt: 123,
    });
  });

  it("marks runtime policy blocks separately from report-only observations", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.patientStatus = "new";

    const decision = evaluateFlowToolPolicy({
      flow,
      toolName: "add_patient",
    });

    expect(decision).toMatchObject({
      allowed: false,
      observation: {
        mode: "report_only",
        enforcement: "block",
        reason: "new_patient_requires_insurance_check_before_registration",
      },
      outcome: {
        nextStep: "check_insurance",
      },
    });
  });

  it("allows routine vision availability after routing to Spring Hill", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "routine_vision";
    flow.coverageType = "routine_vision";
    flow.routing = "optical_only";

    const observation = guardToolCall({
      flow,
      toolName: "get_availability",
      stateFacts: {
        officeKey: "spring-hill",
        checkedInsurancePlan: "VSP",
      },
    });

    expect(observation).toMatchObject({
      allowed: true,
      reason: "allowed",
    });
  });

  it("does not block read-only availability just because visit type is missing", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const decision = evaluateFlowToolPolicy({
      flow,
      toolName: "get_availability",
      args: { date: "2026-06-01" },
    });

    expect(decision).toMatchObject({
      allowed: true,
      observation: {
        reason: "allowed",
      },
    });
    expect(decision.outcome).toBeUndefined();
  });

  it("reports add_patient before insurance check", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.patientStatus = "new";
    flow.visitType = "medical";

    const observation = guardToolCall({
      flow,
      toolName: "add_patient",
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "new_patient_requires_insurance_check_before_registration",
    });
  });

  it("reports add_patient without checked insurance even if flow is stale", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";

    const observation = guardToolCall({
      flow,
      toolName: "add_patient",
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "new_patient_requires_insurance_check_before_registration",
    });
  });

  it("reports booking without a patient id or verified patient", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.step = "book";

    const observation = guardToolCall({
      flow,
      toolName: "book_appt",
      stateFacts: {
        lastAvailabilityRouting: "all_three",
      },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "booking_requires_verified_or_created_patient",
    });
  });

  it("allows booking for a verified preloaded phone match after availability", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.visitType = "medical";
    flow.step = "book";

    const observation = guardToolCall({
      flow,
      toolName: "book_appt",
      stateFacts: {
        patientId: "patient-1",
        lastAvailabilityRouting: "all_three",
      },
    });

    expect(observation).toMatchObject({
      allowed: true,
      reason: "allowed",
    });
  });

  it("allows booking for a confirmed pre-call patient without verify_patient", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      patientName: "Jane Doe",
      preCall: {
        status: "single_match_confirmed",
        source: "phone_lookup",
        callerPhone: "+17275551212",
        candidates: [
          {
            ref: "caller",
            firstName: "Jane",
            lastName: "Doe",
            dob: "01/01/1980",
            patientId: "patient-1",
            relationshipToCaller: "self",
            appointments: [],
            appointmentsStatus: "none",
          },
        ],
        selectedCandidateRef: "caller",
        identityPromotion: "first_name_confirmed",
      },
    });
    flow.visitType = "medical";
    flow.step = "book";

    const observation = guardToolCall({
      flow,
      toolName: "book_appt",
      stateFacts: {
        lastAvailabilityRouting: "all_three",
      },
    });

    expect(observation).toMatchObject({
      allowed: true,
      reason: "allowed",
    });
  });

  it("allows booking from cached availability when routing is default", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.visitType = "medical";
    flow.coverageType = "medical";
    flow.step = "book";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      coverageType: "medical",
      date: "2026-05-25",
    });
    recordAvailabilityCachedSlots(flow, [{ slotId: "H" }]);
    createPendingBookingAction(flow, {
      slotHash: "H",
      appointmentTypeId: 1007,
      officeKey: "spring-hill",
      spokenSummary: "2026-05-25 9:30 AM with Dr. Noel",
      confirmed: true,
      createdTurnId: "test-booking-action",
      confirmationTurnId: "test-booking-confirmed",
    });

    const decision = evaluateFlowToolPolicy({
      flow,
      toolName: "book_appt",
      args: { slotId: "H", appointmentTypeId: 1007 },
      stateFacts: {
        patientId: "patient-1",
        lastAvailabilityRouting: null,
        officeKey: "spring-hill",
      },
      booking: {
        slotHash: "H",
        appointmentTypeId: 1007,
        officeKey: "spring-hill",
        routing: null,
      },
    });

    expect(decision).toMatchObject({
      allowed: true,
      observation: {
        allowed: true,
        reason: "allowed",
      },
    });
  });

  it("reports booking for an unconfirmed preloaded phone match", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
    });
    flow.visitType = "medical";
    flow.step = "book";

    const observation = guardToolCall({
      flow,
      toolName: "book_appt",
      stateFacts: {
        patientId: "patient-1",
        lastAvailabilityRouting: "all_three",
      },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "booking_requires_verified_or_created_patient",
    });
  });

  it("does not report check_insurance when coverage type is explicit in args", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const observation = guardToolCall({
      flow,
      toolName: "check_insurance",
      args: { plan: "VSP", coverageType: "routine_vision" },
    });

    expect(observation).toMatchObject({
      allowed: true,
      reason: "allowed",
    });
  });

  it("allows check_insurance before visit type or coverage type is known", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const observation = guardToolCall({
      flow,
      toolName: "check_insurance",
      args: { plan: "Care Plus" },
    });

    expect(observation).toMatchObject({
      allowed: true,
      reason: "allowed",
    });
  });

  it("reports booking before availability", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.patientStatus = "verified";
    flow.visitType = "medical";
    flow.step = "book";

    const observation = guardToolCall({
      flow,
      toolName: "book_appt",
      stateFacts: { patientId: "patient-1" },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "booking_requires_recent_availability",
    });
  });

  it("reports cancellation before explicit cancellation confirmation", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      appointments: [
        {
          id: 12345,
          date: "2026-06-01",
          time: "9:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.step = "cancel";

    const observation = guardToolCall({
      flow,
      toolName: "cancel_appt",
      args: { appointmentId: 12345 },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "cancel_confirmation_not_tracked",
    });
  });

  it("reports cancellation for an unconfirmed preloaded phone match", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      appointments: [
        {
          id: 12345,
          date: "2026-06-01",
          time: "9:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });
    flow.step = "cancel";
    flow.pendingConfirmation = {
      type: "cancel",
      payload: { appointmentId: 12345 },
    };

    const observation = guardToolCall({
      flow,
      toolName: "cancel_appt",
      args: { appointmentId: 12345 },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "cancel_requires_verified_or_created_patient",
    });
  });

  it("prioritizes unverified booking over duplicate same-args calls", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
    });
    const args = { slotId: "A", appointmentTypeId: 123 };
    flow.step = "book";
    flow.lastGuardedToolCall = {
      name: "book_appt",
      argsHash: hashToolArgs(args),
      guardAllowed: false,
    };

    const observation = guardToolCall({
      flow,
      toolName: "book_appt",
      args,
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "booking_requires_verified_or_created_patient",
    });
  });

  it("prioritizes unverified cancellation over duplicate same-args calls", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      appointments: [
        {
          id: 12345,
          date: "2026-06-01",
          time: "9:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: true,
        },
      ],
    });
    const args = { appointmentId: 12345 };
    flow.step = "cancel";
    flow.pendingConfirmation = {
      type: "cancel",
      payload: args,
    };
    flow.lastGuardedToolCall = {
      name: "cancel_appt",
      argsHash: hashToolArgs(args),
      guardAllowed: false,
    };

    const observation = guardToolCall({
      flow,
      toolName: "cancel_appt",
      args,
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "cancel_requires_verified_or_created_patient",
    });
  });

  it("reports cancellation before the appointment is loaded", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
    });
    flow.patientStatus = "verified";
    flow.patients.caller.status = "verified";
    flow.step = "cancel";
    flow.pendingConfirmation = {
      type: "cancel",
      payload: { appointmentId: 12345 },
    };

    const observation = guardToolCall({
      flow,
      toolName: "cancel_appt",
      args: { appointmentId: 12345 },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "cancel_requires_loaded_appointment",
    });
  });

  it("reports duplicate same-tool same-args calls", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.lastGuardedToolCall = {
      name: "check_insurance",
      argsHash: hashToolArgs({ coverageType: "medical", plan: "Aetna" }),
      guardAllowed: true,
    };

    const observation = guardToolCall({
      flow,
      toolName: "check_insurance",
      args: { plan: "Aetna", coverageType: "medical" },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "duplicate_tool_call_same_args",
    });
  });

  it("reports duplicate availability search signatures", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });

    const observation = guardToolCall({
      flow,
      toolName: "get_availability",
      args: { date: "2026-06-01", routing: "all_three" },
      stateFacts: { officeKey: "spring-hill" },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "availability_duplicate_search_signature",
      availabilitySearchId: "availability_1",
      availabilityExactSearchCount: 1,
      availabilityDuplicateSearchCount: 1,
    });
  });

  it("reports duplicate availability searches even after slots were cached", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });
    recordAvailabilityCachedSlots(flow, [{ slotId: "A" }]);

    const observation = guardToolCall({
      flow,
      toolName: "get_availability",
      args: { date: "2026-06-01", routing: "all_three" },
      stateFacts: { officeKey: "spring-hill" },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "availability_duplicate_search_signature",
      availabilitySearchId: "availability_1",
      availabilitySearchStatus: "satisfied",
      availabilityExactSearchCount: 1,
      availabilityDuplicateSearchCount: 1,
    });
  });

  it("blocks availability searches inside an already checked date range", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";
    const record = recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });
    recordAvailabilitySearchRange(record.search, {
      outcome: "no_availability",
      searchedFrom: "2026-06-01",
      searchedThrough: "2026-06-15",
    });

    const observation = guardToolCall({
      flow,
      toolName: "get_availability",
      args: { date: "2026-06-08", routing: "all_three" },
      stateFacts: { officeKey: "spring-hill" },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "availability_search_range_already_checked",
      availabilitySearchId: "availability_1",
      availabilityExactSearchCount: 2,
    });
  });

  it("reports exhausted availability search budget", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";
    for (const date of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
      recordAvailabilitySearch(flow, {
        officeKey: "spring-hill",
        visitType: "medical",
        routing: "all_three",
        date,
      });
    }

    const observation = guardToolCall({
      flow,
      toolName: "get_availability",
      args: { date: "2026-06-04", routing: "all_three" },
      stateFacts: { officeKey: "spring-hill" },
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "availability_search_budget_exhausted",
      availabilitySearchStatus: "exhausted",
      availabilityExactSearchCount: 4,
    });
  });

  it("projects availability budget status on the call that reaches the budget", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";
    for (const date of ["2026-06-01", "2026-06-02"]) {
      recordAvailabilitySearch(flow, {
        officeKey: "spring-hill",
        visitType: "medical",
        routing: "all_three",
        date,
      });
    }

    const observation = guardToolCall({
      flow,
      toolName: "get_availability",
      args: { date: "2026-06-03", routing: "all_three" },
      stateFacts: { officeKey: "spring-hill" },
    });

    expect(observation).toMatchObject({
      allowed: true,
      reason: "allowed",
      availabilitySearchStatus: "exhausted",
      availabilityExactSearchCount: 3,
    });
  });

  it("hashes tool args without exposing raw argument values", () => {
    const hash = hashToolArgs({
      coverageType: "medical",
      plan: "Aetna",
      memberId: "secret-member-id",
    });

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("Aetna");
    expect(hash).not.toContain("secret-member-id");
    expect(hash).toBe(
      hashToolArgs({
        memberId: "secret-member-id",
        plan: "Aetna",
        coverageType: "medical",
      }),
    );
  });
});
