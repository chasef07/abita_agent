import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
  getOfficeProfile,
  getOfficeProfiles,
  getOfficeProfileByPhone,
} from "../customers/abita/profile.js";
import {
  loadInsuranceReference,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";
import { buildPrompt } from "../prompt.js";

const WORKSPACE = join(import.meta.dirname, "..", "..", "workspace");

function readWorkspaceFile(source: string): string {
  return readFileSync(join(WORKSPACE, source), "utf8");
}

describe("ophthalmology demo content", () => {
  it("keeps the dedicated Frantz role and office identity", () => {
    const office = getOfficeProfileByPhone(OPHTHALMOLOGY_DEMO_TRUNK_PHONE);
    const prompt = buildPrompt(OPHTHALMOLOGY_DEMO_TRUNK_PHONE);
    const role = readWorkspaceFile("SOUL_OPHTHALMOLOGY_DEMO.md");

    expect(office).toMatchObject({
      displayName: "Frantz EyeCare",
      greeting: "Hi, this is Maya at Frantz EyeCare. How can I help?",
      key: "ophthalmology-demo",
      trunkPhones: [OPHTHALMOLOGY_DEMO_TRUNK_PHONE],
    });
    expect(office.promptSources()).toContainEqual({
      file: "SOUL_OPHTHALMOLOGY_DEMO.md",
      tag: "role",
    });
    expect(prompt).toContain("an ophthalmology clinic");
    expect(prompt).toContain("Frantz EyeCare");
    expect(prompt).not.toContain("Abita Eye Group");
    expect(prompt).toContain("# Appointment Triage");
    expect(role).toContain(
      "New flashes or floaters require immediate transfer to office staff.",
    );
  });

  it("keeps Frantz content exclusive to its one phone route", () => {
    for (const office of getOfficeProfiles()) {
      for (const phone of office.trunkPhones) {
        const prompt = buildPrompt(phone);
        if (phone === OPHTHALMOLOGY_DEMO_TRUNK_PHONE) {
          expect(prompt).toContain("Frantz EyeCare");
          expect(prompt).toContain("booked for five months");
          expect(prompt).not.toContain("fictional ophthalmology");
        } else {
          expect(prompt).not.toContain("Frantz EyeCare");
          expect(prompt).not.toContain("booked for five months");
        }
      }
    }
  });

  it("retains both eye-care scheduling lanes after migration", () => {
    const office = getOfficeProfile("ophthalmology-demo");
    expect(office.schedulingFor("medical")).toEqual({ supported: true });
    expect(office.schedulingFor("routine_vision")).toEqual({ supported: true });
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
      throw new Error("Expected both Frantz insurance lanes.");
    }

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
