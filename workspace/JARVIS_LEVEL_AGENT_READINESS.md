# Jarvis-Level Agent Readiness

This document defines what "Jarvis-level" means for the task-state scheduling agent and what must change before we should call it production-grade, market-leading, or better than the current `main` implementation.

## Current Verdict

The `task-state-rewrite-plan` branch is the right architecture direction. It is materially stronger than `main` because it moves the agent away from a monolithic prompt and toward:

- a small front-desk router
- focused workflow tasks
- explicit workflow state
- task-level tools
- safer appointment side effects
- better failure state
- per-turn state summaries
- interruption escape tools

It is not fully Jarvis-level yet. The remaining issues are not about adding a bigger prompt. They are about making the agent feel instant, context-aware, impossible to derail into stale state, and safe around real-world side effects.

## What Jarvis-Level Means Here

For this product, Jarvis-level does not mean a general assistant. It means the caller feels like they reached a highly competent front-desk operator who:

1. Answers immediately.
2. Understands intent before collecting data.
3. Remembers only what matters.
4. Never asks for information it already has.
5. Switches paths naturally when the caller changes their mind.
6. Uses tools only when needed and only with grounded inputs.
7. Never fabricates office facts, appointment slots, patient records, or booking outcomes.
8. Handles side questions mid-flow and resumes smoothly.
9. Recovers from backend failures without guessing.
10. Produces logs and analytics that let us improve it from real calls.

## Architecture Principles

### Fast First Turn

Voice users interpret silence as failure. The agent should greet fast and avoid waiting on slow backend work before the caller hears anything.

Target:

- caller hears greeting quickly after SIP connect
- phone lookup has a short budget or runs in the background
- lookup failure is treated as unknown identity, not as no match

### Scoped Context

The model should not carry the whole business in every turn. Router context should stay small. Task context should include only:

- base voice/persona rules
- task-specific instructions
- current structured state
- relevant recent conversation

State belongs in `session.userData`. Conversation history should be used for natural continuity, not as the source of truth for appointment, patient, or booking state.

### Grounded Side Effects

Any action that changes the real world must be grounded in state or tool output:

- booking requires a selected slot from the latest availability result
- cancellation requires a loaded appointment and caller confirmation
- transfer should be marked complete only after SIP transfer succeeds
- no tool failure should mutate state as if success happened

### Natural Conversation Control

The caller can interrupt, answer out of order, ask a side question, or switch intent. The agent should treat that as normal.

Target:

- answer side question with `lookup_knowledge`
- resume at the last useful step
- use workflow-change escape when the goal changes
- clear interruption state once the new path is accepted

## Current Strengths

### Router And Task Split

The top-level agent now routes intent instead of trying to complete every flow inside one giant prompt. Scheduling, rescheduling, confirmation, cancellation, identification, and registration live in scoped tasks/workflows.

Why it matters:

- lower prompt pressure
- smaller tool surface per phase
- more predictable workflows
- easier production debugging

### Explicit Call State

`CallState` now tracks identity, workflow, scheduling, insurance, and transfer state. This is the right foundation for a production voice agent.

Why it matters:

- real-world actions can depend on structured state, not loose chat history
- patient switching can reset stale scheduling fields
- workflow summaries can tell the model exactly what matters next

### Safer Failure Handling

The branch distinguishes lookup failure from no match and records workflow failures. Booking and cancellation now avoid mutating state on obvious failed API results.

Why it matters:

- fewer duplicate patient records
- fewer false "you're booked" or "it's cancelled" responses
- better transfer path when backend tools are unavailable

### Task Escape Tools

Tasks can now answer side questions, transfer, or request workflow changes instead of forcing the original task to continue.

Why it matters:

- callers do not behave like forms
- the agent can recover from "actually I need to cancel" mid-scheduling
- side questions do not require restarting the whole flow

## Blockers Before Calling It Jarvis-Level

### 1. Fast Greeting Before Slow Lookup

Problem:

The current runtime waits for phone lookup before starting the session and greeting. If AMD is slow, the first caller experience can be silence.

Required fix:

- start the session and greet quickly
- run lookup with a short timeout budget, or hydrate lookup state in the background
- if lookup arrives late, update `session.userData` and keep the conversation natural

Acceptance:

- slow AMD lookup does not delay greeting
- lookup failure does not create a new-patient assumption
- first user turn still has safe identity behavior

### 2. Slot Provenance For Booking

Problem:

`select_current_slot` can store whatever slot parameters the model emits. Booking validates against latest availability only if availability raw data exists.

Required fix:

- require `lastAvailabilityRaw` before selecting a slot
- validate the selected slot against latest availability before writing `selectedSlot`
- store a slot token or selected-slot provenance in state
- make booking require that selected slot provenance

Acceptance:

- model cannot invent slot params and book them
- stale availability results cannot book after patient/date/context changes
- booking always traces back to the latest valid availability result

### 3. Transfer State After Success Only

Problem:

Transfer state is marked before SIP transfer succeeds. If transfer fails, retries can be blocked.

Required fix:

- set `conversation.transferred = true` only after successful SIP transfer
- or reset it in the catch path

Acceptance:

- failed transfer can be retried once
- successful transfer still prevents duplicate transfer attempts

