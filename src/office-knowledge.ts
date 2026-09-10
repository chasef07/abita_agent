import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getOfficeProfile,
  getOfficeProfiles,
  type OfficeKey,
} from "./customers/abita/profile.js";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");
const MAX_SELECTED_SECTIONS = 2;
// Current-turn evidence must clear both a floor and the next-best topic.
// Recent context is eligible only when the current turn has no topic signal.
const MIN_TOPIC_SCORE = 3;
const MIN_TOPIC_MARGIN = 2;
const knowledgeCache = new Map<OfficeKey, OfficeKnowledgeIndex>();
const phraseNeedleCache = new Map<string, string>();
export const OFFICE_KNOWLEDGE_SCHEMA_VERSION =
  "abita-office-knowledge/v1" as const;
const CANONICAL_HEADINGS = [
  "Emergency and Urgency",
  "Location and Contact",
  "Hours",
  "After Hours",
  "Scope of Services",
  "Providers",
  "Optical and Glasses",
  "Contact Lenses",
  "Repairs and Warranty",
  "Insurance and Referrals",
  "Payments",
  "Billing",
  "Self-Pay Pricing",
  "What to Bring",
  "Appointment Expectations",
  "Social Follow-Up",
  "Limitations",
] as const;

export type OfficeKnowledgeLanguage = "en" | "es" | "mixed" | "unknown";

export type OfficeKnowledgeTopic =
  | "after_hours"
  | "appointment_expectations"
  | "billing"
  | "contact_lenses"
  | "emergency_urgency"
  | "hours"
  | "insurance_referrals"
  | "location_contact"
  | "medications"
  | "medical_cosmetic"
  | "optical"
  | "optical_repairs"
  | "payment"
  | "preparation"
  | "pricing"
  | "providers"
  | "services"
  | "skin_cancer"
  | "social_follow_up";

type KnowledgeSection = {
  body: string;
  normalizedBody: string;
  title: string;
};

type OfficeKnowledgeIndex = {
  providerNames: string[];
  sections: KnowledgeSection[];
};

type TopicDefinition = {
  aliases: Array<
    readonly [phrase: string, weight: number, sourceTerms?: readonly string[]]
  >;
  officeKeys?: readonly OfficeKey[];
  sectionTitles: string[];
  topic: OfficeKnowledgeTopic;
};

type RankedTopic = {
  definition: TopicDefinition;
  score: number;
  sourceSections: KnowledgeSection[];
  sourceSupported: boolean;
};

export type OfficeKnowledgeResolution =
  | {
      language: OfficeKnowledgeLanguage;
      outcome: "matched";
      sections: string[];
      topic: OfficeKnowledgeTopic;
    }
  | {
      language: OfficeKnowledgeLanguage;
      outcome: "unavailable";
      sections: [];
      topic: OfficeKnowledgeTopic;
    }
  | {
      language: OfficeKnowledgeLanguage;
      outcome: "skipped";
      sections: [];
      topic: null;
    };

