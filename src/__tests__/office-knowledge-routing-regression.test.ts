import { describe, expect, it } from "vitest";
import {
  resolveOfficeKnowledge,
  officeKnowledgeReference,
} from "../office-knowledge.js";

describe("answerable office requests", () => {
  it.each([
    "How much is a doctor visit without insurance?",
    "What do you charge for cash?",
    "Only patients without insurance.",
    "¿Cuánto vale la consulta?",
    "What do you charge for cash? Only patients without insurance.",
    "Can I reschedule after I hear the cost?",
    "¿Cuánto sería el monto a pagar? La consulta.",
    "¿Cómo puedo saber el valor de la consulta?",
  ])("supplies visit pricing for %s", (text) => {
    const result = resolveOfficeKnowledge("hollywood", text);
    expect(result).toMatchObject({ outcome: "matched", topic: "pricing" });
    expect(result.sections.join("\n")).toContain("$250");
  });

  it.each([
    "Optical billing.",
    "Why was I billed for my visit?",
    "What is the balance on my bill?",
    "How much do I owe?",
    "What is my account balance?",
    "What is my billing statement?",
    "What is my current bill?",
    "¿Por qué me cobraron en la visita?",
  ])("supplies the billing contact for %s", (text) => {
    const result = resolveOfficeKnowledge("hollywood", text);
    expect(result).toMatchObject({ outcome: "matched", topic: "billing" });
    expect(result.sections.join("\n")).toContain("(786) 446-8333");
  });

  it.each([
    "Can you email my appointment confirmation?",
    "Can I get my confirmation emailed?",
    "Can you send my confirmation to my email?",
    "Can you email my confirmation after you book the appointment?",
    "¿Me puede enviar la confirmación de mi cita por correo?",
  ])("supplies confirmation expectations for %s", (text) => {
    const result = resolveOfficeKnowledge("hollywood", text);
    expect(result).toMatchObject({
      outcome: "matched",
      topic: "appointment_expectations",
    });
    expect(result.sections.join("\n")).toContain("email confirmation");
  });

  it.each([
    "What will my insurance cover?",
    "How much will my insurance pay?",
    "What does my insurance cost?",
    "Book a routine vision appointment.",
    "Cancel my appointment.",
    "My address has changed.",
  ])("does not substitute office facts for %s", (text) => {
    expect(resolveOfficeKnowledge("hollywood", text).outcome).toBe("skipped");
  });

  it("does not borrow a missing office price or confirmation policy", () => {
    expect(
      resolveOfficeKnowledge(
        "north-miami-beach-optical",
        "What do you charge for cash?",
      ),
    ).toMatchObject({ outcome: "unavailable", topic: "pricing" });
    expect(
      resolveOfficeKnowledge(
        "north-miami-beach-optical",
        "Can you email my confirmation?",
      ),
    ).toMatchObject({
      outcome: "unavailable",
      topic: "appointment_expectations",
    });
  });

  it("prioritizes an emergency over a price question", () => {
    expect(
      resolveOfficeKnowledge(
        "hollywood",
        "This is a medical emergency. How much is a self-pay visit?",
      ),
    ).toMatchObject({ outcome: "matched", topic: "emergency_urgency" });
  });

  it("keeps duration questions separate from Spanish price questions", () => {
    expect(
      resolveOfficeKnowledge("hollywood", "¿Cuánto dura la cita?"),
    ).toMatchObject({ outcome: "matched", topic: "appointment_expectations" });
  });

  it.each([
    "What will my insurance copay be?",
    "How much is my deductible?",
    "¿Cuál es mi copago?",
  ])("separates insurance benefits from self-pay prices: %s", (text) => {
    const result = resolveOfficeKnowledge("hollywood", text);
    expect(result).toMatchObject({
      outcome: "matched",
      topic: "insurance_referrals",
    });
    expect(result.sections.join("\n")).not.toContain("$250");
    if (result.outcome === "skipped")
      throw new Error("Expected insurance guidance");
    expect(officeKnowledgeReference("hollywood", result)).toContain(
      "does not prove benefits",
    );
  });

  it("keeps a split pricing clarification grounded", () => {
    expect(
      resolveOfficeKnowledge("hollywood", "La consulta.", [
        "¿Cuánto sería el monto a pagar?",
      ]),
    ).toMatchObject({ outcome: "matched", topic: "pricing" });
  });

  it("answers an address text request using only the active office", () => {
    const result = resolveOfficeKnowledge(
      "sweetwater",
      "¿Me puede mandar la dirección por mensaje de texto?",
    );
    expect(result).toMatchObject({
      outcome: "matched",
      topic: "location_contact",
    });
    if (result.outcome === "skipped")
      throw new Error("Expected office knowledge");
    const reference = officeKnowledgeReference("sweetwater", result);
    expect(reference).toContain("write down");
    expect(reference).toContain("12750 NW 17th St");
    expect(reference).toContain("active office: Abita Eye Group Sweetwater");
  });
  it.each([
    "Can you text the office address to my phone number?",
    "Can you email the address to my email?",
    "¿Me puede enviar la dirección a mi correo?",
  ])(
    "supplies the office address despite personal delivery details: %s",
    (text) => {
      const result = resolveOfficeKnowledge("hollywood", text);
      expect(result).toMatchObject({
        outcome: "matched",
        topic: "location_contact",
      });
      expect(result.sections.join("\n")).toContain("4330 Sheridan");
    },
  );

  it.each([
    "Why was I charged twice?",
    "I need a refund.",
    "I was overcharged.",
  ])("supplies the billing contact for existing-charge wording: %s", (text) => {
    expect(resolveOfficeKnowledge("hollywood", text)).toMatchObject({
      outcome: "matched",
      topic: "billing",
    });
  });

  it.each([
    ["How much is it to repair my glasses?", "optical_repairs"],
    ["How much do contact lenses cost?", "contact_lenses"],
    ["How long is the appointment?", "appointment_expectations"],
    ["How much time should I allow?", "appointment_expectations"],
    [
      "How much time should I allow for the appointment?",
      "appointment_expectations",
    ],
    ["How much time does the appointment take?", "appointment_expectations"],
  ])(
    "preserves specific office facts instead of visit rates: %s",
    (text, topic) => {
      const result = resolveOfficeKnowledge("hollywood", text);
      expect(result).toMatchObject({ outcome: "matched", topic });
      expect(result.sections.join("\n")).not.toContain("$250");
    },
  );

  it("retrieves the supplied retinal-photo charge", () => {
    const result = resolveOfficeKnowledge(
      "hollywood",
      "What is the charge for retinal photos?",
    );
    expect(result).toMatchObject({
      outcome: "matched",
      topic: "insurance_referrals",
    });
    expect(result.sections.join("\n")).toContain("$39");
  });
  it.each([
    "What is the charge for retinal photos at my visit?",
    "What is the charge for retinal photos during my exam?",
  ])("keeps the specific photo fee when a visit is mentioned: %s", (text) => {
    const result = resolveOfficeKnowledge("hollywood", text);
    expect(result).toMatchObject({
      outcome: "matched",
      topic: "insurance_referrals",
    });
    expect(result.sections.join("\n")).toContain("$39");
    expect(result.sections.join("\n")).not.toContain("$250");
  });

  it("preserves a specific pricing topic on the immediate follow-up", () => {
    const result = resolveOfficeKnowledge("hollywood", "Yes.", [
      "How much do contact lenses cost?",
    ]);
    expect(result).toMatchObject({
      outcome: "matched",
      topic: "contact_lenses",
    });
    expect(result.sections.join("\n")).not.toContain("$250");
  });
});

// The reference participates in the real model turn; it must not override task taxonomy.
describe("task responsibility guidance", () => {
  it("distinguishes service authorization from medication PA and records release", () => {
    const resolution = resolveOfficeKnowledge(
      "spring-hill",
      "I need prior authorization status.",
    );
    const text = officeKnowledgeReference("spring-hill", resolution);
    expect(text).toContain("insurance");
    expect(text).toContain("medication");
    expect(text).toContain("documentation");
    expect(text).toContain("clarify");
    expect(text).not.toContain("existing referrals category");
  });
});
