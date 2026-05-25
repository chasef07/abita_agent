# Documentation Map

Start here when you need context beyond the runtime code.

## Current Architecture

- `architecture/task-plan-flow-harness.md` — source of truth for the next flow-harness implementation: whole-task phase, known facts, missing facts, planner-owned tool exposure, and appointment-management first slice.
- `architecture/flow-controller-current-contract.md` — current enforced flow harness behavior before the task-plan rewrite.
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