const TOPICS: TopicDefinition[] = [
  topic(
    "after_hours",
    ["After Hours"],
    [
      ["after hours", 6],
      ["afterhours", 6],
      ["outside office hours", 6],
      ["fuera de horario", 6],
      ["despues del horario", 6],
      ["cuando estan cerrados", 6],
      ["on call", 4],
    ],
  ),
  topic(
    "hours",
    ["Hours"],
    [
      ["business hours", 5],
      ["office hours", 5],
      ["horario", 4],
      ["orario", 4],
      ["horarios", 4],
      ["horas", 3],
      ["hours", 3],
      ["when are you open", 5],
      ["what time do you close", 6],
      ["when do you close", 5],
      ["closing time", 5],
      ["cuando abren", 5],
      ["a que hora abren", 5],
      ["cuando cierran", 5],
      ["hasta que hora trabajan", 5],
      ["estan abiertos", 5],
      ["abierto", 3],
      ["abiertos", 3],
      ["cerrado", 3],
      ["cerrados", 3],
      ["open", 3],
      ["closed", 3],
    ],
  ),
  topic(
    "location_contact",
    ["Location and Contact"],
    [
      ["where are you located", 6],
      ["where are you guys", 5],
      ["which office is this", 5],
      ["donde estan ubicados", 6],
      ["donde se encuentran", 6],
      ["your building", 2],
      ["where it is", 2],
      ["office located", 4],
      ["location", 3],
      ["ubicacion", 3],
      ["address", 4],
      ["addresses", 4],
      ["office addresses", 5],
      ["direccion", 4],
      ["directions", 3],
      ["your zip code", 5],
      ["office zip code", 5],
      ["zip code for the office", 5],
      ["cross street", 5, ["cross street"]],
      ["phone number", 4],
      ["numero de telefono", 4],
      ["telefono", 3],
      ["fax", 3],
      ["email", 3],
      ["correo electronico", 4],
      ["contact information", 4],
    ],
  ),
  topic(
    "location_contact",
    ["Location and Contact"],
    [
      ["is this brightview", 6],
      ["is this bright view", 6],
      ["is this the brightview", 6],
      ["is this the bright view", 6],
      ["did i reach brightview", 6],
      ["did i reach bright view", 6],
      ["es brightview", 6],
      ["es bright view", 6],
    ],
    ["north-miami-beach-optical"],
  ),
  topic(
    "providers",
    ["Providers"],
    [
      ["which doctors", 5],
      ["what doctors", 5],
      ["que doctores", 5],
      ["cuales doctores", 5],
      ["quienes son los medicos", 5],
      ["doctor", 3],
      ["doctora", 3],
      ["doctores", 3],
      ["medico", 3],
      ["medicos", 3],
      ["provider", 3],
      ["providers", 3],
      ["proveedor", 3],
      ["proveedores", 3],
      ["optometrist", 3],
      ["optometrista", 3],
      ["ophthalmologist", 3],
      ["oftalmologo", 3],
      ["dermatologist", 3],
      ["dermatologo", 3],
      ["rheumatologist", 3],
      ["rheumatologists", 3],
      ["reumatologo", 3],
      ["reumatologos", 3],
    ],
  ),
  topic(
    "skin_cancer",
    ["Scope of Services"],
    [
      ["mohs", 6],
      ["skin cancer", 6],
      ["cancer de piel", 6],
      ["biopsy", 4],
      ["biopsia", 4],
      ["suspicious mole", 5],
      ["lunar sospechoso", 5],
      ["skin check", 5],
      ["skin checks", 5],
      ["suspicious lesion", 5],
      ["lesion evaluation", 5],
    ],
  ),
  topic(
    "medical_cosmetic",
    ["Scope of Services"],
    [
      ["medical or cosmetic", 6, ["medical or cosmetic"]],
      ["medico o cosmetico", 6, ["medical or cosmetic"]],
      ["cosmetic", 4, ["cosmetic"]],
      ["cosmetico", 4, ["cosmetic"]],
      ["aesthetic", 4, ["aesthetic", "cosmetic"]],
      ["estetico", 4, ["aesthetic", "cosmetic"]],
      ["botox", 5, ["botox"]],
      ["dysport", 5, ["dysport"]],
      ["dermal filler", 5, ["dermal fillers"]],
      ["relleno dermico", 5, ["dermal fillers"]],
      ["microneedling", 5, ["microneedling"]],
      ["chemical peel", 5, ["chemical peels"]],
      ["facial", 4, ["facials"]],
      ["facials", 4, ["facials"]],
      ["dermaplaning", 5, ["dermaplaning"]],
      ["ipl", 5, ["ipl"]],
      ["laser hair removal", 6, ["laser hair removal"]],
      ["skin resurfacing", 5, ["skin resurfacing"]],
      ["skincare", 4, ["skincare"]],
      ["med spa", 5, ["med spa"]],
    ],
  ),
  topic(
    "medications",
    ["Scope of Services"],
    [
      ["medication", 4, ["medication education"]],
      ["medications", 4, ["medication education"]],
      ["medicine", 4, ["medication education"]],
      ["methotrexate", 6, ["methotrexate"]],
      ["dmard", 6, ["disease modifying antirheumatic drug"]],
      ["dmards", 6, ["disease modifying antirheumatic drug"]],
      ["biologic", 5, ["biologics"]],
      ["biologics", 5, ["biologics"]],
      ["prednisone", 5, ["prednisone"]],
      ["hydroxychloroquine", 6, ["hydroxychloroquine"]],
      ["plaquenil", 6, ["hydroxychloroquine"]],
      ["lab monitoring", 6, ["laboratory monitoring"]],
      ["blood tests", 5, ["blood-test monitoring"]],
      ["stop medication", 6, ["holding a medication"]],
      ["stop my medication", 6, ["holding a medication"]],
      ["hold medication", 6, ["holding a medication"]],
      ["hold my medication", 6, ["holding a medication"]],
      ["combine medications", 6, ["combine medicines"]],
      ["combine my medications", 6, ["combine medicines"]],
      ["medications be combined", 6, ["combine medicines"]],
      ["take together", 6, ["combine medicines"]],
    ],
    ["rheumatology-demo"],
  ),
  topic(
    "services",
    ["Scope of Services"],
    [
      ["what services", 5],
      ["que servicios", 5],
      ["services", 3],
      ["servicios", 3],
      ["cataract", 4, ["cataract"]],
      ["cataracts", 4, ["cataract"]],
      ["catarata", 4, ["cataract"]],
      ["cataratas", 4, ["cataract"]],
      ["cirugia de cataratas", 6, ["cataract"]],
      ["glaucoma", 4, ["glaucoma"]],
      ["retina", 4, ["retina"]],
      ["routine eye exam", 5, ["routine eye exam", "eye exam"]],
      ["eye exams", 5, ["eye exam", "vision exam"]],
      ["vision exam", 5, ["vision exam", "eye exam"]],
      ["vision exams", 5, ["vision exam", "eye exam"]],
      ["comprehensive eye exam", 6, ["comprehensive eye exam"]],
      ["comprehensive eye exams", 6, ["comprehensive eye exam"]],
      ["diabetic eye exam", 6, ["diabetic eye exam", "diabetic eye care"]],
      ["diabetic eye exams", 6, ["diabetic eye exam", "diabetic eye care"]],
      ["do you see children", 5, ["pediatric", "children"]],
      ["lasik", 6, ["lasik"]],
      ["examen de la vista", 5, ["routine eye exam", "eye exam"]],
      ["ophthalmology", 4, ["ophthalmology"]],
      ["oftalmologia", 4, ["ophthalmology"]],
      ["uveitis", 5, ["uveitis"]],
      ["strabismus", 5, ["strabismus"]],
      ["estrabismo", 5, ["strabismus"]],
      ["double vision", 5, ["double vision"]],
      ["vision doble", 5, ["double vision"]],
      ["eye misalignment", 5, ["eye misalignment"]],
      ["oculoplastic", 5, ["oculoplastic"]],
      ["eyelid", 4, ["eyelid"]],
      ["eyelid surgery", 6, ["eyelid", "oculoplastic"]],
      ["eyelid procedures", 6, ["eyelid", "oculoplastic"]],
      ["cirugia de parpados", 6, ["eyelid", "oculoplastic"]],
      ["thyroid eye disease", 5, ["thyroid eye disease"]],
      ["diabetic eye care", 5, ["diabetic eye care"]],
      ["pediatric", 4, ["pediatric"]],
      ["pediatrico", 4, ["pediatric"]],
      ["dermatology", 4, ["dermatology"]],
      ["dermatologia", 4, ["dermatology"]],
      ["medical dermatology", 5, ["medical dermatology"]],
      ["dermatologic surgery", 5, ["dermatologic surgery"]],
      ["acne", 4, ["acne"]],
      ["eczema", 4, ["eczema"]],
      ["dermatitis", 4, ["dermatitis"]],
      ["psoriasis", 4, ["psoriasis"]],
      ["rosacea", 4, ["rosacea"]],
      ["rash", 4, ["rash", "rashes"]],
      ["rashes", 4, ["rash", "rashes"]],
      ["sarpullido", 4, ["rash", "rashes"]],
      ["skin infection", 5, ["skin infection", "skin infections"]],
      ["skin infections", 5, ["skin infection", "skin infections"]],
      ["hair loss", 5, ["hair loss"]],
      ["perdida de cabello", 5, ["hair loss"]],
      ["nail disorder", 5, ["nail disorder", "nail disorders"]],
      ["nail disorders", 5, ["nail disorder", "nail disorders"]],
      ["warts", 4, ["warts"]],
      ["verrugas", 4, ["warts"]],
      ["skin tags", 5, ["skin tags"]],
      ["mole evaluation", 5, ["mole evaluation"]],
      ["full body skin exam", 5, ["full body skin examinations"]],
      ["rheumatology", 4, ["rheumatology"]],
      ["reumatologia", 4, ["rheumatology"]],
      ["rheumatoid arthritis", 6, ["rheumatoid arthritis"]],
      ["artritis reumatoide", 6, ["rheumatoid arthritis"]],
      ["osteoarthritis", 5, ["osteoarthritis"]],
      ["osteoartritis", 5, ["osteoarthritis"]],
      ["lupus", 5, ["lupus"]],
      ["psoriatic arthritis", 6, ["psoriatic arthritis"]],
      ["artritis psoriasica", 6, ["psoriatic arthritis"]],
      ["ankylosing spondylitis", 6, ["ankylosing spondylitis"]],
      ["espondilitis anquilosante", 6, ["ankylosing spondylitis"]],
      ["gout", 5, ["gout"]],
      ["gota", 5, ["gout"]],
      ["osteoporosis", 5, ["osteoporosis"]],
      ["vasculitis", 5, ["vasculitis"]],
      ["myositis", 5, ["myositis"]],
      ["scleroderma", 5, ["scleroderma"]],
      ["sjogren", 5, ["sjogren"]],
      ["fibromyalgia", 5, ["fibromyalgia"]],
      ["infusion", 5, ["infusions"]],
      ["infusions", 5, ["infusions"]],
      ["infusion therapy", 6, ["infusions"]],
      ["joint injection", 6, ["injections"]],
      ["joint injections", 6, ["injections"]],
      ["diagnostic ultrasound", 6, ["diagnostic ultrasound"]],
    ],
  ),
  topic(
    "optical_repairs",
    ["Repairs and Warranty"],
    [
      ["glasses repair", 6],
      ["repair glasses", 6],
      ["repair my frames", 6],
      ["broken glasses", 6],
      ["warranty", 5],
      ["reparar mis lentes", 6],
      ["lentes rotos", 6],
      ["garantia", 5],
      ["repair", 5],
    ],
  ),
  topic(
    "contact_lenses",
    ["Contact Lenses"],
    [
      ["contact lenses", 6],
      ["contact lens", 6],
      ["lentes de contacto", 6],
      ["contacts", 4],
    ],
  ),
  topic(
    "optical",
    ["Optical and Glasses"],
    [
      ["optical services", 5],
      ["servicios opticos", 5],
      ["optical", 4],
      ["optica", 4],
      ["glasses", 4],
      ["eyeglasses", 4],
      ["frames", 4],
      ["monturas", 4],
      ["sunglasses", 4],
      ["gafas de sol", 4],
      ["optician", 4],
      ["optico", 4],
    ],
  ),
  topic(
    "insurance_referrals",
    ["Insurance and Referrals"],
    [
      ["referral", 5],
      ["referrals", 5],
      ["referido", 5],
      ["referencia medica", 5],
      ["preauthorization", 5],
      ["prior authorization", 5],
      ["retinal photos", 6, ["retinal photos", "retinal photography"]],
      ["retinal photography", 6, ["retinal photos", "retinal photography"]],
      ["copay", 6],
      ["co pay", 6],
      ["deductible", 6],
      ["benefits", 5],
      ["copago", 6],
      ["deducible", 6],
    ],
  ),
  topic(
    "pricing",
    ["Self-Pay Pricing"],
    [
      ["self pay", 6],
      ["cash price", 6],
      ["cash pay", 6],
      ["without insurance", 6],
      ["no insurance", 6],
      ["out of pocket", 6],
      ["charge for cash", 6],
      ["monto a pagar", 6],
      ["valor de la consulta", 6],
      ["precio sin seguro", 6],
      ["pago por cuenta propia", 6],
      ["how much", 4],
      ["cuanto cuesta", 5],
      ["cost", 4],
      ["price", 4],
      ["precio", 4],
    ],
  ),
  topic(
    "payment",
    ["Payments", "Billing"],
    [
      ["payment methods", 6],
      ["formas de pago", 6],
      ["how can i pay", 6],
      ["how do you take payment", 6],
      ["como puedo pagar", 6],
      ["credit card", 6],
      ["debit card", 6],
      ["tarjeta", 5],
      ["efectivo", 5],
      ["cash payment", 6],
      ["payment plan", 6],
      ["plan de pago", 6],
      ["pay over the phone", 6],
      ["pagar por telefono", 6],
      ["make a payment", 6],
      ["take a payment", 6],
      ["payment", 4],
      ["payments", 4],
      ["pagar", 4],
    ],
  ),
  topic(
    "billing",
    ["Billing"],
    [
      ["billing policy", 6],
      ["politica de facturacion", 6],
      ["billing", 5],
      ["billed", 5],
      ["cobraron", 5],
      ["bill", 4],
      ["facturacion", 5],
      ["factura", 4],
    ],
  ),
  topic(
    "preparation",
    ["What to Bring"],
    [
      ["what should i bring", 6],
      ["what do i bring", 6],
      ["should i bring", 5],
      ["que debo traer", 6],
      ["que tengo que llevar", 6],
      ["bring with me", 5],
      ["traer", 4],
      ["llevar", 4],
      ["prepare for my visit", 5],
      ["prepararme para la cita", 5],
    ],
  ),
  topic(
    "appointment_expectations",
    ["Appointment Expectations"],
    [
      ["what should i expect", 6],
      ["que debo esperar", 6],
      ["how long is the appointment", 6],
      ["how much time", 6],
      ["cuanto tiempo", 6],
      ["cuanto dura la cita", 6],
      ["appointment length", 5],
      ["duracion de la cita", 5],
      ["will i be dilated", 5],
      ["me van a dilatar", 5],
      ["arrival time", 4],
      ["paperwork", 4],
      ["email confirmation", 6],
      ["confirmation email", 6],
      ["confirmacion", 5],
    ],
  ),
  topic(
    "emergency_urgency",
    ["Emergency and Urgency"],
    [
      ["medical emergency", 6],
      ["emergencia medica", 6],
      ["emergency", 5],
      ["emergencia", 5],
      ["urgent eye pain", 6, ["to determine urgency"]],
      ["dolor urgente", 6, ["to determine urgency"]],
      ["flashes and floaters", 6, ["flashes", "floaters"]],
      ["destellos y moscas volantes", 6, ["flashes", "floaters"]],
      ["flashes", 5, ["flashes"]],
      ["floaters", 5, ["floaters"]],
      ["destellos", 5, ["flashes"]],
      ["moscas volantes", 5, ["floaters"]],
      ["sudden vision loss", 6, ["vision loss"]],
      ["perdida repentina de vision", 6, ["vision loss"]],
      ["urgent", 4],
      ["urgente", 4],
    ],
  ),
  topic(
    "social_follow_up",
    ["Social Follow-Up"],
    [
      ["social media", 5],
      ["redes sociales", 5],
      ["instagram", 5],
      ["facebook", 5],
    ],
  ),
];

