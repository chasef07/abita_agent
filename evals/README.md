# Evals — the canonical audit + regression loop

This directory is the source of truth for prompt improvement.

Architecture overview:
- [ARCHITECTURE.md](/Users/chasefagen/livekit-agent/evals/ARCHITECTURE.md)

The machine has two layers:

1. `Production audit`
   - audits recent real calls into six business buckets plus quality dimensions
   - tells you what failed, why, and what the agent did well
   - renders `evals/output/audit-report.html`

2. `Promptfoo regression`
   - replays curated golden cases plus production-derived candidates
   - proposes prompt variants
   - tournaments them against the same suite
   - promotes nothing unless the gates pass

The important distinction is that promptfoo is not the whole eval system.
The audit layer finds problems; the regression layer validates fixes.

## Canonical loop

```bash
npm run optimize:nightly --              # full loop, no promote
npm run optimize:nightly -- --promote    # full loop, promote winner if gates pass
```

That loop does this:

1. sync recent production calls into candidate cases
2. audit recent production calls into structured records
3. promote repeated audit failures into promptfoo candidate coverage
4. run baseline promptfoo eval on golden + candidates
5. propose prompt variants from fresh failures + audit context
6. run a tournament across baseline and variants
7. select a winner with regression gates
8. append metrics to `evals/output/history.jsonl`
9. regenerate `evals/output/audit-report.html`
10. generate `evals/output/tool-recommendations.md` for non-prompt fixes

## Current artifacts

- `evals/output/audits-YYYY-MM-DD.json`
  - structured per-call production audit
- `evals/output/audit-report.html`
  - the quick-scan dashboard
- `evals/output/audit-candidates-*.json`
  - summary of audit-driven candidate generation
- `evals/output/tournament-*.json`
  - baseline vs variant scores
- `evals/output/winner-*.json`
  - final verdict for the round
- `evals/output/history.jsonl`
  - compact run history
- `evals/output/tool-recommendations.md`
  - tool-layer fixes that should be addressed in code/contracts instead of broad prompt edits

## Directory layout

```text
evals/
├── cases/
│   ├── golden/                 trusted regression set
│   └── candidates/             production-derived coverage, reviewable
├── lib/
│   ├── audit.ts
│   ├── extract-decision-points.ts
│   ├── io.ts
│   ├── normalize-call-events.ts
│   ├── run-decision-point-case.ts
│   └── types.ts
├── promptfoo/
│   ├── promptfooconfig.mjs
│   ├── livekit-agent-provider.mjs
│   ├── tests.mjs
│   ├── rubric-mappings.mjs
│   └── assertions/
│       └── decision-point.mjs
├── schemas/
│   └── decision-point-case.schema.json
├── scripts/
└── output/
```

## Canonical scripts

| Step | Script | npm | Output |
|---|---|---|---|
| sync recent calls | `sync-real-calls.ts` | `evals:sync`, `optimize:sync` | candidate case files |
| audit production calls | `audit-calls.ts` | `optimize:audit` | `audits-*.json` |
| cluster audit failures into candidates | `sync-audit-candidates.ts` | `optimize:audit-candidates` | `audit-candidates-*.json` + candidate case files |
| baseline eval | promptfoo | `evals:run` | promptfoo eval db |
| propose variants | `propose-variants.ts` | `optimize:propose` | `workspace-v*/` + `variants-*.json` |
| tournament | `tournament.ts` | `optimize:tournament` | `tournament-*.json` |
| select winner | `select-winner.ts` | `optimize:select` | `winner-*.json` |
| log metrics | `log-metrics.ts` | `optimize:metrics` | append `history.jsonl` |
| render dashboard | `generate-audit-report.ts` | `optimize:report`, `optimize:audit-report` | `audit-report.html` |
| summarize case inventory | `generate-case-coverage-report.ts` | `evals:coverage`, `optimize:coverage` | `case-coverage.md` |
| summarize tool-layer work | `generate-tool-recommendations.ts` | `evals:tool-recs`, `optimize:tool-recs` | `tool-recommendations.md` |
| clean variants | `clean-variants.ts` | `optimize:clean` | removes stale `workspace-v*/` |

## Scoring model

The production audit writes one structured record per call with:

- `intentBucket`
  - `new_patient`
  - `faq`
  - `immediate_transfer`
  - `confirm`
  - `cancel_rebook`
  - `existing_patient_booking`
- `resolved`
- `resolutionReason`
- `toolCorrectness`
- `pathEfficiency`
- `hallucinationSafety`
- `strengths`
- `failureModes`
- `recommendedFixes`

This is the diagnosis layer.

Promptfoo then validates fixes on:

- `golden`
  - trusted hand-curated regressions
- `candidates`
  - production-shaped cases, including audit-driven additions
  - most candidates use runbook-compliance grading only
  - audit-driven or explicitly strict candidates also enforce their case-level expectations

## Winner gates

A variant only wins if all of these hold:

1. golden pass count does not regress
2. no golden suite regresses by more than 5 percentage points
3. candidate overall pass rate does not regress by more than 2 percentage points
4. candidate suite pass rate does not regress by more than 10 percentage points for suites with enough baseline cases

This is why the loop can reject plausible-looking prompt edits that are actually worse.

## Provider configuration

The stack is provider-flexible now.

Use either OpenAI or Anthropic for:

- the production audit judge
- the prompt proposer
- the promptfoo LLM rubric grader

Common env:

| Var | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | sync + audit + audit-candidate clustering | required |
| `OPENAI_API_KEY` | audit + proposer + promptfoo grader | preferred current path |
| `ANTHROPIC_API_KEY` | audit + proposer + promptfoo grader | supported fallback |
| `PROMPTFOO_GRADER_PROVIDER` | promptfoo grader | optional override, e.g. `openai:gpt-4.1-mini` |
| `AUDIT_PROVIDER` | audit judge | optional override |
| `AUDIT_MODEL` | audit judge | optional override |
| `PROPOSER_PROVIDER` | proposer | optional override |
| `PROPOSER_MODEL` | proposer | optional override |
| `BASETEN_API_KEY` | real agent replay | required for the current provider path |
| `LIVEKIT_*` | replay fallback | only if you override model/replay plumbing |

If `OPENAI_API_KEY` is present, the current default path prefers OpenAI.

## PHI rules

- candidate case transcripts are sensitive and need review
- golden cases should be synthetic or redacted before commit
- audit/proposer outputs should refer to `callId` and turn numbers only
- no names, DOBs, member IDs, phone numbers, or addresses in summaries or hypotheses

## Running locally

Quick checks:

```bash
npm test
npm run evals:run
npm run evals:view
```

Production audit only:

```bash
npm run optimize:audit -- --hours 24 --limit 30
npm run optimize:audit-candidates
npm run optimize:report
npm run optimize:coverage
npm run optimize:tool-recs
```

Full loop:

```bash
npm run optimize:nightly
npm run optimize:nightly -- --promote
```

Manual loop:

```bash
npm run optimize:sync -- --hours 24
npm run optimize:audit -- --hours 24 --limit 30
npm run optimize:audit-candidates
npm run evals:run
npm run optimize:propose -- --variants 2
npm run optimize:tournament -- --include-candidates
npm run optimize:select
npm run optimize:metrics
npm run optimize:report
npm run optimize:coverage
npm run optimize:tool-recs
```

Open `evals/output/audit-report.html` after any audit run.
