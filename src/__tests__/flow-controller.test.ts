import { describe, expect, it } from "vitest";
import {
  classifyVisitType,
  compileFlowContextPacket,
  createInitialFlowState,
  createFlowShadowPrediction,
  nextFlowDecision,
  observeFlowToolExecution,
  prepareSchedulingPath,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  recordPatientVerificationAttempt,
} from "../flow/index.js";

describe("flow state and context packet", () => {
  it("initializes matched patient state from phone lookup without treating it as verified", () => {
    const flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      routing: "all_three",
    });

    expect(flow).toMatchObject({
      activeIntent: null,
      activeFlow: "intro",
      step: "understand_intent",
      patientStatus: "matched",
      activePatientRef: "caller",
      officeKey: "spring-hill",
      routing: "all_three",
      patients: {
        caller: {
          status: "matched",
          patientId: "patient-1",
        },
      },
      pendingActions: [],
      availabilitySearches: [],
    });
  });

  it("compiles a small state packet with allowed and blocked actions", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.activeFlow = "insurance";
    flow.step = "check_insurance";
    flow.visitType = "routine_vision";
    flow.coverageType = "routine_vision";
    flow.requiredSlots = ["insurancePlan"];

    const packet = compileFlowContextPacket(flow);

    expect(packet).toContain("<flow_state>");
    expect(packet).toContain("activeFlow: insurance");
    expect(packet).toContain("activeIntent: unknown");
    expect(packet).toContain("step: check_insurance");
    expect(packet).toContain("activePatient: caller");
    expect(packet).toContain("availabilitySearches: 0");
    expect(packet).toContain("missingSlots: insurancePlan");
    expect(packet).toContain("allowedActions: ask_insurance_plan");
    expect(packet).toContain("prepareSchedulingPath");
    expect(packet).toContain("blockedActions: add_patient");
    expect(packet).toContain("<current_objective>");
  });

  it("records patient verification attempts into canonical patient state", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const patient = recordPatientVerificationAttempt(flow, {
      firstName: "Jane",
      lastName: "Smith",
      dob: "01/02/1980",
    });

    expect(patient).toMatchObject({
      ref: "caller",
      status: "candidate",
      verificationAttempts: 1,
      firstName: {
        value: "Jane",
        source: "caller_spoken",
      },
      lastName: {
        value: "Smith",
        source: "caller_spoken",
      },
      dob: {
        value: "01/02/1980",
      },
    });
    expect(patient.lastVerifiedArgsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(flow.patientStatus).toBe("candidate");
    expect(flow.step).toBe("verify_patient");
  });

  it("records availability search signatures and budget state", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";

    const first = recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
      maxSearches: 2,
    });
    const duplicate = recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
      maxSearches: 2,
    });
    const secondDate = recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-02",
      maxSearches: 2,
    });

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(secondDate.exhausted).toBe(true);
    expect(flow.availabilitySearches[0]).toMatchObject({
      exactSearchCount: 2,
      duplicateSearchCount: 1,
      status: "exhausted",
      failureReasons: ["duplicate_search", "budget_exhausted"],
    });
  });

  it("hydrates cached availability slots on the active search", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });
    flow.visitType = "medical";
    flow.routing = "all_three";
    recordAvailabilitySearch(flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-06-01",
    });

    const search = recordAvailabilityCachedSlots(flow, [
      {
        slotId: "A",
        datetime: "2026-06-01T09:00",
        columnId: 12,
        profileId: 34,
        duration: 15,
      },
    ]);

    expect(search).toMatchObject({
      status: "satisfied",
      cachedSlots: [
        {
          slotHash: "A",
          startDatetime: "2026-06-01T09:00",
          columnId: 12,
          profileId: 34,
          duration: 15,
        },
      ],
    });
  });
});