export function resolveOfficeKnowledge(
  officeKey: OfficeKey,
  transcript: string,
  recentConversation: string[] = [],
): OfficeKnowledgeResolution {
  const normalized = normalize(transcript);
  const language = detectLanguage(normalized);
  const cataractRequest =
    ["spring-hill", "crystal-river", "hollywood", "sweetwater"].includes(
      officeKey,
    ) &&
    ["cataract", "cataracts", "catarata", "cataratas"].some((phrase) =>
      hasPhrase(normalized, phrase),
    );
  // Static office information can accompany a tool-owned workflow. Supplying
  // the contact or listed price never establishes an account or action outcome.
  const informationTopic = officeInformationTopic(normalized);
  // Service restrictions still apply when the caller asks to book care.
  if (
    isBusinessOwnedTurn(normalized) &&
    !cataractRequest &&
    !informationTopic
  ) {
    return { language, outcome: "skipped", sections: [], topic: null };
  }
  const index = knowledgeIndex(officeKey);
  const { sections } = index;
  const currentScores = rankTopics(normalized, index, officeKey);
  const confidentTopic = selectOfficeTopic(normalized, currentScores);
  const emergencyTopic = currentScores.find(
    ({ definition, score }) =>
      definition.topic === "emergency_urgency" && score >= MIN_TOPIC_SCORE,
  );
  let selected =
    emergencyTopic ??
    confidentTopic ??
    (cataractRequest
      ? (currentScores.find(
          ({ definition }) => definition.topic === "services",
        ) ?? null)
      : null);

  const locationFollowUp = isLocationFollowUp(normalized);
  if (
    !selected &&
    currentScores.every(({ score }) => score === 0) &&
    (locationFollowUp || isContextualFollowUp(normalized))
  ) {
    const recentText = recentConversation.slice(-2).join(" ");
    const normalizedRecentText = normalize(recentText);
    const recentInformationTopic = officeInformationTopic(normalizedRecentText);
    if (!isBusinessOwnedTurn(normalizedRecentText) || recentInformationTopic) {
      const recentScores = rankTopics(normalizedRecentText, index, officeKey);
      const contextualTopic = selectOfficeTopic(
        normalizedRecentText,
        recentScores,
      );
      if (
        !locationFollowUp ||
        contextualTopic?.definition.topic === "location_contact"
      ) {
        selected = contextualTopic ?? null;
      }
    }
  }

  if (!selected) {
    return { language, outcome: "skipped", sections: [], topic: null };
  }

  const { definition } = selected;
  if (!selected.sourceSupported) {
    return {
      language,
      outcome: "unavailable",
      sections: [],
      topic: definition.topic,
    };
  }

  const selectedSections = [
    ...selectSections(sections, definition.sectionTitles),
    ...selected.sourceSections,
  ]
    .filter(
      (section, index, candidates) => candidates.indexOf(section) === index,
    )
    .slice(0, MAX_SELECTED_SECTIONS);
  if (selectedSections.length === 0) {
    return {
      language,
      outcome: "unavailable",
      sections: [],
      topic: definition.topic,
    };
  }
  if (
    selectedSections.every(
      (section) => sectionStatus(section) === "not-supplied",
    )
  ) {
    return {
      language,
      outcome: "unavailable",
      sections: [],
      topic: definition.topic,
    };
  }

  return {
    language,
    outcome: "matched",
    sections: selectedSections.map((section) => section.body),
    topic: definition.topic,
  };
}

