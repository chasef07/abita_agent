# Abita Agent Vision

## Purpose

This repo exists to run a production phone agent for Abita Eye Group.
The agent should answer routine office questions, identify callers,
help with scheduling and appointment changes, check insurance-related routing,
and transfer to a human when the software cannot safely complete the caller's
request.

The core product promise is not "sound smart." It is to complete narrow clinic
workflows accurately while protecting patients, staff time, and scheduling
state.

## Current Shape

The live agent is a small LiveKit voice runtime:

- `src/main.ts` owns the LiveKit session, pre-call bootstrap, analytics, call
  duration deadline, and room shutdown.
- `src/prompt.ts` assembles the static voice prompt from `workspace/SOUL.md` and
  `workspace/VOICE.md`.
- `src/state/call-state.ts` defines typed call state stored in
  `session.userData`.
- `src/runtime/tool-registry.ts` chooses the model-visible tools for the active
  office/trunk.
- `src/tools/*.ts` owns business actions, state transitions, middleware calls,
  and tool-level errors.
- `src/__tests__/*.test.ts` is the first line of defense against prompt,
  state, and tool-contract regressions.

Docs can explain intent, but runtime code is the source of truth when code and
docs disagree.

## Non-Negotiables

- State-changing side effects must be proven by tool execution, not by assistant
  narration.
- Caller identity, appointment ownership, booking tokens, cancellation, and
  rescheduling must be enforced in runtime state and tool code.
- Prompt wording can guide behavior, but it cannot be the only guardrail for a
  production side effect.
- Keep the live voice context small. Do not feed this whole document into every
  caller conversation.
- Preserve clinic-local time, office routing, patient identity, and middleware
  contracts as explicit data, not implied context.
- When the system is uncertain, it should ask for missing facts, transfer, or
  return a tool error instead of pretending it completed the task.

## What Success Looks Like

- A caller never hears that an appointment was booked, canceled, or rescheduled
  unless the corresponding tool path succeeded.
- The agent can recover from common caller ambiguity without losing the
  scheduling lane, active patient, or selected slot.
- Production analytics explain what happened: call identity state, tool
  executions, errors, transfers, duration, and key session events.
- Small changes are easy to verify with targeted tests before they reach live
  calls.
- Future agents working in this repo can infer the intended direction from this
  document, then validate their work against real code checks.

## Development Principles

- Every code change should be simple, elegant, targeted, and effective.
- Prefer narrow runtime fixes over broad prompt rewrites.
- Add state only when it closes a real ambiguity or protects a real side effect.
- Keep office-specific behavior in office/profile data or the relevant tool
  boundary.
- Keep middleware as the source of truth for backend availability, booking,
  cancellation, patient lookup, and insurance contract details.
- Use structured tool results, typed state, and tests to make important outcomes
  inspectable.
- Treat voice latency as a product constraint. Avoid bloated prompts, bloated
  tool lists, and unnecessary calls during live conversation.
- Build toward the most elegant voice agent: a small targeted prompt footprint,
  efficient state objects, and tools that do the real work at the right
  boundary.

## Agent Development Loop

Use this loop for Codex or any coding agent working on this project:

1. Read the stable context.
   - Read `VISION.md` and the relevant files in `src/`.
   - For behavior changes, inspect the current test file closest to the runtime
     path before proposing a fix.

2. State one concrete claim.
   - Example: "After a successful reschedule, a second `reschedule_appt` call
     for the same patient should no-op before any middleware I/O."
   - The claim must be specific enough that a test, type check, tool error, or
     production trace could prove it false.

3. Pick the thing that can say no.
   - TypeScript can reject impossible state shapes.
   - Vitest can reject bad state transitions and tool contracts.
   - ESLint/Prettier can reject sloppy integration.
   - Runtime `llm.ToolError` paths can reject unsafe live calls.
   - Production analytics can reject assumptions about what actually happened.

4. Make the smallest change that gives the claim a chance to pass.
   - Prefer editing the tool, state helper, or runtime boundary that owns the
     behavior.
   - Avoid moving behavior into the prompt when code can enforce it directly.

5. Run the narrow check first.
   - For a focused behavior change, run the closest Vitest file.
   - For type or contract changes, run `pnpm typecheck`.
   - For formatting-sensitive edits, run `pnpm format:check`.

