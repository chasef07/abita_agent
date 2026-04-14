import { describe, expect, it } from "vitest";
import { loadInsuranceReference, matchInsurancePlan, matchInsurancePlanForOffice } from "../insurance-rules.js";

describe("insurance matcher", () => {
  const reference = loadInsuranceReference("INSURANCE_SPRING_HILL_CRYSTAL_RIVER.json");

  it("accepts exact accepted plans", () => {
    const result = matchInsurancePlan(reference, "Humana PPO");
    expect(result.status).toBe("accepted");
    expect(result.matchedPlan).toBe("Humana PPO");
    expect(result.canProceed).toBe(true);
    expect(result.needsExactPlanName).toBe(false);
  });

  it("rejects exact not accepted plans", () => {
    const result = matchInsurancePlan(reference, "Care Plus");
    expect(result.status).toBe("not_accepted");
    expect(result.canProceed).toBe(false);
    expect(result.callerMessage).toContain("don't accept");
  });

  it("treats Blue Cross Blue Shield family names as accepted enough to proceed", () => {
    const result = matchInsurancePlan(reference, "Michigan Blue Cross Blue Shield PPO");
    expect(result.status).toBe("accepted");
    expect(result.canProceed).toBe(true);
    expect(result.needsExactPlanName).toBe(true);
    expect(result.matchedAlias).toBe("Blue Cross");
    expect(result.callerMessage).toContain("Blue Cross Blue Shield");
  });

  it("asks for clarification on aliases that require plan type", () => {
    const result = matchInsurancePlan(reference, "Humana");
    expect(result.status).toBe("needs_clarification");
    expect(result.canProceed).toBe(false);
    expect(result.clarificationNeeded).toContain("Gold Plus");
  });

  it("works through office lookup helper", () => {
    const result = matchInsurancePlanForOffice("spring-hill", "BCBS");
    expect(result.status).toBe("accepted");
    expect(result.canProceed).toBe(true);
    expect(result.matchedFamily).toBe("Blue Cross Blue Shield");
  });
});
