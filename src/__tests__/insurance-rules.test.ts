import { describe, expect, it } from "vitest";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  loadInsuranceReference,
  matchInsurancePlan,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";
import { getOfficeConfig } from "../customer/profile.js";

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
    expect(result.callerFacingPlan).toBe("Blue Cross Blue Shield");
    expect(result.callerMessage).toBe("Yes, we take Blue Cross Blue Shield.");
  });

  it("matches middleware-backed shorthand aliases that can resolve server side", () => {
    const cases = [
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

  it("rejects the current Spring Hill medical do-not-accept plans", () => {
    const cases = [
      "Aetna EPO",
      "Humana Gold Plus",
      "Miami Children's",
      "Humana Medicaid",
      "Fl Blue Select",
      "Miami Dade Ddoctors Health",
      "Av Med Medicare Advantage",
      "Optimum Medicare Advantage",
      "Cigna Local Plus",
      "Eye America",
      "Fl Blue HMO",
      "Fl Blue Steward",
      "Molina Marketplace",
      "Preferred Care Partners",
    ];

    for (const plan of cases) {
      const result = matchInsurancePlanForOffice("spring-hill", plan);
      expect(result.status, plan).toBe("not_accepted");
      expect(result.canProceed, plan).toBe(false);
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

  it("rejects Optimum before the generic Medicare alias can match", () => {
    const cases = [
      ["spring-hill", "Optimum Medicare Advantage"],
      ["spring-hill", "Optimum"],
      ["spring-hill", "Optimum Florida Blue California"],
      ["crystal-river", "Optimum Medicare Advantage"],
      ["crystal-river", "Optimum"],
      ["crystal-river", "Optimum Florida Blue California"],
    ] as const;

    for (const [office, query] of cases) {
      const result = matchInsurancePlanForOffice(office, query, "medical");
      expect(result.status, `${office} ${query}`).toBe("not_accepted");
      expect(result.canProceed, `${office} ${query}`).toBe(false);
      expect(canonicalInsurancePlan(result), `${office} ${query}`).toBeNull();
    }
  });

  it("asks for clarification on aliases middleware does not resolve safely", () => {
    const cignaHmo = matchInsurancePlan(reference, "I have Cigna HMO");
    expect(cignaHmo.status).toBe("accepted");
    expect(cignaHmo.matchedFamily).toBe("Cigna HMO");

    const cignaLocalPlus = matchInsurancePlan(
      reference,
      "I have Cigna Local Plus",
    );
    expect(cignaLocalPlus.status).toBe("not_accepted");

    const cigna = matchInsurancePlan(reference, "Cigna");
    expect(cigna.status).toBe("needs_clarification");
    expect(cigna.clarificationNeeded).toContain("which Cigna plan");

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

  it("maps Spring Hill medical Sunshine plans to Envolve", () => {
    const cases = ["Sunshine", "Sunshine Health", "Sunshine Medicaid"];

    for (const query of cases) {
      const result = matchInsurancePlanForOffice("spring-hill", query);
      expect(result.status, query).toBe("accepted");
      expect(result.canProceed, query).toBe(true);
      expect(canonicalInsurancePlan(result), query).toBe("Envolve Vision");
      expect(result.callerFacingPlan, query).toBe(query);
    }
  });

  it("maps Hollywood and Sweetwater medical Sunshine plans to Envolve", () => {
    const offices = ["hollywood", "sweetwater"] as const;
    const cases = ["Sunshine", "Sunshine Health", "Sunshine Medicaid"];

    for (const office of offices) {
      for (const query of cases) {
        const result = matchInsurancePlanForOffice(office, query);
        expect(result.status, `${office} ${query}`).toBe("accepted");
        expect(result.canProceed, `${office} ${query}`).toBe(true);
        expect(canonicalInsurancePlan(result), `${office} ${query}`).toBe(
          "Envolve Vision",
        );
        expect(result.callerFacingPlan, `${office} ${query}`).toBe(query);
      }
    }
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
      ["Optimum", "iCare"],
      ["Optimum Healthcare", "iCare"],
      ["CarePlus", "Alivi"],
      ["Oscar", "Oscar"],
      ["I have Oscar", "Oscar"],
      ["Self Pay", "Self Pay"],
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

  it("keeps caller speech separate from routine vision canonical aliases", () => {
    const result = matchInsurancePlanForOffice(
      "spring-hill",
      "Ambetter",
      "routine_vision",
    );

    expect(result.status).toBe("accepted");
    expect(canonicalInsurancePlan(result)).toBe("Envolve");
    expect(result.callerFacingPlan).toBe("Ambetter");
    expect(result.callerMessage).toBe("Yes, we take Ambetter.");
  });

  it("accepts self-pay as a medical option", () => {
    const result = matchInsurancePlanForOffice("spring-hill", "self-pay");

    expect(result.status).toBe("accepted");
    expect(result.canProceed).toBe(true);
    expect(canonicalInsurancePlan(result)).toBe("Self Pay");
  });

  it("builds a trimmed tool response for the model", () => {
    const result = matchInsurancePlan(reference, "Blue Cross");
    const toolResponse = buildInsuranceToolResponse(result);

    expect(toolResponse).toEqual({
      status: "accepted",
      canProceed: true,
      callerFacingPlan: "Blue Cross Blue Shield",
      clarificationNeeded: null,
      callerMessage: "Yes, we take Blue Cross Blue Shield.",
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

    const aetnaCommercial = matchInsurancePlanForOffice(
      "crystal-river",
      "Aetna Commercial",
    );
    expect(aetnaCommercial.status).toBe("accepted");
    expect(aetnaCommercial.matchedFamily).toBe("Aetna Commercial");

    const aetnaEpo = matchInsurancePlanForOffice("crystal-river", "Aetna EPO");
    expect(aetnaEpo.status).toBe("not_accepted");
    expect(aetnaEpo.canProceed).toBe(false);

    const ambetter = matchInsurancePlanForOffice("crystal-river", "Ambetter");
    expect(ambetter.status).toBe("not_accepted");
    expect(ambetter.canProceed).toBe(false);

    const sunshine = matchInsurancePlanForOffice("crystal-river", "Sunshine");
    expect(sunshine.status).toBe("not_accepted");
    expect(sunshine.canProceed).toBe(false);

    const sunshineHealth = matchInsurancePlanForOffice(
      "crystal-river",
      "Sunshine Health",
    );
    expect(sunshineHealth.status).toBe("not_accepted");
    expect(sunshineHealth.canProceed).toBe(false);

    const simply = matchInsurancePlanForOffice(
      "crystal-river",
      "Simply Medicaid",
    );
    expect(simply.status).toBe("not_accepted");
    expect(simply.canProceed).toBe(false);

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

    const genericCigna = matchInsurancePlanForOffice("crystal-river", "Cigna");
    expect(genericCigna.status).toBe("needs_clarification");
    expect(genericCigna.clarificationNeeded).toContain("which Cigna plan");

    const cignaHmo = matchInsurancePlanForOffice("crystal-river", "Cigna HMO");
    expect(cignaHmo.status).toBe("accepted");
    expect(cignaHmo.matchedFamily).toBe("Cigna HMO");

    const blueSelect = matchInsurancePlan(
      crystalRiverReference,
      "I have Florida Blue HMO",
    );
    expect(blueSelect.status).toBe("not_accepted");
  });

  it("keeps Crystal River Cigna medical rules aligned with Spring Hill", () => {
    const cases = [
      "Cigna",
      "Cigna HMO",
      "Cigna Medicare Advantage",
      "Cigna Open Access",
      "Cigna PPO",
      "Cigna Local Plus",
      "Cigna Miami-Dade Public Schools",
    ];

    for (const query of cases) {
      const springHillResult = matchInsurancePlanForOffice(
        "spring-hill",
        query,
      );
      const crystalRiverResult = matchInsurancePlanForOffice(
        "crystal-river",
        query,
      );

      expect(crystalRiverResult.status, query).toBe(springHillResult.status);
      expect(crystalRiverResult.canProceed, query).toBe(
        springHillResult.canProceed,
      );
      expect(canonicalInsurancePlan(crystalRiverResult), query).toBe(
        canonicalInsurancePlan(springHillResult),
      );
      expect(crystalRiverResult.clarificationNeeded, query).toBe(
        springHillResult.clarificationNeeded,
      );
    }
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

  it("uses the Hollywood and Sweetwater medical insurance map", () => {
    expect(getOfficeConfig("hollywood").insuranceFile).toBe(
      "INSURANCE_HOLLYWOOD_SWEETWATER.json",
    );
    expect(getOfficeConfig("sweetwater").insuranceFile).toBe(
      "INSURANCE_HOLLYWOOD_SWEETWATER.json",
    );

    const hollywoodAetnaEpo = matchInsurancePlanForOffice(
      "hollywood",
      "Aetna EPO",
    );
    expect(hollywoodAetnaEpo.status).toBe("accepted");
    expect(canonicalInsurancePlan(hollywoodAetnaEpo)).toBe("Aetna EPO");

    const sweetwaterCarePlus = matchInsurancePlanForOffice(
      "sweetwater",
      "Care Plus",
    );
    expect(sweetwaterCarePlus.status).toBe("accepted");
    expect(canonicalInsurancePlan(sweetwaterCarePlus)).toBe(
      "CarePlus Medicare Medical",
    );

    const hollywoodBlueSelect = matchInsurancePlanForOffice(
      "hollywood",
      "Florida Blue Select",
    );
    expect(hollywoodBlueSelect.status).toBe("not_accepted");
    expect(hollywoodBlueSelect.canProceed).toBe(false);

    const hollywoodCigna = matchInsurancePlanForOffice("hollywood", "Cigna");
    expect(hollywoodCigna.status).toBe("needs_clarification");
    expect(hollywoodCigna.canProceed).toBe(false);
    expect(hollywoodCigna.clarificationNeeded).toContain("which Cigna plan");

    const sweetwaterMolina = matchInsurancePlanForOffice(
      "sweetwater",
      "Molina",
    );
    expect(sweetwaterMolina.status).toBe("needs_clarification");
    expect(sweetwaterMolina.canProceed).toBe(false);
    expect(sweetwaterMolina.clarificationNeeded).toContain("Medicaid");

    const hollywoodHumana = matchInsurancePlanForOffice("hollywood", "Humana");
    expect(hollywoodHumana.status).toBe("accepted");
    expect(canonicalInsurancePlan(hollywoodHumana)).toBe("Humana PPO");
  });

  it("uses the routine vision insurance map for Hollywood and Sweetwater", () => {
    const hollywoodVsp = matchInsurancePlanForOffice(
      "hollywood",
      "VSP",
      "routine_vision",
    );
    const sweetwaterVsp = matchInsurancePlanForOffice(
      "sweetwater",
      "VSP",
      "routine_vision",
    );

    expect(hollywoodVsp.status).toBe("accepted");
    expect(canonicalInsurancePlan(hollywoodVsp)).toBe("VSP");
    expect(sweetwaterVsp.status).toBe("accepted");
    expect(canonicalInsurancePlan(sweetwaterVsp)).toBe("VSP");
  });
});