6. Widen verification before finishing.
   - Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm format:check`
     when the blast radius touches shared runtime, tools, or prompt behavior.
   - If a check fails, treat the failure as signal, not friction. Update the
     claim or implementation and repeat.

7. Report the outcome in terms of evidence.
   - Say what changed.
   - Say which checks passed or failed.
   - Say what risk remains, especially if the check surface did not exercise a
     real call path.

## Production Transcript Review Loop

The most important recurring loop is not speculative code cleanup. It is reading
real calls from the last 25 hours, finding the highest-signal failures, and
changing the agent only when the evidence justifies it.

Use this loop for production-quality improvement:

1. Pull recent production calls.
   - Use the local env file `DATABASE_URL` for the portal database that stores
     `AgentCall` rows. Do not print or commit the connection string.
   - Query `agent_call` rows from the last 25 hours, using `startedAt`,
     `endedAt`, `status`, `sessionReport`, `toolExecutions`, `callState`,
     `sessionEvents`, and transcript/turn fields when present.

2. Inspect conversations before code.
   - Compare what the assistant said against the tool calls and tool outcomes.
   - Look for booking, cancellation, reschedule, insurance, identity, transfer,
     and routing claims that were not backed by the matching tool path.
   - Look for edge cases where the agent took a longer or less reliable path
     than the current state and tools made available.
   - Look for tool inefficiency: repeated calls, avoidable middleware I/O,
     stale state, missing preconditions, or unclear tool result shapes.

3. Rank by product risk.
   - Highest priority: caller heard a false side-effect claim, such as booking
     being complete without `book_appt`.
   - High priority: identity, appointment ownership, cancellation, reschedule,
     insurance, or routing ambiguity was handled unsafely.
   - Medium priority: the agent got to the right answer but used an inefficient
     or fragile tool/state path.
   - Low priority: wording polish that does not affect correctness, latency, or
     caller outcome.

4. Decide whether a change is justified.
   - Suggest a change only for a real bug, side-effect risk, edge case, or clear
     improvement toward the elegant voice-agent target.
   - If the transcripts do not show a real issue, report "no change" with the
     evidence reviewed.
   - Do not invent work or open a pull request just because the automation ran.

5. Patch only the owner of the failure.
   - If the failure is a side-effect boundary, fix the tool/runtime/state path.
   - If the failure is missing state, add the smallest state shape or selector
     that removes the ambiguity.
   - If the failure is an unclear tool contract, tighten the tool result,
     description, or precondition.
   - Use prompt edits only when the issue is truly instruction wording and no
     runtime guard would be more reliable.

6. Verify with something that can say no.
   - Add or update the closest behavior test for the transcript-backed failure.
   - Run the focused test first, then run broader checks when the touched
     surface requires it.
   - Keep the failure example tied to the production evidence so the regression
     cannot quietly return.

7. Report or open a draft PR.
   - Always report the calls reviewed, evidence found, and decision.
   - If no change is justified, stop at the report.
   - If a code change is justified and verified, open a draft PR to `main` with
     the transcript-backed claim, the rejected failure mode, the files changed,
     and the checks run.

## Automation Loop Prompt

For a recurring Codex automation, use a prompt in this shape:

```text
Read VISION.md, and the files relevant
to the current runtime path. Then load DATABASE_URL from the local env file
without printing it, and pull production AgentCall transcripts from the last 25
hours.

Inspect those conversations for the most important hallucinations, side-effect
claims, edge cases, tool inefficiencies, and state/tool-contract failures.
Compare assistant claims against toolExecutions, tool outcomes, callState,
sessionEvents, and transcript turns.

Suggest a change only if the transcript evidence shows a real bug, unsafe
side-effect risk, meaningful edge case, or a clear improvement toward a simpler,
more elegant voice agent with a small targeted prompt footprint and efficient
state/tool boundaries. If there is no evidence-backed change worth making,
report no change.

When a change is justified, state the claim, identify the check that can reject
it, and make the smallest targeted code or documentation change needed. Do not
rely on prompt wording alone for state-changing behavior. Prefer runtime state,
tool preconditions, typed contracts, tests, and real tool errors. Run the closest
focused check first, then run broader checks when the changed surface requires
it. If the change is verified, open a draft PR to main. Finish by reporting the
evidence reviewed, the claim, files changed, checks run, PR status, and remaining
risk.
```

## Default Check Set

Use these commands unless the task clearly needs a narrower or broader surface:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

For early iteration, start with the closest test file, then expand.

## Things This Vision Does Not Mean

- It does not mean every idea should become code.
- It does not mean Codex should make large autonomous changes without a failing
  test, concrete trace, or explicit user request.
- It does not mean this document belongs in the live phone prompt.
- It does not replace production call review, middleware contracts, or runtime
  observability.
