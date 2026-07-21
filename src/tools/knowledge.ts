import { readFileSync } from "fs";
import { join } from "path";
import {
  getOfficeProfile,
  type OfficeKey,
} from "../customers/abita/profile.js";

const WORKSPACE = join(import.meta.dirname, "..", "..", "workspace");
const workspaceFileCache: Record<string, string> = {};

type MarkdownSection = {
  title: string;
  body: string;
};

function readWorkspaceFile(file: string): string {
  workspaceFileCache[file] ??= readFileSync(join(WORKSPACE, file), "utf-8");
  return workspaceFileCache[file];
}

export function lookupOfficeKnowledge(
  officeKey: OfficeKey,
  question: string,
): string {
  const file = getOfficeProfile(officeKey).knowledgeSource;
  const content = readWorkspaceFile(file);
  const sections = parseMarkdownSections(content);
  const selected = selectKnowledgeSections(sections, question);
  return [
    `Knowledge source: ${file}`,
    `Question: ${question}`,
    "",
    ...selected.map((section) => section.body.trim()),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseMarkdownSections(content: string): MarkdownSection[] {
  const lines = content.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  let currentTitle = "Overview";
  let currentLines: string[] = [];

  for (const line of lines) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      pushSection(sections, currentTitle, currentLines);
      currentTitle = heading[1].trim();
      currentLines = [line];
      continue;
    }
    currentLines.push(line);
  }
  pushSection(sections, currentTitle, currentLines);
  return sections.filter((section) => section.body.trim());
}

function pushSection(
  sections: MarkdownSection[],
  title: string,
  lines: string[],
): void {
  const body = lines.join("\n").trim();
  if (body) sections.push({ title, body });
}

function selectKnowledgeSections(
  sections: MarkdownSection[],
  question: string,
): MarkdownSection[] {
  const query = normalize(question);
  const wantedTitles = new Set<string>();

  if (
    hasAny(query, [
      "address",
      "location",
      "directions",
      "phone",
      "fax",
      "email",
      "contact",
      "hours",
      "open",
      "close",
      "lunch",
    ])
  ) {
    addTitles(wantedTitles, "Location + Contact", "After Hours");
  }

  if (hasAny(query, ["after hours", "afterhours", "on call", "emergency"])) {
    addTitles(wantedTitles, "Emergency Notice", "After Hours");
  }

  if (
    hasAny(query, [
      "doctor",
      "provider",
      "dr ",
      "dermatologist",
      "aesthetician",
      "injector",
      "bach",
      "licht",
      "noel",
      "farnan",
      "vidal",
      "calero",
      "casas",
      "otero",
      "optometrist",
      "marlowe",
      "cole",
      "ramirez",
      "bennett",
      "torres",
    ])
  ) {
    addTitles(wantedTitles, "Providers", "Providers - Hollywood");
  }

  if (
    hasAny(query, [
      "service",
      "cataract",
      "glaucoma",
      "retina",
      "pediatric",
      "routine",
      "vision",
      "medical",
      "surgery",
      "urgent",
      "floaters",
      "flashes",
      "pain",
      "dermatology",
      "skin",
      "rash",
      "acne",
      "eczema",
      "psoriasis",
      "rosacea",
      "mole",
      "lesion",
      "mohs",
      "biopsy",
      "hair loss",
      "nail",
      "scar",
      "pigmentation",
    ])
  ) {
    addTitles(
      wantedTitles,
      "Scope of Services",
      "Medical or Cosmetic",
      "Skin Cancer and Mohs",
      "Urgency Screening",
    );
  }

  if (
    hasAny(query, [
      "botox",
      "dysport",
      "filler",
      "facial",
      "peel",
      "dermaplaning",
      "microneedling",
      "ipl",
      "laser",
      "cosmetic",
      "med spa",
      "medspa",
      "aesthetic",
    ])
  ) {
    addTitles(wantedTitles, "Scope of Services", "Medical or Cosmetic");
  }

  if (hasAny(query, ["insurance", "referral", "preauth", "payment", "cost"])) {
    addTitles(
      wantedTitles,
      "Insurance",
      "Insurance & Referrals",
      "Payment Information",
    );
  }

  if (hasAny(query, ["bring", "prepare", "id", "medications", "records"])) {
    addTitles(wantedTitles, "What to Bring", "Appointment Expectations");
  }

  if (
    hasAny(query, [
      "appointment",
      "how long",
      "dilation",
      "dilate",
      "confirmation",
      "expect",
    ])
  ) {
    addTitles(wantedTitles, "Appointment Expectations", "What to Bring");
  }

  if (
    hasAny(query, [
      "glasses",
      "frames",
      "contacts",
      "contact lenses",
      "optical",
      "lens",
      "warranty",
      "repair",
      "sunglasses",
      "optician",
    ])
  ) {
    addTitles(
      wantedTitles,
      "Scope of Services",
      "Optical / Glasses",
      "Contact Lenses",
      "Licensed Optician",
      "Glasses Warranty / Repairs",
      "Glasses Warranty or Broken Glasses",
    );
  }

  if (hasAny(query, ["facebook", "instagram", "social"])) {
    addTitles(wantedTitles, "Social Follow-Up");
  }

  const matched = sections.filter((section) =>
    wantedTitles.has(normalizeTitle(section.title)),
  );
  if (matched.length > 0) return matched;

  return sections.filter((section) =>
    new Set([
      "location contact",
      "scope of services",
      "providers",
      "providers hollywood",
    ]).has(normalizeTitle(section.title)),
  );
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeTitle(value: string): string {
  const normalized = normalize(value);
  if (normalized.startsWith("providers")) {
    return normalized.includes("hollywood")
      ? "providers hollywood"
      : "providers";
  }
  return normalized;
}

function addTitles(target: Set<string>, ...titles: string[]): void {
  for (const title of titles) target.add(normalizeTitle(title));
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(normalize(needle)));
}
