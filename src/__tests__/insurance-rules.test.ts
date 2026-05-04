import { describe, expect, it } from "vitest";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  loadInsuranceReference,
  matchInsurancePlan,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";
import { getOfficeConfig } from "../offices.js";

describe("insurance matcher", () => {
  const reference = loadInsuranceReference(
    "INSURANCE_SPRING_HILL_CRYSTAL_RIVER.json",
  );
  const crystalRiverReference = loadInsuranceReference(
    "INSURANCE_CRYSTAL_RIVER.json",
  );

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
    const result = matchInsurancePlan(
      reference,
      "Michigan Blue Cross Blue Shield PPO",
    );
    expect(result.status).toBe("accepted");
    expect(result.canProceed).toBe(true);
    expect(result.needsExactPlanName).toBe(true);
    expect(result.matchedAlias).toBe("Blue Cross Blue Shield");
    expect(result.matchedFamily).toBe("Florida Blue");
    expect(result.callerMessage).toBe("yeah we take Blue Cross Blue Shield.");
  });

  it("matches middleware-backed shorthand aliases that can resolve server side", () => {
    const cases = [
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

  it("asks which Humana plan before deciding Spring Hill acceptance", () => {
    const result = matchInsurancePlanForOffice("spring-hill", "Humana");
    expect(result.status).toBe("needs_clarification");
    expect(result.canProceed).toBe(false);
    expect(result.clarificationNeeded).toContain("which Humana plan");
  });

  it("works through office lookup helper", () => {
    const result = matchInsurancePlanForOffice("spring-hill", "BCBS");
    expect(result.status).toBe("accepted");
    expect(result.canProceed).toBe(true);
    expect(result.matchedFamily).toBe("Florida Blue");
  });

  it("uses the routine vision insurance map when requested", () => {
    const cases = [
      ["VSP", "VSP"],
      ["Soltice", "Solstice"],
      ["Lincoln Finacial", "VSP"],
      ["Humana", "EyeMed"],
      ["Humana Gold Plus", "iCare"],
      ["Florida Blue", "Davis"],
      ["United Health Care", "Spectera"],
      ["Simply Medcaid", "iCare"],
      ["CarePlus", "Alivi"],
    ] as const;

    for (const [query, family] of cases) {
      const result = matchInsurancePlanForOffice(
        "spring-hill",
        query,
        "routine_vision",
      );
      expect(result.status, query).toBe("accepted");
      expect(result.canProceed, query).toBe(true);
      expect(canonicalInsurancePlan(result), query).toBe(family);
    }
  });

  it("exposes a canonical middleware plan for accepted family aliases", () => {
    const result = matchInsurancePlan(reference, "Oscar");

    expect(canonicalInsurancePlan(result)).toBe("Oscar Health");
  });

  it("builds a trimmed tool response for the model", () => {
    const result = matchInsurancePlan(reference, "Blue Cross");
    const toolResponse = buildInsuranceToolResponse(result);

    expect(toolResponse).toEqual({
      status: "accepted",
      canProceed: true,
      canonicalPlan: "Florida Blue",
      clarificationNeeded: null,
      callerMessage: "yeah we take Blue Cross Blue Shield.",
    });
  });

  it("uses Crystal River's office-specific insurance map", () => {
    expect(getOfficeConfig("crystal-river").insuranceFile).toBe(
      "INSURANCE_CRYSTAL_RIVER.json",
    );

    const unitedHmo = matchInsurancePlanForOffice(
      "crystal-river",
      "United Healthcare HMO",
    );
    expect(unitedHmo.status).toBe("accepted");
    expect(unitedHmo.matchedFamily).toBe("United Healthcare");

    const humana = matchInsurancePlanForOffice("crystal-river", "Humana PPO");
    expect(humana.status).toBe("not_accepted");
    expect(humana.canProceed).toBe(false);

    const genericHumana = matchInsurancePlanForOffice(
      "crystal-river",
      "Humana",
    );
    expect(genericHumana.status).toBe("needs_clarification");
    expect(genericHumana.clarificationNeeded).toContain("which Humana plan");
    expect(genericHumana.callerMessage).toContain(
      "Crystal River does not accept Humana",
    );

    const blueSelect = matchInsurancePlan(
      crystalRiverReference,
      "I have Florida Blue HMO",
    );
    expect(blueSelect.status).toBe("not_accepted");
  });

  it("keeps Spring Hill Humana acceptance separate from Crystal River", () => {
    const springHillHumana = matchInsurancePlanForOffice(
      "spring-hill",
      "Humana PPO",
    );
    const crystalRiverHumana = matchInsurancePlanForOffice(
      "crystal-river",
      "Humana PPO",
    );

    expect(springHillHumana.status).toBe("accepted");
    expect(crystalRiverHumana.status).toBe("not_accepted");
  });
});
