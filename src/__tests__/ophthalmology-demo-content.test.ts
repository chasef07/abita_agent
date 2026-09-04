import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
  getOfficeProfile,
  getOfficeProfileByPhone,
} from "../customers/abita/profile.js";
import {
  loadInsuranceReference,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";
import {
  resolveOfficeKnowledge,
  validateOfficeKnowledgeDocument,
} from "../office-knowledge.js";
import { buildPrompt } from "../prompt.js";

const WORKSPACE = join(import.meta.dirname, "..", "..", "workspace");

function readWorkspaceFile(source: string): string {
  return readFileSync(join(WORKSPACE, source), "utf8");
}

function readInsurance(source: string): Record<string, unknown> {
  return JSON.parse(readWorkspaceFile(source)) as Record<string, unknown>;
}

function withoutPlans(
  reference: Record<string, unknown>,
  canonicalPlans: ReadonlySet<string>,
): Record<string, unknown> {
  if (!Array.isArray(reference.plans)) {
    throw new Error("Expected an insurance plan list.");
  }
  return {
    ...reference,
    plans: reference.plans.filter((plan) => {
      if (!plan || typeof plan !== "object") return true;
      const canonicalPlan = (plan as Record<string, unknown>).canonicalPlan;
      return (
        typeof canonicalPlan !== "string" || !canonicalPlans.has(canonicalPlan)
      );
    }),
  };
}

describe("ophthalmology demo content", () => {
  it("uses dedicated Clearbrook role and knowledge sources", () => {
    const office = getOfficeProfileByPhone(OPHTHALMOLOGY_DEMO_TRUNK_PHONE);
    const prompt = buildPrompt(OPHTHALMOLOGY_DEMO_TRUNK_PHONE);
    const knowledge = readWorkspaceFile(office.knowledgeSource);
    const role = readWorkspaceFile("SOUL_OPHTHALMOLOGY_DEMO.md");

    expect(office).toMatchObject({
      displayName: "Clearbrook Eye Center",
      greeting:
        "Hey this is Maya at Clearbrook Eye Center. How are you doing today?",
      key: "ophthalmology-demo",
      knowledgeSource: "KNOWLEDGE_OPHTHALMOLOGY_DEMO.md",
      trunkPhones: [OPHTHALMOLOGY_DEMO_TRUNK_PHONE],
    });
    expect(office.promptSources()).toContainEqual({
      file: "SOUL_OPHTHALMOLOGY_DEMO.md",
      tag: "role",
    });
    expect(prompt).toContain("a fictional ophthalmology clinic");
    expect(prompt).toContain("Clearbrook Eye Center");
    expect(prompt).not.toContain("Abita Eye Group");
    validateOfficeKnowledgeDocument(office.knowledgeSource, knowledge);
    expect(knowledge).toContain("Doctor Elena Marlowe");
    expect(knowledge).toContain("Harbor Point Center");
    expect(knowledge).toContain("Cypress Commons Center");
    expect(knowledge).not.toContain("Dr. Bach");
    expect(knowledge).not.toContain("Spring Hill");
    expect(knowledge).not.toContain("abitaeye.com");
    for (const source of [role, knowledge]) {
      expect(source).toContain(
        "New flashes or floaters require immediate transfer to office staff.",
      );
    }
  });

  it("keeps ophthalmology behavior while retrieving only Clearbrook facts", () => {
    const office = getOfficeProfile("ophthalmology-demo");
    const provider = resolveOfficeKnowledge(
      "ophthalmology-demo",
      "Which doctors work there?",
    );
    const location = resolveOfficeKnowledge(
      "ophthalmology-demo",
      "Where are you located?",
    );

    expect(office.schedulingFor("medical")).toEqual({ supported: true });
    expect(office.schedulingFor("routine_vision")).toEqual({
      supported: true,
    });
    expect(provider).toMatchObject({ outcome: "matched", topic: "providers" });
    expect(provider.sections.join("\n")).toContain("Doctor Julian Reyes");
    expect(location).toMatchObject({
      outcome: "matched",
      topic: "location_contact",
    });
    expect(location.sections.join("\n")).toContain("Harbor Point Center");
  });

  it("keeps demo insurance isolated from Spring Hill-only rules", () => {
    const office = getOfficeProfile("ophthalmology-demo");
    const medical = office.insuranceFor("medical");
    const routineVision = office.insuranceFor("routine_vision");

    expect(medical).toEqual({
      supported: true,
      source: "INSURANCE_DEMO_MEDICAL.json",
    });
    expect(routineVision).toEqual({
      supported: true,
      source: "INSURANCE_OPHTHALMOLOGY_DEMO_ROUTINE_VISION.json",
    });
    if (!medical.supported || !routineVision.supported) {
      throw new Error("Expected both Clearbrook insurance lanes.");
    }

    const demoMedical = readInsurance(medical.source);
    const sourceMedical = readInsurance(
      "INSURANCE_SPRING_HILL_CRYSTAL_RIVER.json",
    );
    const springHillOnlyHumanaPlans = new Set([
      "Humana Medicare",
      "Humana Medicaid",
    ]);
    expect({
      ...withoutPlans(demoMedical, springHillOnlyHumanaPlans),
      officeLabel: sourceMedical.officeLabel,
    }).toEqual(withoutPlans(sourceMedical, springHillOnlyHumanaPlans));

    const demoRoutineVision = readInsurance(routineVision.source);
    const sourceRoutineVision = readInsurance(
      "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    );
    expect({
      ...demoRoutineVision,
      officeLabel: sourceRoutineVision.officeLabel,
    }).toEqual(sourceRoutineVision);

    expect(loadInsuranceReference(medical.source).officeLabel).toBe(
      "Medical Demo",
    );
    expect(loadInsuranceReference(routineVision.source).officeLabel).toBe(
      "Clearbrook Eye Center Routine Vision Demo",
    );
    expect(
      matchInsurancePlanForOffice(
        "ophthalmology-demo",
        "Ambetter Premier",
        "medical",
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      matchInsurancePlanForOffice(
        "ophthalmology-demo",
        "VSP",
        "routine_vision",
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      matchInsurancePlanForOffice(
        "ophthalmology-demo",
        "Humana Gold",
        "medical",
      ),
    ).toMatchObject({ status: "not_accepted", callerNotice: null });
    expect(
      matchInsurancePlanForOffice(
        "ophthalmology-demo",
        "Humana Medicare",
        "medical",
      ),
    ).toMatchObject({ status: "accepted", callerNotice: null });
    expect(
      matchInsurancePlanForOffice(
        "ophthalmology-demo",
        "Humana Medicaid",
        "medical",
      ),
    ).toMatchObject({ status: "not_accepted", callerNotice: null });
  });
});
