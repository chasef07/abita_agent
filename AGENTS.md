# AGENTS.md

Telegraph style. Root rules only. Skills own workflows.
Use repo-relative refs in replies.

## Start

- Run `git status -sb`.
- Respect dirty worktrees.
- Read relevant code/config/tests before behavior claims.
- Runtime code beats docs.
- For call incidents, compare transcript claims to tool execution and final state.

## Evidence

- Behavior claims need source, tests, current behavior, and dependency-contract
  proof when relevant.
- Reviews need the changed module plus callers, callees, sibling behavior, and
  adjacent tests.
- LiveKit/provider behavior: inspect upstream docs/source/types when feasible.
- Weak evidence => say weak evidence.

## Commands

- Node 22.
- pnpm 10.34.3.
- Install: `pnpm install --frozen-lockfile`
- Checks:
  - `pnpm format:check`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`

If dependencies are missing, install once, retry once, then report the first
actionable error.

## Runtime Boundaries

- Side effects must be backed by successful tool execution.
- Fix behavior at the owning runtime/tool/state boundary before prompts.
- Keep prompts, tool lists, and state small.
- Middleware owns backend availability, booking, cancellation, patient lookup,
  and insurance contract details.

## Secrets / PHI

- Never print secrets.
- Treat transcripts, phone numbers, patient data, logs, env, and internal URLs
  as sensitive.
- Public GitHub bodies/comments must not include PHI, credentials, private URLs,
  or raw transcripts.

## Git / Delivery

- Stage only intended files.
- Push only when asked.
- For non-trivial code before final, commit, push, PR, or ship, use the
  code-review skill.
- Final report: files changed, checks run, accepted/rejected review findings,
  remaining risk.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See
`docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five default canonical labels. See
`docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.