export function officeKnowledgeReference(
  officeKey: OfficeKey,
  resolution: Exclude<OfficeKnowledgeResolution, { outcome: "skipped" }>,
): string {
  const office = getOfficeProfile(officeKey);
  const content =
    resolution.outcome === "matched"
      ? resolution.sections
      : [
          `The active office has no supplied information for ${resolution.topic}. Tell the caller the information is unavailable and keep the answer limited to supplied office facts.`,
        ];
  return [
    "=== OFFICE KNOWLEDGE FOR THIS REPLY ===",
    `active office: ${office.displayName}`,
    "This exact office-owned content is authoritative only for the current reply.",
    "Keep every office detail grounded in this reference.",
    ...(resolution.outcome === "matched"
      ? officeReplyGuidance(resolution.topic)
      : []),
    "",
    ...content,
    "=== END OFFICE KNOWLEDGE FOR THIS REPLY ===",
  ].join("\n");
}

export function validateOfficeKnowledgeSources(
  readSource?: (source: string) => string,
): Array<{
  officeKey: OfficeKey;
  sectionCount: number;
  source: string;
}> {
  return getOfficeProfiles().map((office) => {
    const sections = readSource
      ? parseKnowledgeSource(
          office.knowledgeSource,
          readSource(office.knowledgeSource),
        )
      : knowledgeIndex(office.key).sections;
    const uniqueTitles = new Set(sections.map(({ title }) => normalize(title)));
    if (uniqueTitles.size !== sections.length) {
      throw new Error(
        `Office knowledge source has duplicate level-two sections: ${office.knowledgeSource}`,
      );
    }
    return {
      officeKey: office.key,
      sectionCount: sections.length,
      source: office.knowledgeSource,
    };
  });
}

