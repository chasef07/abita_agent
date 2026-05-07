import { describe, expect, it } from "vitest";
import {
  createInitialFlowState,
  guardToolCall,
  hashToolArgs,
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
      allowed: false,
      reason: "routine_vision_crystal_river_requires_route_to_spring_hill",
      toolName: "get_availability",
      createdAt: 123,
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

  it("allows booking for a preloaded phone match after availability", () => {
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
      allowed: true,
      reason: "allowed",
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
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.patientStatus = "verified";
    flow.step = "cancel";

    const observation = guardToolCall({
      flow,
      toolName: "cancel_appt",
    });

    expect(observation).toMatchObject({
      allowed: false,
      reason: "cancel_confirmation_not_tracked",
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
