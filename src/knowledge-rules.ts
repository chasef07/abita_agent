import { readFileSync } from "fs";
import { join } from "path";
import { getOfficeConfig, type OfficeKey } from "./offices.js";

const WORKSPACE = join(
  import.meta.dirname,
  "..",
  process.env.PROMPT_WORKSPACE || "workspace",
);

export interface KnowledgeSection {
  key: string;
  title: string;
  aliases: string[];
  lines: string[];
}

export interface KnowledgeReference {
  officeLabel: string;
  summary?: string[];
  fallbackSectionKeys?: string[];
  sections: KnowledgeSection[];
}

export interface KnowledgeToolResponse {
  officeLabel: string;
  matchedSectionTitles: string[];
  sections: Array<{
    title: string;
    lines: string[];
  }>;
}

const referenceCache = new Map<string, KnowledgeReference>();

export function normalizeKnowledgeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function loadKnowledgeReference(file: string): KnowledgeReference {
  const cached = referenceCache.get(file);
  if (cached) return cached;
  const raw = readFileSync(join(WORKSPACE, file), "utf-8");
  const parsed = JSON.parse(raw) as KnowledgeReference;
  referenceCache.set(file, parsed);
  return parsed;
}

function tokenizeNormalizedText(text: string): string[] {
  return text.split(" ").filter(Boolean);
}

function scoreCandidateMatch(
  candidate: string,
  normalizedQuery: string,
  queryTokens: Set<string>,
): number {
  const normalizedCandidate = normalizeKnowledgeText(candidate);
  if (!normalizedCandidate) return 0;

  const candidateTokens = tokenizeNormalizedText(normalizedCandidate);
  if (candidateTokens.length === 1) {
    return queryTokens.has(candidateTokens[0]!) ? 4 : 0;
  }

  const exactPhrase = ` ${normalizedQuery} `.includes(
    ` ${normalizedCandidate} `,
  );
  if (exactPhrase) {
    return candidateTokens.length * 4;
  }

  const tokenOverlap = candidateTokens.filter((token) =>
    queryTokens.has(token),
  ).length;
  return tokenOverlap === candidateTokens.length ? candidateTokens.length * 2 : 0;
}

function scoreSectionMatch(section: KnowledgeSection, normalizedQuery: string): number {
  const queryTokens = new Set(tokenizeNormalizedText(normalizedQuery));
  let score = scoreCandidateMatch(section.title, normalizedQuery, queryTokens);
  for (const alias of section.aliases) {
    score += scoreCandidateMatch(alias, normalizedQuery, queryTokens);
  }
  return score;
}

export function lookupKnowledge(
  reference: KnowledgeReference,
  query: string,
): KnowledgeToolResponse {
  const normalizedQuery = normalizeKnowledgeText(query);
  const matches = reference.sections
    .map((section, index) => ({
      section,
      index,
      score: scoreSectionMatch(section, normalizedQuery),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map((entry) => entry.section);

  const fallbackKeys = reference.fallbackSectionKeys ?? [];
  const fallbackSections =
    matches.length > 0
      ? matches
      : reference.sections.filter((section) => fallbackKeys.includes(section.key));

  const sections =
    fallbackSections.length > 0
      ? fallbackSections
      : reference.sections.slice(0, Math.min(2, reference.sections.length));

  return {
    officeLabel: reference.officeLabel,
    matchedSectionTitles: sections.map((section) => section.title),
    sections: sections.map((section) => ({
      title: section.title,
      lines: section.lines,
    })),
  };
}

export function lookupKnowledgeForOffice(
  officeKey: OfficeKey,
  query: string,
): KnowledgeToolResponse {
  const file = getOfficeConfig(officeKey).knowledgeFile;
  const reference = loadKnowledgeReference(file);
  return lookupKnowledge(reference, query);
}
