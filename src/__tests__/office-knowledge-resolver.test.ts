import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OfficeKey } from "../customers/abita/profile.js";
import {
  type OfficeKnowledgeTopic,
  officeKnowledgeReference,
  resolveOfficeKnowledge,
  validateOfficeKnowledgeSources,
} from "../office-knowledge.js";

type TopicFixture = {
  expectedHeading: string;
  language: "en" | "es" | "mixed";
  officeKey: OfficeKey;
  topic: OfficeKnowledgeTopic;
  transcript: string;
};

const topicFixtures: TopicFixture[] = [
  {
    officeKey: "spring-hill",
    transcript: "¿Dónde están ubicados?",
    topic: "location_contact",
    expectedHeading: "## Location and Contact",
    language: "es",
  },
  {
    officeKey: "spring-hill",
    transcript: "What happens after hours?",
    topic: "after_hours",
    expectedHeading: "## After Hours",
    language: "en",
  },
  {
    officeKey: "spring-hill",
    transcript: "¿Qué doctores trabajan allí?",
    topic: "providers",
    expectedHeading: "## Providers",
    language: "es",
  },
  {
    officeKey: "spring-hill",
    transcript: "Do you treat glaucoma?",
    topic: "services",
    expectedHeading: "## Scope of Services",
    language: "en",
  },
  {
    officeKey: "dev",
    transcript: "¿Es un servicio médico o cosmético?",
    topic: "medical_cosmetic",
    expectedHeading: "## Scope of Services",
    language: "es",
  },
  {
    officeKey: "dev",
    transcript: "Do you perform Mohs surgery?",
    topic: "skin_cancer",
    expectedHeading: "## Scope of Services",
    language: "en",
  },
  {
    officeKey: "hollywood",
    transcript: "Do you sell frames?",
    topic: "optical",
    expectedHeading: "## Optical and Glasses",
    language: "en",
  },
  {
    officeKey: "hollywood",
    transcript: "¿Ofrecen lentes de contacto?",
    topic: "contact_lenses",
    expectedHeading: "## Contact Lenses",
    language: "es",
  },
  {
    officeKey: "spring-hill",
    transcript: "Can you repair my frames?",
    topic: "optical_repairs",
    expectedHeading: "## Repairs and Warranty",
    language: "en",
  },
  {
    officeKey: "crystal-river",
    transcript: "Do patients need a referral?",
    topic: "insurance_referrals",
    expectedHeading: "## Insurance and Referrals",
    language: "en",
  },
  {
    officeKey: "north-miami-beach-optical",
    transcript: "¿Cómo puedo pagar?",
    topic: "payment",
    expectedHeading: "## Payments",
    language: "es",
  },
  {
    officeKey: "crystal-river",
    transcript: "How much is a self-pay visit?",
    topic: "pricing",
    expectedHeading: "## Self-Pay Pricing",
    language: "en",
  },
  {
    officeKey: "hollywood",
    transcript: "What is your billing policy?",
    topic: "billing",
    expectedHeading: "## Billing",
    language: "en",
  },
  {
    officeKey: "spring-hill",
    transcript: "¿Qué debo traer a la cita?",
    topic: "preparation",
    expectedHeading: "## What to Bring",
    language: "es",
  },
  {
    officeKey: "spring-hill",
    transcript: "How long is the appointment?",
    topic: "appointment_expectations",
    expectedHeading: "## Appointment Expectations",
    language: "en",
  },
  {
    officeKey: "spring-hill",
    transcript: "Tengo dolor urgente en el ojo.",
    topic: "emergency_urgency",
    expectedHeading: "## Emergency and Urgency",
    language: "es",
  },
  {
    officeKey: "hollywood",
    transcript: "What is your Instagram?",
    topic: "social_follow_up",
    expectedHeading: "## Social Follow-Up",
    language: "en",
  },
  {
    officeKey: "spring-hill",
    transcript: "Necesito la address de la oficina.",
    topic: "location_contact",
    expectedHeading: "## Location and Contact",
    language: "mixed",
  },
  {
    officeKey: "spring-hill",
    transcript: "Cual es su orario?",
    topic: "hours",
    expectedHeading: "## Hours",
    language: "es",
  },
];

