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

  it("treats Blue Cross family names as accepted enough to proceed", () => {
    const result = matchInsurancePlan(reference, "Michigan Blue Cross Blue Shield PPO");
    expect(result.status).toBe("accepted");
    expect(result.canProceed).toBe(true);
    expect(result.needsExactPlanName).toBe(true);
    expect(result.matchedAlias).toBe("Blue Cross");
    expect(result.matchedFamily).toBe("Florida Blue");
    expect(result.callerMessage).toContain("Blue Cross Blue Shield");
  });

  it("matches middleware-backed shorthand aliases that can resolve server side", () => {
    const cases = [
      ["Humana", "Humana PPO"],
      ["Cigna", "Cigna PPO"],
      ["Tricare", "Tricare Select"],
      ["Medicare", "Florida Medicare"],
    ] as const;

    for (const [query, family] of cases) {
      const result = matchInsurancePlan(reference, query);
      expect(result.status).toBe("accepted");
      expect(result.canProceed).toBe(true);
      expect(result.needsExactPlanName).toBe(true);
      expect(result.matchedFamily).toBe(family);
    }
  });

  it("prefers more specific aliases over generic family aliases", () => {
    const bcbsMedicare = matchInsurancePlan(reference, "BCBS Medicare HMO");
    expect(bcbsMedicare.status).toBe("accepted");
    expect(bcbsMedicare.matchedFamily).toBe("Florida Blue Medicare HMO");

    const uhcMedicare = matchInsurancePlan(reference, "UHC Medicare");
    expect(uhcMedicare.status).toBe("accepted");
    expect(uhcMedicare.matchedFamily).toBe("United Healthcare AARP Medicare");
  });

  it("asks for clarification on aliases middleware does not resolve safely", () => {
    const result = matchInsurancePlan(reference, "Molina");
    expect(result.status).toBe("needs_clarification");
    expect(result.canProceed).toBe(false);
    expect(result.clarificationNeeded).toContain("Medicaid");
  });

  it("works through office lookup helper", () => {
    const result = matchInsurancePlanForOffice("spring-hill", "BCBS");
    expect(result.status).toBe("accepted");
    expect(result.canProceed).toBe(true);
    expect(result.matchedFamily).toBe("Florida Blue");
  });
});
