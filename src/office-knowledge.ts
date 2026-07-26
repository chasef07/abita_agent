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
  title: string;
};

type OfficeKnowledgeIndex = {
  providerNames: string[];
  sections: KnowledgeSection[];
};

type TopicDefinition = {
  aliases: Array<readonly [phrase: string, weight: number]>;
  sectionTitles: string[];
  topic: OfficeKnowledgeTopic;
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
    ["Location + Contact"],
    [
      ["business hours", 5],
      ["office hours", 5],
      ["horario", 4],
      ["orario", 4],
      ["horarios", 4],
      ["horas", 3],
      ["hours", 3],
      ["when are you open", 5],
      ["cuando abren", 5],
      ["a que hora abren", 5],
      ["cuando cierran", 5],
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
    ["Location + Contact"],
    [
      ["where are you located", 6],
      ["donde estan ubicados", 6],
      ["donde se encuentran", 6],
      ["location", 3],
      ["ubicacion", 3],
      ["address", 4],
      ["addresses", 4],
      ["office addresses", 5],
      ["direccion", 4],
      ["directions", 3],
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
    ],
  ),
  topic(
    "skin_cancer",
    ["Skin Cancer and Mohs"],
    [
      ["mohs", 6],
      ["skin cancer", 6],
      ["cancer de piel", 6],
      ["biopsy", 4],
      ["biopsia", 4],
      ["suspicious mole", 5],
      ["lunar sospechoso", 5],
    ],
  ),
  topic(
    "medical_cosmetic",
    ["Scope of Services", "Medical or Cosmetic"],
    [
      ["medical or cosmetic", 6],
      ["medico o cosmetico", 6],
      ["cosmetic", 4],
      ["cosmetico", 4],
      ["aesthetic", 4],
      ["estetico", 4],
      ["botox", 5],
      ["dysport", 5],
      ["dermal filler", 5],
      ["relleno dermico", 5],
      ["microneedling", 5],
      ["chemical peel", 5],
    ],
  ),
  topic(
    "services",
    ["Scope of Services"],
    [
      ["what services", 5],
      ["que servicios", 5],
      ["services", 3],
      ["servicios", 3],
      ["cataract", 4],
      ["catarata", 4],
      ["cataratas", 4],
      ["cirugia de cataratas", 6],
      ["glaucoma", 4],
      ["retina", 4],
      ["routine eye exam", 5],
      ["examen de la vista", 5],
      ["pediatric", 4],
      ["pediatrico", 4],
      ["dermatology", 4],
      ["dermatologia", 4],
      ["acne", 4],
      ["eczema", 4],
      ["psoriasis", 4],
      ["rosacea", 4],
    ],
  ),
  topic(
    "optical_repairs",
    ["Glasses Warranty / Repairs", "Glasses Warranty or Broken Glasses"],
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
    ["Optical / Glasses", "Licensed Optician"],
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
    ["Insurance & Referrals", "Insurance"],
    [
      ["referral", 5],
      ["referrals", 5],
      ["referido", 5],
      ["referencia medica", 5],
      ["preauthorization", 5],
      ["prior authorization", 5],
    ],
  ),
  topic(
    "pricing",
    ["Self-Pay Pricing"],
    [
      ["self pay", 6],
      ["cash price", 6],
      ["cash pay", 6],
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
    ["Payment Information", "Payments"],
    [
      ["payment methods", 6],
      ["formas de pago", 6],
      ["how can i pay", 6],
      ["como puedo pagar", 6],
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
      ["cuanto dura la cita", 6],
      ["appointment length", 5],
      ["duracion de la cita", 5],
      ["will i be dilated", 5],
      ["me van a dilatar", 5],
      ["arrival time", 4],
      ["paperwork", 4],
    ],
  ),
  topic(
    "emergency_urgency",
    ["Emergency Notice", "Urgency Screening"],
    [
      ["medical emergency", 6],
      ["emergencia medica", 6],
      ["emergency", 5],
      ["emergencia", 5],
      ["urgent eye pain", 6],
      ["dolor urgente", 6],
      ["flashes and floaters", 6],
      ["destellos y moscas volantes", 6],
      ["sudden vision loss", 6],
      ["perdida repentina de vision", 6],
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
  if (isBusinessOwnedTurn(normalized)) {
    return { language, outcome: "skipped", sections: [], topic: null };
  }
  const index = knowledgeIndex(officeKey);
  const { sections } = index;
  const providerAliases = index.providerNames;
  const currentScores = rankTopics(normalized, providerAliases);
  let selected = selectConfidentTopic(currentScores);

  if (
    !selected &&
    currentScores.every(({ score }) => score === 0) &&
    isContextualFollowUp(normalized)
  ) {
    const recentText = recentConversation.slice(-2).join(" ");
    const normalizedRecentText = normalize(recentText);
    if (!isBusinessOwnedTurn(normalizedRecentText)) {
      selected = selectConfidentTopic(
        rankTopics(normalizedRecentText, providerAliases),
      );
    }
  }

  if (!selected) {
    return { language, outcome: "skipped", sections: [], topic: null };
  }

  const selectedSections = selectSections(sections, selected.sectionTitles);
  if (selectedSections.length === 0) {
    return {
      language,
      outcome: "unavailable",
      sections: [],
      topic: selected.topic,
    };
  }

  return {
    language,
    outcome: "matched",
    sections: selectedSections.map((section) => section.body),
    topic: selected.topic,
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
          `The active office has no supplied information for ${resolution.topic}. Tell the caller the information is unavailable and do not guess.`,
        ];
  return [
    "=== OFFICE KNOWLEDGE FOR THIS REPLY ===",
    `active office: ${office.displayName}`,
    "This exact office-owned content is authoritative only for the current reply.",
    "Do not invent or infer details beyond this reference.",
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

function topic(
  name: OfficeKnowledgeTopic,
  sectionTitles: string[],
  aliases: TopicDefinition["aliases"],
): TopicDefinition {
  return { aliases, sectionTitles, topic: name };
}

function topicScore(
  normalizedTranscript: string,
  definition: TopicDefinition,
): number {
  return definition.aliases.reduce(
    (score, [phrase, weight]) =>
      hasPhrase(normalizedTranscript, phrase) ? score + weight : score,
    0,
  );
}

function rankTopics(
  normalizedTranscript: string,
  providerAliases: string[] = [],
) {
  return TOPICS.map((definition) => ({
    definition,
    score:
      topicScore(normalizedTranscript, definition) +
      (definition.topic === "providers" &&
      providerAliases.some((alias) => hasPhrase(normalizedTranscript, alias))
        ? 6
        : 0),
  })).sort((left, right) => right.score - left.score);
}

function selectConfidentTopic(
  ranked: ReturnType<typeof rankTopics>,
): TopicDefinition | null {
  const best = ranked[0];
  const next = ranked[1];
  if (
    !best ||
    best.score < MIN_TOPIC_SCORE ||
    best.score - (next?.score ?? 0) < MIN_TOPIC_MARGIN
  ) {
    return null;
  }
  return best.definition;
}

function isContextualFollowUp(normalizedTranscript: string): boolean {
  if (normalizedTranscript.split(" ").filter(Boolean).length > 6) return false;
  return [
    "and",
    "and that",
    "and there",
    "correct",
    "exactly",
    "how about",
    "it",
    "that",
    "the same",
    "what about",
    "yes",
    "yep",
    "y",
    "y alli",
    "y eso",
    "si",
  ].some((cue) => hasPhrase(normalizedTranscript, cue));
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

  const personalReference = ["my", "mi", "mis"].some((phrase) =>
    hasPhrase(normalizedTranscript, phrase),
  );
  const billingSubject = [
    "balance",
    "bill",
    "billing",
    "statement",
    "factura",
    "saldo",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  const patientRecordSubject = [
    "patient record",
    "patient records",
    "medical record",
    "medical records",
    "expediente",
  ].some((phrase) => hasPhrase(normalizedTranscript, phrase));
  if (personalReference && (billingSubject || patientRecordSubject)) {
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
  const sections = parseMarkdownSections(content);
  if (sections.length === 0) {
    throw new Error(
      `Office knowledge source has no level-two sections: ${source}`,
    );
  }
  return sections;
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
  sections.push({ body, title });
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
  return ` ${value} `.includes(` ${normalize(phrase)} `);
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
