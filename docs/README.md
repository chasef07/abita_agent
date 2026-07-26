# Documentation

Runtime code and interface-level tests are the source of truth. Use this folder
only for agent workflow, provider operations, and sanitized incident history.

## Agent Workflow

- [`agents/issue-tracker.md`](agents/issue-tracker.md) — GitHub issue workflow.
- [`agents/triage-labels.md`](agents/triage-labels.md) — canonical triage labels.
- [`agents/domain.md`](agents/domain.md) — how engineering skills consume
  [`../CONTEXT.md`](../CONTEXT.md).

## Operations

- [`ops/assemblyai.md`](ops/assemblyai.md) — active AssemblyAI STT decisions and
  tuning notes.
- [`ops/call-capture.md`](ops/call-capture.md) — progressive call-capture
  receiver contract and deployment gate.
- [`ops/release-automation.md`](ops/release-automation.md) — Release Please and
  production LiveKit deployment contract.
- [`ops/telnyx-setup.md`](ops/telnyx-setup.md) — Telnyx-to-LiveKit SIP setup and
  troubleshooting. Recheck provider-console values before applying changes.

## History

- [`history/incident-2026-04-09-concurrent-dispatch.md`](history/incident-2026-04-09-concurrent-dispatch.md)
  — sanitized concurrency incident retained for operational context, not current
  runtime guidance.

Feature specifications and architecture decisions live in
[GitHub Issues](https://github.com/chasef07/abita_agent/issues). Runtime prompt,
office policy, knowledge, and insurance sources live in [`../workspace/`](../workspace/).
