import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MENTAL_HEALTH_DEMO_CONTENT } from "../customers/abita/mental-health-demo.js";
import {
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
  MENTAL_HEALTH_DEMO_TRUNK_PHONE,
  getOfficeProfileByPhone,
  getProductOfficeKeyByPhone,
} from "../customers/abita/profile.js";
import {
  loadInsuranceReference,
  matchInsurancePlan,
  normalizeInsuranceText,
} from "../insurance-rules.js";
import {
  resolveOfficeKnowledge,
  validateOfficeKnowledgeDocument,
} from "../office-knowledge.js";

const WORKSPACE = join(import.meta.dirname, "..", "..", "workspace");

function readWorkspaceFile(source: string): string {
  return readFileSync(join(WORKSPACE, source), "utf8");
}

describe("mental-health demo content", () => {
  it("keeps the concise trauma-aware introduction in one canonical config", () => {
    const role = readWorkspaceFile(MENTAL_HEALTH_DEMO_CONTENT.roleFile);

    expect(MENTAL_HEALTH_DEMO_CONTENT.greeting).toBe(
      "Hi, you've reached Willowmere Behavioral Health. I'm Maya, the virtual receptionist. What would feel most helpful today?",
    );
    expect(role).toContain(
      `Use this exact introduction: "${MENTAL_HEALTH_DEMO_CONTENT.greeting}"`,
    );
    expect(role).toContain(
      "Leave the caller's trauma history and event details for a clinician.",
    );
    expect(role).toContain("Avoid asking for a diagnosis or trauma narrative.");
    expect(role).toContain(
      "use visitType medical and help the caller book returned demo-account medical slots",
    );
  });

  it("covers the requested administrative, clinical-boundary, and crisis domains", () => {
    const role = readWorkspaceFile(MENTAL_HEALTH_DEMO_CONTENT.roleFile);
    const knowledge = readWorkspaceFile(
      MENTAL_HEALTH_DEMO_CONTENT.knowledgeSource,
    );
    validateOfficeKnowledgeDocument(
      MENTAL_HEALTH_DEMO_CONTENT.knowledgeSource,
      knowledge,
    );

    for (const expected of [
      "New-Patient Therapy",
      "Trauma and PTSD Care",
      "cognitive processing therapy",
      "prolonged exposure therapy",
      "EMDR",
      "Psychiatry and Medication Management",
      "Existing Appointments, Referrals, Records, Forms, and Portal",
      "Prescription and Clinical Concerns",
      "Providers",
      "Oakview Center",
      "Riverbend Center",
      "Meadow Park Center",
      "telehealth",
      "higher-support outpatient program",
      "Office Knowledge: Willowmere Behavioral Health",
      "Reception hours",
      "Billing",
      "911",
      "988",
    ]) {
      expect(knowledge, expected).toContain(expected);
    }

    for (const expected of [
      "Leave diagnosis, symptom interpretation, therapy, coping instruction, medication advice, dose decisions, treatment recommendations, and clinical urgency decisions to licensed clinicians or emergency services.",
      "Immediate danger exits the routine front-desk workflow.",
      "Public websites, directories, and payer logos are not proof of participation or coverage.",
      "Only confirm a booking, cancellation, rescheduling, insurance update, patient creation, staff request, or transfer after the matching currently available action succeeds.",
    ]) {
      expect(role, expected).toContain(expected);
    }
  });

  it("normalizes aliases and separates accepted, verification, unknown, and declined results", () => {
    const reference = loadInsuranceReference(
      MENTAL_HEALTH_DEMO_CONTENT.insuranceSource,
    );

    expect(matchInsurancePlan(reference, "Aetna Choice POS II")).toMatchObject({
      status: "accepted",
      matchedFamily: "Aetna Commercial",
      canProceed: true,
    });
    expect(matchInsurancePlan(reference, "UHC")).toMatchObject({
      status: "needs_clarification",
      canProceed: false,
      clarificationNeeded:
        "the exact UnitedHealthcare or Optum plan name from the insurance card",
    });
    expect(
      matchInsurancePlan(reference, "Example Health Gold 9000"),
    ).toMatchObject({
      status: "needs_clarification",
      matchedAlias: null,
      canProceed: false,
      clarificationNeeded: "the exact plan name from the insurance card",
    });
    expect(matchInsurancePlan(reference, "workers comp")).toMatchObject({
      status: "not_accepted",
      matchedFamily: "Workers' Compensation",
      canProceed: false,
    });

    const ids = reference.plans.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    const allMatchTerms = reference.plans.flatMap((plan) => [
      ...(plan.displayName ? [plan.displayName] : []),
      ...(plan.aliases ?? []),
      ...(plan.requiredWordAliases ?? []),
    ]);
    const normalizedMatchTerms = allMatchTerms.map(normalizeInsuranceText);
    expect(new Set(normalizedMatchTerms).size).toBe(
      normalizedMatchTerms.length,
    );
    for (const plan of reference.plans) {
      const aliases = (plan.aliases ?? []).map(normalizeInsuranceText);
      expect(new Set(aliases).size, plan.id).toBe(aliases.length);
      if (plan.status === "accepted") {
        expect(plan.callerNotice, plan.id).toBeTruthy();
      }
    }
  });

  it("routes its dedicated trunk through the shared demo runtime and Product office", () => {
    const office = getOfficeProfileByPhone(MENTAL_HEALTH_DEMO_TRUNK_PHONE);

    expect(office).toMatchObject({
      amdOfficePhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE,
      displayName: MENTAL_HEALTH_DEMO_CONTENT.displayName,
      greeting: MENTAL_HEALTH_DEMO_CONTENT.greeting,
      key: "mental-health-demo",
      knowledgeSource: MENTAL_HEALTH_DEMO_CONTENT.knowledgeSource,
      trunkPhones: [MENTAL_HEALTH_DEMO_TRUNK_PHONE],
    });
    expect(office.promptSources()).toContainEqual({
      file: MENTAL_HEALTH_DEMO_CONTENT.roleFile,
      tag: "role",
    });
    expect(office.insuranceFor("medical")).toEqual({
      supported: true,
      source: MENTAL_HEALTH_DEMO_CONTENT.insuranceSource,
    });
    expect(office.schedulingFor("medical")).toEqual({ supported: true });
    expect(getProductOfficeKeyByPhone(MENTAL_HEALTH_DEMO_TRUNK_PHONE)).toBe(
      "dev",
    );
  });

  it("keeps behavioral-health retrieval vocabulary isolated from eye offices", () => {
    expect(
      resolveOfficeKnowledge("mental-health-demo", "Do you have a therapist?"),
    ).toMatchObject({ outcome: "matched", topic: "providers" });
    expect(
      resolveOfficeKnowledge("mental-health-demo", "Do you offer EMDR?"),
    ).toMatchObject({ outcome: "matched", topic: "services" });
    expect(
      resolveOfficeKnowledge(
        "mental-health-demo",
        "I am in crisis and might harm myself",
      ),
    ).toMatchObject({ outcome: "matched", topic: "emergency_urgency" });
    for (const [transcript, topic] of [
      ["Which providers are therapists?", "providers"],
      ["Do you offer therapy services?", "services"],
      ["I have an emergency crisis", "emergency_urgency"],
    ] as const) {
      expect(
        resolveOfficeKnowledge("mental-health-demo", transcript),
      ).toMatchObject({ outcome: "matched", topic });
    }

    for (const transcript of [
      "Do you have a therapist?",
      "Do you offer EMDR?",
      "I am in crisis and might harm myself",
    ]) {
      expect(resolveOfficeKnowledge("spring-hill", transcript)).toMatchObject({
        outcome: "skipped",
      });
    }
  });
});