const languageParityFixtures = [
  ["after_hours", "What happens after hours?", "¿Qué pasa fuera de horario?"],
  ["hours", "What are your office hours?", "¿Cuál es su horario?"],
  ["location_contact", "What is your address?", "¿Cuál es su dirección?"],
  ["providers", "Which doctors work there?", "¿Qué doctores trabajan allí?"],
  ["services", "What services do you offer?", "¿Qué servicios ofrecen?"],
  ["medical_cosmetic", "Is Botox cosmetic?", "¿El Botox es cosmético?"],
  ["skin_cancer", "Do you treat skin cancer?", "¿Atienden cáncer de piel?"],
  ["optical", "Do you have optical services?", "¿Tienen servicios ópticos?"],
  [
    "contact_lenses",
    "Do you fit contact lenses?",
    "¿Ofrecen lentes de contacto?",
  ],
  ["optical_repairs", "Do you repair glasses?", "¿Pueden reparar mis lentes?"],
  [
    "insurance_referrals",
    "Do patients need a referral?",
    "¿Necesitan los pacientes un referido?",
  ],
  ["pricing", "What is the self-pay price?", "¿Cuánto cuesta sin seguro?"],
  ["payment", "How can I pay?", "¿Cómo puedo pagar?"],
  [
    "billing",
    "What is the billing policy?",
    "¿Cuál es su política de facturación?",
  ],
  ["preparation", "What should I bring?", "¿Qué debo traer?"],
  [
    "appointment_expectations",
    "How long is the appointment?",
    "¿Cuánto dura la cita?",
  ],
  [
    "emergency_urgency",
    "This is an urgent eye problem.",
    "Tengo dolor urgente en el ojo.",
  ],
  [
    "social_follow_up",
    "What is your social media?",
    "¿Cuáles son sus redes sociales?",
  ],
] as const;