### 4. Prune Stale Turn State

Problem:

The agent appends `<turn_state>` system messages during active workflows and then copies chat context across tasks. Older state summaries can survive and conflict with newer structured state.

Required fix:

- keep authoritative state in `session.userData`
- inject one fresh state summary per task
- strip old `<turn_state>` messages when copying context into tasks
- keep recent user/assistant turns only for natural language continuity

Acceptance:

- no task sees stale selected slot, stale active flow, or stale target appointment from old system messages
- state summaries are compact and always current

### 5. Clear Interruption Lifecycle

Problem:

Workflow interruptions are recorded but not clearly cleared when the new path starts.

Required fix:

- clear `workflow.interruption` when the router accepts and launches the new workflow
- optionally keep a small `lastInterruption` audit field if needed for analytics

Acceptance:

- after a caller switches from schedule to cancel, the cancel workflow does not keep seeing "interrupted for cancel" forever
- summaries describe the current path, not a stale previous transition

### 6. Richer Working State Summaries

Problem:

Some critical context is only in chat history or raw tool output, not in the compact state summary.

Required fix:

- include selected slot details in booking state
- include selected appointment details in confirm/cancel/reschedule state
- include last availability date/status/nearest option
- include whether lookup data is caller-confirmed

Acceptance:

- every task can continue correctly from structured state alone
- booking and cancellation do not depend on the model remembering prior prose

### 7. Runtime Readiness Check

Problem:

Required env validation happens inside job entry. A bad deploy can look healthy until a real call starts.

Required fix:

- validate required runtime secrets at worker startup or prewarm
- fail deployment health early if required secrets are missing

Acceptance:

- missing LiveKit, AssemblyAI, Baseten, ElevenLabs, or AMD credentials fail before taking calls
- analytics secrets can warn without blocking calls

### 8. Clean Production Branch Path

Problem:

`main` currently contains a revert of the earlier task-state PR. A normal PR from the old task branch can understate the real diff.

Required fix:

- create a fresh production branch from latest `main`
- revert the revert or cherry-pick the task-state architecture
- apply latest hardening changes
- merge to `main` only after production checks pass

Acceptance:

- GitHub diff shows the actual architecture going to production
- deploy workflow runs from `main`

## Production Readiness Phases

### Phase 1: Must Fix Before Production

These are the minimum changes before the branch should become the live agent:

1. Fast greeting before slow lookup.
2. Validated slot provenance before booking.
3. Transfer state updated only after success.
4. Clear stale interruption state.
5. Clean production branch from `main`.

### Phase 2: Jarvis-Level Context Management

These changes make the agent feel much more intelligent under messy calls:

1. Prune old `<turn_state>` messages when entering tasks.
2. Make working state summaries fully self-sufficient.
3. Add compact task completion summaries back to router context.
4. Treat state as source of truth and chat history as conversational memory only.
5. Add explicit recovery paths for backend timeout, no availability, unclear patient, and caller switching patients.

### Phase 3: Market-Leading Scheduling Agent

These move it from production-ready to top-tier:

1. Real-call replay harness from transcripts.
2. Latency dashboards by phase: greeting, STT, LLM, TTS, AMD tools, transfer.
3. Tool-call decision audits for "should have transferred", "should have booked", "should have asked one more question".
4. Appointment-slot ranking policy based on office, provider, visit reason, insurance, patient age, and caller preference.
5. Post-call evaluator that labels every call outcome and top failure mode.
6. Production log drain for server-level startup and crash errors.

## Acceptance Criteria For Jarvis-Level

A call should pass these scenarios consistently:

1. Existing patient schedules without repeating DOB if phone lookup and first name confirm the patient.
2. Multiple patients on one phone number are handled with first name first and no HIPAA leakage.
3. New patient registration collects all required fields without guessing.
4. Caller asks office hours mid-scheduling, agent answers and resumes the next scheduling question.
5. Caller starts scheduling, then switches to cancel, and the agent changes path cleanly.
6. Caller asks for a human twice, agent transfers after the required message.
7. Availability returns no openings, agent does not re-query the same date in a loop.
8. Booking API fails, agent does not say the appointment is booked.
9. Cancellation API fails, agent does not say the appointment is cancelled.
10. Transfer API fails, agent can retry or explain the issue without getting stuck.
11. Slow phone lookup does not delay greeting.
12. Analytics and room cleanup run on hangup or transfer.

## Definition Of Done

We can call this Jarvis-level for production when:

- first greeting is fast even when AMD is slow
- every real-world side effect is grounded in current state
- task handoffs do not carry stale state summaries
- workflow interruptions clear cleanly
- selected slots and appointments are validated from tool results
- transfer retry behavior is correct
- required secrets fail fast before taking calls
- build, lint, and format checks pass
- at least one live SIP smoke call per office passes the production checklist
- the production branch is cleanly applied to `main`

## References

- LiveKit Workflows: https://docs.livekit.io/agents/logic/workflows/
- LiveKit Tasks and task groups: https://docs.livekit.io/agents/logic/tasks/
- LiveKit Agents and handoffs: https://docs.livekit.io/agents/logic/agents-handoffs/
- LiveKit Deployment: https://docs.livekit.io/deploy/agents/
