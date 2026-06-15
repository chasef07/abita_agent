# Abita Agent Vision

Abita Agent is the AI phone operator for Abita Eye Group.
It answers calls, follows clinic rules, and uses tools to do real scheduling work.

This document explains the current state and direction of the project.
We run production healthcare-adjacent workflows, so iteration must stay narrow,
evidence-backed, and easy to verify.
Project overview and developer docs: [`README.md`](README.md)

Abita Agent started as a voice agent that could answer routine office questions.
It has grown into a LiveKit runtime that can identify callers, route scheduling
lanes, check insurance-related rules, book appointments, reschedule, cancel, and
transfer when software should stop.

The goal is simple: complete narrow clinic workflows accurately while protecting
patients, staff time, and scheduling state.

Current priority:

- Safe identity, booking, reschedule, cancellation, and transfer boundaries
- Bug fixes from production calls and tests
- Setup and deployment reliability
- Small prompts, clear tool contracts, typed runtime state

Next priorities:

- Stronger production analytics and call-review loops
- More deterministic scheduling and insurance behavior
- Better first-run and operator debugging experience
- Leaner prompts, tool lists, and state objects
- Faster focused checks for common failure modes

## Runtime

The live agent is a small LiveKit voice runtime.
Runtime code is the source of truth when docs and code disagree.

Main ownership:

- `src/main.ts`: LiveKit session, pre-call bootstrap, analytics, deadlines, shutdown
- `src/prompt.ts`: static voice prompt assembly from `workspace/SOUL.md` and `workspace/VOICE.md`
- `src/state/call-state.ts`: typed state stored in `session.userData`
- `src/runtime/tool-registry.ts`: model-visible tools for the active office/trunk
- `src/tools/*.ts`: business actions, state transitions, middleware calls, tool errors
- `src/__tests__/*.test.ts`: regression coverage for prompt, state, and tool contracts

## Safety

The agent should never claim a state-changing action succeeded unless the tool
path actually succeeded.

Non-negotiables:

- Identity, appointment ownership, booking tokens, cancellation, and rescheduling
  belong in runtime state and tool code.
- Prompt wording can guide behavior, but it cannot be the only guardrail for a
  production side effect.
- Office routing, patient identity, local time, and middleware contracts must be
  explicit data.
- If the system is uncertain, it should ask for missing facts, transfer, or
  return a tool error.
- Keep live voice context small. Do not feed this document into calls.

## Development

Prefer the smallest code-path fix at the owner of the behavior.
Delete stale or duplicated logic before adding more.

Default loop:

1. Read the relevant runtime path.
2. State one concrete claim that a test, typecheck, tool error, or trace can reject.
3. Patch the owner of the failure: state, tool, runtime, prompt, or docs.
4. Run the closest check first.
5. Widen checks when shared runtime, tools, or prompt behavior changed.
6. Report what changed, what passed, and what risk remains.

Good changes make important outcomes inspectable through typed state, structured
tool results, tests, analytics, or real tool errors.

## Production Review

The highest-signal improvement loop is recent call review.
Read real `AgentCall` evidence before changing behavior.

Look for:

- Assistant claims that disagree with tool execution or final state
- Unsafe identity, booking, cancellation, reschedule, insurance, or routing paths
- Repeated or avoidable tool calls
- Missing state, unclear tool results, or fragile prompt-only behavior
- Cases where no change is justified

Patch only when the evidence shows a real bug, side-effect risk, edge case, or
clear simplification. No-change is a valid review outcome.

## Checks

Use the narrowest useful check first.
For broader changes, run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

## What We Will Not Merge (For Now)

- Broad prompt rewrites when a runtime or tool boundary should own the behavior
- New state that does not close a real ambiguity or protect a real side effect
- Large refactors without production evidence, failing tests, or explicit request
- Office-specific behavior outside office/profile data or the relevant tool
- Middleware-owned business logic duplicated in the agent
- Automation that opens PRs without evidence-backed changes and passing checks

This list is a guardrail, not a law.
Strong evidence and a smaller design can change it.