export function validateOfficeKnowledgeDocument(
  source: string,
  content: string,
): void {
  const lines = content.split(/\r?\n/);
  if (!lines[0]?.startsWith("# Office Knowledge: ")) {
    throw new Error(
      `Invalid Office Knowledge document ${source}: expected title`,
    );
  }
  if (lines[1] !== `Schema: ${OFFICE_KNOWLEDGE_SCHEMA_VERSION}`) {
    throw new Error(
      `Invalid Office Knowledge document ${source}: expected schema ${OFFICE_KNOWLEDGE_SCHEMA_VERSION}`,
    );
  }

  const matches = [...content.matchAll(/^## (.+)$/gm)];
  const headings = matches.map((match) => match[1]);
  if (
    headings.length !== CANONICAL_HEADINGS.length ||
    headings.some((heading, index) => heading !== CANONICAL_HEADINGS[index])
  ) {
    throw new Error(
      `Invalid Office Knowledge document ${source}: expected canonical headings in canonical order`,
    );
  }

  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const sectionLines = content
      .slice(start, end)
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const statusLines = sectionLines.filter((line) =>
      line.startsWith("Status:"),
    );
    if (
      statusLines.length !== 1 ||
      sectionLines[0] !== statusLines[0] ||
      !/^Status: (available|not-offered|not-supplied)$/.test(statusLines[0]!)
    ) {
      throw new Error(
        `Invalid Office Knowledge document ${source}: ${match[1]} needs one status as its first line`,
      );
    }
    if (sectionLines.length === 1) {
      throw new Error(
        `Invalid Office Knowledge document ${source}: ${match[1]} needs explanatory content`,
      );
    }
  });
}

function topic(
  name: OfficeKnowledgeTopic,
  sectionTitles: string[],
  aliases: TopicDefinition["aliases"],
  officeKeys?: readonly OfficeKey[],
): TopicDefinition {
  return { aliases, officeKeys, sectionTitles, topic: name };
}

function topicScore(
  normalizedTranscript: string,
  definition: TopicDefinition,
  sections: KnowledgeSection[],
): Pick<RankedTopic, "score" | "sourceSections" | "sourceSupported"> {
  let score = 0;
  const sourceSections: KnowledgeSection[] = [];
  let sourceSupported = true;

  for (const [phrase, weight, sourceTerms] of definition.aliases) {
    if (!hasPhrase(normalizedTranscript, phrase)) continue;
    score += weight;
    if (sourceTerms) {
      const matchingSections = sections.filter((section) =>
        sourceTerms.some((term) => hasPhrase(section.normalizedBody, term)),
      );
      if (matchingSections.length === 0) {
        sourceSupported = false;
      } else {
        for (const section of matchingSections) {
          if (!sourceSections.includes(section)) sourceSections.push(section);
        }
      }
    }
  }
  return { score, sourceSections, sourceSupported };
}

