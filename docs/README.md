# Documentation Map

Start here when you need context beyond the runtime code.

## Current Architecture

- `architecture/flow-controller-current-contract.md` — current enforced flow harness behavior.
- `architecture/flow-controller-spine.md` — longer design background for the harness.
- `architecture/flow-harness-hardening-spec.md` — proposed fixes for reschedule state, cancel confirmation, end-call handling, verification guards, availability sanitization, and fallback telemetry.
- `architecture/sdk-flow-testing-and-dynamic-tools.md` — next spec for LiveKit SDK-level flow tests and state-scoped tool exposure.
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