describe("prepareSchedulingPath", () => {
  it("asks for visit type before checking insurance or scheduling", () => {
    const outcome = prepareSchedulingPath({
      officeKey: "spring-hill",
      patientStatus: "unknown",
    });

    expect(outcome).toMatchObject({
      outcome: "needs_clarification",
      nextStep: "triage_visit_type",
      statePatch: {
        activeFlow: "intent",
        step: "triage_visit_type",
        requiredSlots: ["visitReason"],
      },
    });
  });

  it("routes Crystal River routine vision to Spring Hill before scheduling", () => {
    const outcome = prepareSchedulingPath({
      officeKey: "crystal-river",
      patientStatus: "unknown",
      visitReason: "routine eye exam for glasses",
    });

    expect(outcome).toMatchObject({
      outcome: "route_required",
      nextStep: "route_office",
      facts: {
        visitType: "routine_vision",
        coverageType: "routine_vision",
        allowedOffice: "spring-hill",
        routing: "optical_only",
      },
    });
  });

  it("transfers optical shop tasks instead of scheduling them", () => {
    const outcome = prepareSchedulingPath({
      officeKey: "spring-hill",
      patientStatus: "verified",
      visitReason: "I need to pick up my glasses",
    });

    expect(outcome.outcome).toBe("transfer_required");
    expect(outcome.nextStep).toBe("handoff");
  });

  it("routes Crystal River medical plans accepted at Spring Hill", () => {
    const outcome = prepareSchedulingPath({
      officeKey: "crystal-river",
      patientStatus: "verified",
      visitReason: "glaucoma follow up",
      insurancePlan: "Humana PPO",
      coverageType: "medical",
    });

    expect(outcome).toMatchObject({
      outcome: "route_required",
      nextStep: "route_office",
      facts: {
        allowedOffice: "spring-hill",
        canonicalPlan: "Humana PPO",
        acceptedAtAlternateOffice: "spring-hill",
      },
    });
  });

  it("accepts Spring Hill routine vision insurance and moves to registration for a new patient", () => {
    const outcome = prepareSchedulingPath({
      officeKey: "spring-hill",
      patientStatus: "new",
      visitReason: "annual eye exam",
      insurancePlan: "VSP",
    });

    expect(outcome).toMatchObject({
      outcome: "success",
      nextStep: "collect_registration",
      facts: {
        visitType: "routine_vision",
        coverageType: "routine_vision",
        routing: "optical_only",
        canonicalPlan: "VSP",
      },
    });
  });

  it("classifies urgent symptoms before routine scheduling", () => {
    expect(classifyVisitType("sudden vision loss and severe eye pain")).toBe(
      "urgent",
    );
  });

  it("does not classify a bare insurance question as medical", () => {
    expect(classifyVisitType("do you take Care Plus")).toBeNull();
  });

  it("recognizes Spanish routine vision phrases", () => {
    expect(classifyVisitType("necesito un examen de la vista")).toBe(
      "routine_vision",
    );
  });
});

describe("nextFlowDecision", () => {
  it("asks for visit type before answering a bare insurance question", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const decision = nextFlowDecision({
      state: flow,
      event: {
        type: "caller_intent",
        intent: "insurance_question",
        insurancePlan: "Care Plus",
      },
    });

    expect(decision).toMatchObject({
      type: "ask",
      slot: "visitReason",
    });
  });

  it("requires confirmation before office routing", () => {
    const flow = createInitialFlowState({ officeKey: "crystal-river" });
    const outcome = prepareSchedulingPath({
      officeKey: "crystal-river",
      patientStatus: "unknown",
      visitReason: "routine eye exam",
    });

    const decision = nextFlowDecision({
      state: flow,
      event: {
        type: "tool_outcome",
        toolName: "prepareSchedulingPath",
        outcome,
      },
    });

    expect(decision).toMatchObject({
      type: "confirm",
      confirmation: { type: "route_office" },
    });
  });
});

describe("flow shadow observer", () => {
  it("predicts no tool call for a bare insurance question before visit type is known", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const prediction = createFlowShadowPrediction(
      flow,
      "do you take Care Plus",
      123,
    );
    const observation = observeFlowToolExecution(prediction, "check_insurance");

    expect(prediction.expectedDecision).toMatchObject({
      type: "ask",
      slot: "visitReason",
    });
    expect(prediction.contextPacket).toContain("<flow_state>");
    expect(JSON.stringify(prediction)).not.toContain("Care Plus");
    expect(observation).toMatchObject({
      match: "mismatch",
      toolName: "check_insurance",
      mismatchReason: "expected ask, got tool check_insurance",
    });
  });

  it("marks internal meta-tool predictions as not applicable for live tool comparison", () => {
    const flow = createInitialFlowState({ officeKey: "spring-hill" });

    const prediction = createFlowShadowPrediction(
      flow,
      "I need to schedule a glaucoma follow up",
    );
    const observation = observeFlowToolExecution(prediction, "verify_patient");

    expect(prediction.expectedDecision).toMatchObject({
      type: "call_meta_tool",
      tool: "prepareSchedulingPath",
    });
    expect(observation.match).toBe("not_applicable");
  });
});
