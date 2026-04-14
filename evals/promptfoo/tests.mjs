import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRubricForCase, buildRunbookComplianceRubric } from './rubric-mappings.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const goldenCasesDir = resolve(repoRoot, 'evals', 'cases', 'golden');
const candidatesCasesDir = resolve(repoRoot, 'evals', 'cases', 'candidates');
const assertionPath = `file://${resolve(repoRoot, 'evals', 'promptfoo', 'assertions', 'decision-point.mjs')}`;

function loadCasesFromDir(absoluteDir, relativePrefix, source) {
  return readdirSync(absoluteDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const casePath = join(absoluteDir, file);
      const testCase = JSON.parse(readFileSync(casePath, 'utf-8'));
      return {
        file,
        casePath: `${relativePrefix}/${file}`,
        testCase,
        source,
      };
    });
}

function loadGoldenCaseEntries() {
  const entries = loadCasesFromDir(goldenCasesDir, 'evals/cases/golden', 'golden');
  if (process.env.EVAL_INCLUDE_CANDIDATES === '1') {
    try {
      entries.push(...loadCasesFromDir(candidatesCasesDir, 'evals/cases/candidates', 'candidates'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return entries;
}

function buildGoldenAssertions(testCase) {
  const assertions = [
    {
      type: 'javascript',
      value: assertionPath,
    },
  ];

  const rubric = buildRubricForCase(testCase);
  if (rubric) {
    assertions.push({
      type: 'llm-rubric',
      value: rubric,
    });
  }

  return assertions;
}

function shouldUseStrictCandidateAssertions(testCase) {
  return testCase.assertionMode === 'strict';
}

function buildCandidateAssertions(testCase) {
  const assertions = [
    {
      type: 'llm-rubric',
      value: buildRunbookComplianceRubric(testCase),
    },
  ];

  // Most auto-extracted candidates are still too noisy for deterministic
  // assertions. Audit-driven or explicitly strict cases opt into the same
  // assertion path as goldens so their case-level expectations actually count.
  if (shouldUseStrictCandidateAssertions(testCase)) {
    assertions.unshift({
      type: 'javascript',
      value: assertionPath,
    });

    const rubric = buildRubricForCase(testCase);
    if (rubric) {
      assertions.push({
        type: 'llm-rubric',
        value: rubric,
      });
    }
  }

  return assertions;
}

function buildAssertions(source, testCase) {
  return source === 'candidates'
    ? buildCandidateAssertions(testCase)
    : buildGoldenAssertions(testCase);
}

export function loadPromptfooTests() {
  return loadGoldenCaseEntries().map(({ file, casePath, testCase, source }) => ({
    description: `[${source}] ${testCase.suite}: ${testCase.id}`,
    vars: {
      caseId: testCase.id,
      casePath,
    },
    metadata: {
      source,
      caseSource: testCase.source,
      suite: testCase.suite,
      tags: testCase.tags,
      caseFile: file,
    },
    assert: buildAssertions(source, testCase),
  }));
}

export default loadPromptfooTests();