function rankTopics(
  normalizedTranscript: string,
  index: OfficeKnowledgeIndex,
  officeKey: OfficeKey,
): RankedTopic[] {
  return TOPICS.filter(
    ({ officeKeys }) => !officeKeys || officeKeys.includes(officeKey),
  )
    .map((definition) => {
      const match = topicScore(
        normalizedTranscript,
        definition,
        index.sections,
      );
      const providerScore =
        definition.topic === "providers" &&
        index.providerNames.some((alias) =>
          hasPhrase(normalizedTranscript, alias),
        )
          ? 6
          : 0;
      return {
        definition,
        score: match.score + providerScore,
        sourceSections: match.sourceSections,
        sourceSupported: match.sourceSupported,
      };
    })
    .sort((left, right) => right.score - left.score);
}

function selectConfidentTopic(
  ranked: ReturnType<typeof rankTopics>,
): RankedTopic | null {
  const best = ranked[0];
  const next = ranked.find(
    (candidate) => candidate.definition.topic !== best?.definition.topic,
  );
  if (
    !best ||
    best.score < MIN_TOPIC_SCORE ||
    best.score - (next?.score ?? 0) < MIN_TOPIC_MARGIN
  ) {
    return null;
  }
  return best;
}

// Use the same selection for the current turn and its immediate follow-up.
function selectOfficeTopic(
  text: string,
  scores: RankedTopic[],
): RankedTopic | null {
  const informationTopic = officeInformationTopic(text);
  if (informationTopic === "pricing") {
    const specific = scores.find(({ definition, score }) => {
      if (score < MIN_TOPIC_SCORE) return false;
      switch (definition.topic) {
        case "appointment_expectations":
        case "insurance_referrals":
        case "optical_repairs":
          return true;
        case "optical":
        case "contact_lenses":
          // The exam/fitting has a visit rate; the eyewear itself does not.
          return !["exam", "fitting", "examen", "adaptacion"].some((word) =>
            hasPhrase(text, word),
          );
        default:
          return false;
      }
    });
    if (specific) return specific;
  }
  return informationTopic
    ? (scores.find(({ definition }) => definition.topic === informationTopic) ??
        null)
    : selectConfidentTopic(scores);
}

function isContextualFollowUp(normalizedTranscript: string): boolean {
  if (normalizedTranscript.split(" ").filter(Boolean).length > 6) return false;
  const cues = [
    "and",
    "and that",
    "and there",
    "correct",
    "exactly",
    "how about",
    "how about it",
    "how about that",
    "how about there",
    "it",
    "that",
    "the same",
    "what about",
    "what about it",
    "what about that",
    "what about there",
    "the visit",
    "the consultation",
    "la consulta",
    "la cita",
    "yes",
    "yep",
    "y",
    "y alli",
    "y eso",
    "si",
  ];
  const withoutLeadIn = normalizedTranscript.replace(
    /^(?:and|bueno|okay|ok|so|well)\s+/,
    "",
  );
  return [normalizedTranscript, withoutLeadIn].some((candidate) =>
    cues.includes(candidate),
  );
}

function isLocationFollowUp(normalizedTranscript: string): boolean {
  return [
    "and the zip code",
    "what is the zip code",
    "what s the zip code",
  ].includes(normalizedTranscript);
}

// These requests ask for supplied facts or routing instructions, including when
// the caller also mentions an appointment or a personal billing problem.
function officeInformationTopic(text: string): OfficeKnowledgeTopic | null {
  const hasAny = (phrases: string[]) =>
    phrases.some((phrase) => hasPhrase(text, phrase));
  // Copay questions belong to insurance even when phrased as a billing dispute.
  if (/\b(?:co ?pay(?:ment)?s?|copagos?)\b/.test(text)) {
    return "insurance_referrals";
  }
  if (
    hasAny([
      "bill",
      "billing",
      "billed",
      "charged",
      "overcharged",
      "refund",
      "reembolso",
      "account balance",
      "amount due",
      "owe",
      "factura",
      "facturacion",
      "cuanto debo",
      "cobraron",
    ])
  ) {
    return hasAny([
      "credit card",
      "debit card",
      "tarjeta",
      "payment methods",
      "formas de pago",
    ])
      ? "payment"
      : "billing";
  }
  if (
    hasAny(["confirmation", "confirmacion"]) &&
    hasAny([
      "email",
      "emailed",
      "e mail",
      "correo",
      "send",
      "sent",
      "enviar",
      "mandar",
    ])
  ) {
    return "appointment_expectations";
  }
  if (hasAny(["deductible", "benefits", "deducible", "prior authorization"])) {
    return "insurance_referrals";
  }
  if (
    hasAny(["address", "direccion", "directions"]) &&
    hasAny([
      "text",
      "email",
      "e mail",
      "send",
      "mensaje",
      "correo",
      "mandar",
      "enviar",
    ]) &&
    !hasAny(["my address", "mi direccion", "change my", "update my"])
  ) {
    return "location_contact";
  }
  const selfPay = hasAny([
    "self pay",
    "cash",
    "without insurance",
    "no insurance",
    "out of pocket",
    "sin seguro",
    "pago por cuenta propia",
  ]);
  const priceQuestion =
    hasAny([
      "how much",
      "price",
      "pricing",
      "cost",
      "charge",
      "cuanto cuesta",
      "monto a pagar",
      "valor de la consulta",
      "precio",
    ]) ||
    (hasAny(["cuanto"]) && hasAny(["pagar", "cobran", "cuesta", "vale"]));
  if (
    priceQuestion &&
    (selfPay ||
      !hasAny([
        "insurance",
        "seguro",
        "copay",
        "co pay",
        "deductible",
        "copago",
        "deducible",
      ]))
  ) {
    return "pricing";
  }
  return null;
}