describe("Office Knowledge Resolver", () => {
  it.each(topicFixtures)(
    "selects $topic for $language caller text",
    ({ expectedHeading, language, officeKey, topic, transcript }) => {
      const result = resolveOfficeKnowledge(officeKey, transcript);

      expect(result).toMatchObject({
        language,
        outcome: "matched",
        topic,
      });
      expect(result.sections.join("\n")).toContain(expectedHeading);
      expect(result.sections.length).toBeLessThanOrEqual(2);
    },
  );

  it.each(languageParityFixtures)(
    "keeps English and Spanish parity for %s",
    (topic, english, spanish) => {
      expect(resolveOfficeKnowledge("crystal-river", english)).toMatchObject({
        language: "en",
        outcome: expect.stringMatching(/matched|unavailable/),
        topic,
      });
      expect(resolveOfficeKnowledge("crystal-river", spanish)).toMatchObject({
        language: "es",
        outcome: expect.stringMatching(/matched|unavailable/),
        topic,
      });
    },
  );

  it("uses only the immediate exchange for elliptical follow-ups and lets a new topic win", () => {
    const contextual = resolveOfficeKnowledge("spring-hill", "¿Y eso?", [
      "What are your office hours?",
      "I can help with the office schedule.",
    ]);
    const topicChange = resolveOfficeKnowledge(
      "spring-hill",
      "What is your address?",
      ["How much is a self-pay visit?", "Let me explain the supplied pricing."],
    );
    const contextFree = resolveOfficeKnowledge(
      "spring-hill",
      "What about that?",
    );
    const recentOnly = resolveOfficeKnowledge(
      "spring-hill",
      "What about that?",
      [
        "What are your office hours?",
        "The office schedule is available.",
        "What is your billing policy?",
        "I can explain the supplied billing policy.",
      ],
    );
    const confirmation = resolveOfficeKnowledge("spring-hill", "Yes.", [
      "What are your office hours?",
      "Are you asking about the weekday schedule?",
    ]);
    const ownedContext = resolveOfficeKnowledge(
      "spring-hill",
      "What about that?",
      ["Do you accept Aetna insurance?", "Which Aetna plan do you have?"],
    );
    const unsupportedTopic = resolveOfficeKnowledge(
      "spring-hill",
      "How about parking?",
      ["What are your office hours?", "We are open during the week."],
    );
    const prefixedFollowUp = resolveOfficeKnowledge(
      "spring-hill",
      "Well, what about that?",
      ["What are your office hours?", "We are open during the week."],
    );
    const coordinatedFollowUp = resolveOfficeKnowledge(
      "spring-hill",
      "And what about that?",
      ["What are your office hours?", "We are open during the week."],
    );

    expect(contextual).toMatchObject({
      outcome: "matched",
      topic: "hours",
    });
    expect(
      resolveOfficeKnowledge("spring-hill", "What about that?", [
        "What is your address?",
        "Sure.",
      ]),
    ).toMatchObject({
      outcome: "matched",
      topic: "location_contact",
    });
    expect(topicChange).toMatchObject({
      outcome: "matched",
      topic: "location_contact",
    });
    expect(contextFree).toMatchObject({
      outcome: "skipped",
      topic: null,
    });
    expect(recentOnly).toMatchObject({
      outcome: "matched",
      topic: "billing",
    });
    expect(confirmation).toMatchObject({
      outcome: "matched",
      topic: "hours",
    });
    expect(ownedContext).toMatchObject({
      outcome: "skipped",
      topic: null,
    });
    expect(unsupportedTopic).toMatchObject({
      outcome: "skipped",
      topic: null,
    });
    expect(prefixedFollowUp).toMatchObject({
      outcome: "matched",
      topic: "hours",
    });
    expect(coordinatedFollowUp).toMatchObject({
      outcome: "matched",
      topic: "hours",
    });
  });

  it.each([
    "Do you accept Aetna insurance?",
    "What insurance do you take?",
    "Do you participate with Aetna insurance?",
    "Can I use my Aetna insurance here?",
    "Do you carry Aetna insurance?",
    "Will my insurance cover this visit?",
    "Book me an appointment tomorrow.",
    "Book Botox.",
    "Can you cancel my appointment?",
    "I need to reschedule.",
    "Do you have any openings next week?",
    "Schedule Botox.",
    "Schedule cataract surgery.",
    "Schedule a Botox consultation.",
    "Are my glasses ready?",
    "When will my contact lenses arrive?",
    "How much do I owe?",
    "What is the balance on my bill?",
    "What is my account balance?",
    "What is my billing statement?",
    "What is my current bill?",
    "Can I see my patient record?",
    "The weather is lovely today.",
  ])(
    "leaves business operations and unsupported turns to their owners: %s",
    (transcript) => {
      expect(resolveOfficeKnowledge("spring-hill", transcript)).toMatchObject({
        outcome: "skipped",
        topic: null,
      });
    },
  );

  it.each([
    [
      "hollywood",
      "¿Aceptan tarjeta de crédito para pagar?",
      "payment",
      "## Payments",
    ],
    ["hollywood", "I need help paying my bill.", "billing", "## Billing"],
    [
      "spring-hill",
      "¿Ofrecen lentes de contacto?",
      "contact_lenses",
      "## Contact Lenses",
    ],
  ] as const)(
    "routes a production-shaped %s turn to %s",
    (officeKey, transcript, topic, heading) => {
      const result = resolveOfficeKnowledge(officeKey, transcript);

      expect(result).toMatchObject({ outcome: "matched", topic });
      expect(result.sections).toEqual([expect.stringContaining(heading)]);
    },
  );

  it.each([
    ["spring-hill", "Do you treat hair loss?", "services"],
    ["dev", "Do you treat uveitis?", "services"],
    ["dev", "I started seeing flashes.", "emergency_urgency"],
  ] as const)(
    "does not borrow $topic facts from another office: %s",
    (officeKey, transcript, topic) => {
      expect(resolveOfficeKnowledge(officeKey, transcript)).toEqual({
        language: expect.any(String),
        outcome: "unavailable",
        sections: [],
        topic,
      });
    },
  );

  it("distinguishes a supported topic whose active-office fact is unavailable", () => {
    const result = resolveOfficeKnowledge("dev", "What is your Instagram?");

    expect(result).toMatchObject({
      outcome: "unavailable",
      sections: [],
      topic: "social_follow_up",
    });
    if (result.outcome === "skipped") {
      throw new Error("Expected a recognized knowledge topic.");
    }
    const reference = officeKnowledgeReference("dev", result);
    expect(reference).toContain(
      "active office has no supplied information for social_follow_up",
    );
    expect(reference).toContain("do not guess");
  });

  it("validates a sectioned knowledge source for every Office Profile", () => {
    const sources = validateOfficeKnowledgeSources();

    expect(sources).toHaveLength(6);
    expect(sources.map(({ officeKey }) => officeKey).sort()).toEqual(
      [
        "crystal-river",
        "dev",
        "hollywood",
        "north-miami-beach-optical",
        "spring-hill",
        "sweetwater",
      ].sort(),
    );
    expect(sources.every(({ sectionCount }) => sectionCount > 0)).toBe(true);
  });

  it("rejects missing and noncanonical Office Knowledge sources", () => {
    expect(() =>
      validateOfficeKnowledgeSources(() => {
        throw new Error("missing source");
      }),
    ).toThrow("missing source");
    expect(() =>
      validateOfficeKnowledgeSources(() => "# Knowledge without sections"),
    ).toThrow("expected title");
    expect(() => validateOfficeKnowledgeSources(() => "## Empty\n")).toThrow(
      "expected title",
    );
  });

  it.each([
    ["spring-hill", "Is Bach there?"],
    ["dev", "¿Está Bennett allí?"],
  ] as const)(
    "recognizes provider names owned by the active office source",
    (officeKey, transcript) => {
      expect(resolveOfficeKnowledge(officeKey, transcript)).toMatchObject({
        outcome: "matched",
        topic: "providers",
      });
    },
  );

  it.each([
    ["spring-hill", "Abita Eye Group"],
    ["crystal-river", "Eye Radiance"],
    ["hollywood", "Abita Eye Group Hollywood"],
    ["sweetwater", "Abita Eye Group Sweetwater"],
    ["north-miami-beach-optical", "North Miami Beach Optical"],
    ["dev", "Harborleaf Dermatology & Aesthetics"],
  ] as const)(
    "reads office facts only from the active %s Office Profile",
    (officeKey, practiceName) => {
      const result = resolveOfficeKnowledge(officeKey, "What is your address?");

      expect(result).toMatchObject({
        outcome: "matched",
        topic: "location_contact",
      });
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0]).toContain(practiceName);
    },
  );

  it("returns the selected office section verbatim", () => {
    const source = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "workspace",
        "KNOWLEDGE_SWEETWATER.md",
      ),
      "utf8",
    );
    const expectedSection = source
      .slice(
        source.indexOf("## Self-Pay Pricing"),
        source.indexOf("## What to Bring"),
      )
      .trim();

    const result = resolveOfficeKnowledge(
      "sweetwater",
      "What is the self-pay price?",
    );

    expect(result.sections).toEqual([expectedSection]);
  });

  it("normalizes accents, punctuation, casing, and documented ASR variants", () => {
    expect(
      resolveOfficeKnowledge("spring-hill", "¿CUÁL... ES SU DIRECCIÓN?"),
    ).toMatchObject({ outcome: "matched", topic: "location_contact" });
    expect(
      resolveOfficeKnowledge("spring-hill", "cual es su direccion"),
    ).toMatchObject({ outcome: "matched", topic: "location_contact" });
    expect(
      resolveOfficeKnowledge("crystal-river", "Is Lish there?"),
    ).toMatchObject({
      outcome: "matched",
      topic: "providers",
    });
  });

  it.each([
    ["spring-hill", "What time do you close?", "hours"],
    ["spring-hill", "I started seeing flashes.", "emergency_urgency"],
    ["spring-hill", "I have new floaters.", "emergency_urgency"],
    ["spring-hill", "Do you provide eyelid surgery?", "services"],
    ["spring-hill", "Do you treat uveitis?", "services"],
    ["dev", "Do you treat hair loss?", "services"],
  ] as const)(
    "recognizes office-authored caller wording: %s",
    (officeKey, transcript, topic) => {
      expect(resolveOfficeKnowledge(officeKey, transcript)).toMatchObject({
        outcome: "matched",
        topic,
      });
    },
  );

  it("recognizes a caller asking where the office building is", () => {
    expect(
      resolveOfficeKnowledge(
        "sweetwater",
        "Can you remind me where it is, your building?",
      ),
    ).toMatchObject({
      outcome: "matched",
      topic: "location_contact",
    });
  });

  it("does not treat an unrelated building question as a location request", () => {
    expect(
      resolveOfficeKnowledge(
        "sweetwater",
        "Is your building wheelchair accessible?",
      ),
    ).toMatchObject({
      outcome: "skipped",
      topic: null,
    });
  });

  it.each([
    "Can you tell me where your office located?",
    "Where is your office located?",
  ])(
    "recognizes a caller asking where the office is located: %s",
    (transcript) => {
      expect(resolveOfficeKnowledge("sweetwater", transcript)).toMatchObject({
        outcome: "matched",
        topic: "location_contact",
      });
    },
  );

  it.each([
    ["¿A qué hora abren?", "hours"],
    ["¿Están abiertos el sábado?", "hours"],
    ["¿Quiénes son los médicos?", "providers"],
    ["¿Hacen cirugía de cataratas?", "services"],
  ] as const)("recognizes common Spanish phrasing: %s", (transcript, topic) => {
    expect(resolveOfficeKnowledge("spring-hill", transcript)).toMatchObject({
      language: "es",
      outcome: "matched",
      topic,
    });
  });

  it("matches whole tokens without the legacy id substring false positive", () => {
    expect(
      resolveOfficeKnowledge("spring-hill", "What ID should I bring?"),
    ).toMatchObject({ outcome: "matched", topic: "preparation" });
    expect(
      resolveOfficeKnowledge(
        "spring-hill",
        "The candidate selection is unrelated.",
      ),
    ).toMatchObject({ outcome: "skipped", topic: null });
  });

  it("abstains when current-turn topic evidence is ambiguous", () => {
    expect(
      resolveOfficeKnowledge("spring-hill", "Address insurance"),
    ).toMatchObject({ outcome: "skipped", topic: null });
  });

  it("resolves cached turns without network access", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("Office Knowledge must not use the network.");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      resolveOfficeKnowledge("spring-hill", "What are your office hours?");
      expect(
        resolveOfficeKnowledge("spring-hill", "¿Cuál es su horario?"),
      ).toMatchObject({ outcome: "matched", topic: "hours" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
