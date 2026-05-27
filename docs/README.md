# Documentation Map

Start here when you need context beyond the runtime code.

## Current Architecture

- `architecture/flow-controller-current-contract.md` — current enforced flow harness behavior.
- `architecture/legacy-cleanup-and-next-steps.md` — cleanup record for the removed legacy runbook path and the remaining migration work.
- `architecture/task-plan-flow-harness.md` — historical planning spec for the task-plan direction; implementation and tests win when they differ.
- `architecture/precall-context-harness-spec.md` — target spec for harness-owned pre-call phone lookup, identity confirmation, multiple-match handling, appointment load state, and model-visible context injection.
- `architecture/flow-controller-spine.md` — longer design background for the harness.
- `architecture/flow-harness-hardening-spec.md` — historical issue analysis; superseded by `task-plan-flow-harness.md` for implementation details.
- `architecture/sdk-flow-testing-and-dynamic-tools.md` — current SDK-level flow tests and dynamic tool exposure; future tool exposure is superseded by planner-owned `allowedTools`.
- `architecture/context-management.md` — older context/session-state design notes.
- `architecture/language-observability.md` — language switching and telemetry design notes.

## Operations

- `ops/assemblyai.md` — active AssemblyAI STT setup notes.
- `ops/telnyx-setup.md` — SIP trunk setup and call testing notes.

## History

These are retained for audit/debug context, not first-pass implementation context.

- `history/workspace-changelog.md`
- `history/prompt-improvements.md`
- `history/workflow-state-guard-plan.md`
- `history/flow-harness-learnings.md`
- `history/roadmap.md`
- `history/incident-2026-04-09-concurrent-dispatch.md`
- `history/insurance-spring-hill-crystal-river-legacy.md`

Runtime prompt and customer knowledge files stay in `../workspace/`.