function officeReplyGuidance(topic: OfficeKnowledgeTopic): string[] {
  switch (topic) {
    case "pricing":
      return [
        "Answer from the supplied self-pay visit rates. Clarify the visit type and new versus established patient when needed. A listed visit rate is not a quote for an unlisted procedure or the patient's final bill. Answer an available rate directly instead of offering a staff task for the same question.",
      ];
    case "location_contact":
      return [
        "If asked to text or email the office address, offer to read the relevant office address slowly for the caller to write down and repeat it as needed. Do not promise a message or create a staff task solely to send the address.",
      ];
    case "billing":
      return [
        "Follow the supplied billing contact instructions, including for optical billing and questions about an existing charge. Give the supplied number rather than offering a routine billing task. This reference does not establish a balance, reason for a charge, or a resolved billing issue.",
      ];
    case "insurance_referrals":
      return [
        "Plan acceptance does not prove benefits, copays, deductibles, active coverage, or authorization. Use check_insurance for participation; For unresolved copay/copayment questions (including amounts, coverage or disputed copay charges), benefits, referral requirements or visit/procedure/surgery/test authorization, offer an insurance task with caller agreement. Copay questions stay insurance even when described as billing or related to glasses or medication. Medication PA, denial or status belongs to medication, even when an insurer or pharmacy calls. Actual referral/imaging-order coordination belongs to referrals; records-release authorization belongs to documentation. Use context; briefly clarify an unknown authorization subject. If still unknown, use other and list the missing subject. Do not claim caller-reported status is verified.",
      ];
    case "appointment_expectations":
      return [
        "Explain only the supplied confirmation-email practice. A usual confirmation email is not proof that an email was sent or delivered. Do not promise to send or resend one. A routine confirmation request alone does not need a staff task; a reported missing confirmation or incorrect contact detail may need staff follow-up.",
      ];
    default:
      return [];
  }
}

function isBusinessOwnedTurn(normalizedTranscript: string): boolean {
  const schedulingAction = [
    "agendar",
    "book",
    "cancel",
    "cancelar",
    "programar",
    "reprogramar",
    "reschedule",
    "reservar",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  const generalScheduleReference = [
    "business schedule",
    "office schedule",
    "schedule is",
    "weekday schedule",
    "your schedule",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  const scheduleRequest =
    hasPhrase(normalizedTranscript, "schedule") && !generalScheduleReference;
  if (schedulingAction || scheduleRequest) return true;

  const schedulingSubject = [
    "appointment",
    "cita",
    "consulta",
    "consultation",
    "visit",
    "visita",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  const genericSchedulingAction = ["change", "hacer", "make"].some((phrase) =>
    hasPhrase(normalizedTranscript, phrase),
  );
  const schedulingRequest =
    (genericSchedulingAction && schedulingSubject) ||
    [
      "availability",
      "openings",
      "citas disponibles",
      "disponibilidad",
      "turnos disponibles",
    ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  if (schedulingRequest) return true;

  const referralSubject = [
    "referral",
    "referrals",
    "referido",
    "referencia medica",
    "preauthorization",
    "prior authorization",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  const insuranceSubject = ["insurance", "seguro"].some((phrase) =>
    hasPhrase(normalizedTranscript, phrase),
  );
  const selfPaySubject = [
    "without insurance",
    "no insurance",
    "cash pay",
    "cash price",
    "pago por cuenta propia",
    "precio sin seguro",
    "self pay",
    "sin seguro",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  const planAcceptance =
    hasPhrase(normalizedTranscript, "plan") &&
    [
      "accept",
      "accepted",
      "acepta",
      "aceptan",
      "participate",
      "take",
      "takes",
      "use",
    ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  if (
    (insuranceSubject && !referralSubject && !selfPaySubject) ||
    planAcceptance
  ) {
    return true;
  }

  const personalOrderStatus =
    [
      "arrive",
      "ready",
      "status",
      "when will",
      "where is",
      "listos",
      "lista",
      "cuando llegan",
      "donde estan",
    ].some((phrase) => hasPhrase(normalizedTranscript, phrase)) &&
    ["contact lenses", "contacts", "glasses", "lentes", "order"].some(
      (phrase) => hasPhrase(normalizedTranscript, phrase),
    );
  if (personalOrderStatus) return true;

  const personalAccountState = [
    "account balance",
    "balance on my bill",
    "billing statement",
    "current bill",
    "statement balance",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  const personalReference = ["my", "mi", "mis"].some((phrase) =>
    hasPhrase(normalizedTranscript, phrase),
  );
  const personalContact = [
    "my address",
    "my email",
    "my phone number",
    "my zip code",
    "mi direccion",
    "mi email",
    "mi numero de telefono",
    "mi telefono",
    "mi codigo postal",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  const patientRecordSubject = [
    "patient record",
    "patient records",
    "medical record",
    "medical records",
    "expediente",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  if (
    personalAccountState ||
    personalContact ||
    (personalReference && patientRecordSubject)
  ) {
    return true;
  }

  return [
    "how much do i owe",
    "what do i owe",
    "amount due",
    "cuanto debo",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
}

function selectSections(
  sections: KnowledgeSection[],
  titles: string[],
): KnowledgeSection[] {
  const normalizedTitles = titles.map(normalize);
  return sections
    .filter((section) =>
      normalizedTitles.some((title) => {
        const sectionTitle = normalize(section.title);
        return sectionTitle === title || sectionTitle.startsWith(`${title} `);
      }),
    )
    .slice(0, MAX_SELECTED_SECTIONS);
}

function providerNames(sections: KnowledgeSection[]): string[] {
  const providerText = sections
    .filter(({ title }) => normalize(title).startsWith("providers"))
    .map(({ body }) => body)
    .join("\n");
  const names = new Set<string>();

  for (const match of providerText.matchAll(
    /\b(?:Doctor|Dr\.?)\s+([\p{Lu}][\p{L}'-]+)(?:\s+([\p{Lu}][\p{L}'-]+))?/gu,
  )) {
    const first = match[1];
    const last = match[2] ?? first;
    if (last) names.add(normalize(last));
  }
  for (const match of providerText.matchAll(
    /^([\p{Lu}][\p{L}'-]+)\s+([\p{Lu}][\p{L}'-]+)(?:,|\s+is\b)/gmu,
  )) {
    if (match[2]) names.add(normalize(match[2]));
  }
  const asrVariants =
    /STT often misrecognizes as:\s*([^.]+)\./i.exec(providerText)?.[1] ?? "";
  for (const match of asrVariants.matchAll(/"([^"]+)"/g)) {
    if (match[1]) names.add(normalize(match[1]));
  }
  return [...names];
}

function knowledgeIndex(officeKey: OfficeKey): OfficeKnowledgeIndex {
  const cached = knowledgeCache.get(officeKey);
  if (cached) return cached;

  const file = getOfficeProfile(officeKey).knowledgeSource;
  const sections = parseKnowledgeSource(
    file,
    readFileSync(join(WORKSPACE, file), "utf8"),
  );
  const index = {
    providerNames: providerNames(sections),
    sections,
  };
  knowledgeCache.set(officeKey, index);
  return index;
}

function parseKnowledgeSource(
  source: string,
  content: string,
): KnowledgeSection[] {
  validateOfficeKnowledgeDocument(source, content);
  const sections = parseMarkdownSections(content);
  if (sections.length === 0) {
    throw new Error(
      `Office knowledge source has no level-two sections: ${source}`,
    );
  }
  return sections;
}

function sectionStatus(
  section: KnowledgeSection,
): "available" | "not-offered" | "not-supplied" {
  const status = /^Status: (available|not-offered|not-supplied)$/m.exec(
    section.body,
  )?.[1];
  if (
    status === "available" ||
    status === "not-offered" ||
    status === "not-supplied"
  ) {
    return status;
  }
  throw new Error(
    `Office knowledge section has no valid status: ${section.title}`,
  );
}

function parseMarkdownSections(content: string): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let title: string | null = null;
  let lines: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      if (title) pushSection(sections, title, lines);
      title = heading[1]!.trim();
      lines = [line];
    } else if (title) {
      lines.push(line);
    }
  }
  if (title) pushSection(sections, title, lines);
  return sections;
}

function pushSection(
  sections: KnowledgeSection[],
  title: string,
  lines: string[],
): void {
  const body = lines.join("\n").trim();
  if (!lines.slice(1).join("\n").trim()) {
    throw new Error(`Office knowledge section is empty: ${title}`);
  }
  sections.push({ body, normalizedBody: normalize(body), title });
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function hasPhrase(value: string, phrase: string): boolean {
  let needle = phraseNeedleCache.get(phrase);
  if (!needle) {
    needle = ` ${normalize(phrase)} `;
    phraseNeedleCache.set(phrase, needle);
  }
  return ` ${value} `.includes(needle);
}

const ENGLISH_LANGUAGE_MARKERS = new Set([
  "address",
  "are",
  "billing",
  "bring",
  "can",
  "close",
  "cost",
  "do",
  "does",
  "how",
  "insurance",
  "is",
  "my",
  "office",
  "open",
  "pay",
  "price",
  "sell",
  "services",
  "what",
  "when",
  "where",
  "which",
  "your",
  "yes",
]);

const SPANISH_LANGUAGE_MARKERS = new Set([
  "abren",
  "atienden",
  "cerrados",
  "cierran",
  "como",
  "cual",
  "cuales",
  "cuanto",
  "debo",
  "direccion",
  "de",
  "donde",
  "es",
  "el",
  "estan",
  "esta",
  "horario",
  "alli",
  "la",
  "las",
  "los",
  "necesito",
  "oficina",
  "ofrecen",
  "orario",
  "pagar",
  "pueden",
  "que",
  "servicio",
  "servicios",
  "su",
  "sus",
  "si",
  "mis",
  "tengo",
  "traer",
  "tratan",
  "ubicados",
]);

function detectLanguage(normalizedTranscript: string): OfficeKnowledgeLanguage {
  const tokens = normalizedTranscript.split(" ").filter(Boolean);
  const english = tokens.some((token) => ENGLISH_LANGUAGE_MARKERS.has(token));
  const spanish = tokens.some((token) => SPANISH_LANGUAGE_MARKERS.has(token));
  if (english && spanish) return "mixed";
  if (spanish) return "es";
  if (english) return "en";
  return "unknown";
}
