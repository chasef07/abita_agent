# Agent Harness Learnings

## Purpose

This note captures the architecture decisions behind the stateful Jarvis
scheduling agent. The goal is to keep the reasoning separate from the phase
plan in `../architecture/flow-controller-spine.md`.

The core conclusion: the LLM should remain the conversational engine, but it
should not be the only holder of memory or safety policy. The harness gives the
agent durable state, compact per-turn context, and deterministic rules for
side-effecting tools.

## Current Runtime Shape

```txt
caller audio
  -> STT
  -> main LLM calls record_turn_understanding
  -> deterministic state reducer
  -> compact <turn_state> returned to the main LLM
  -> main LLM response and tool choice
  -> guarded tool execution
  -> state updates from tool outcome
```

This is not a rigid workflow engine. It is a memory and safety harness around a
voice agent.

## Roles

The main LLM owns:

- natural conversation
- empathy, brevity, and bilingual phrasing
- choosing the next user-facing response
- deciding when to call a tool
- handling interruptions and topic changes in a human way

The main LLM state-update tool call owns:

- proposing structured meaning from the latest caller turn
- recognizing semantic intent instead of keyword matches
- capturing corrections, negation, preferred windows, patient references, and
  appointment actions

The reducer owns:

- deciding whether the proposed understanding is trustworthy enough to write
- active intent
- active patient
- relationship to caller
- patient identity slots and provenance
- visit type and coverage type
- scheduling goal memory
- pending side effects
- stale availability and pending-action invalidation

The policy layer owns:

- whether risky tools are allowed now
- whether confirmation is required
- duplicate search blocking
- booking/cancellation preconditions
- safe no-op behavior for already-consumed side effects

## Why Not Keyword Intent

Keyword intent is brittle for voice scheduling. Examples:

- "Don't cancel it, I just need the time" contains the word cancel but means
  appointment confirmation.
- "Move it to next week" means reschedule even if appointment is not repeated.
- "For my daughter Emily" changes active patient even if the caller's phone
  lookup matched the parent.
- "Yes" may confirm a booking, answer a spelling prompt, or be a backchannel
  depending on current state.

The new path asks the model to propose meaning as structured data, then lets
code decide what to persist.

## State Update Tool vs Business Tool

`record_turn_understanding` is an internal tool call made by the main LLM. It is
not a business side-effect tool and it should never be mentioned to the caller.

Business tools do real work or ask middleware/provider systems to do real work:

- verify patient
- check insurance
- get availability
- book appointment
- cancel appointment
- transfer call

The state-update tool only sends a JSON-shaped understanding to the reducer:

```ts
{
  goal: "manage_existing_appointment",
  appointmentAction: "reschedule",
  patient: {
    patientMentioned: "caller",
    relationshipToCaller: "self"
  },
  scheduling: {
    preferredWindow: "next week mornings"
  },
  confidence: 0.88,
  evidence: ["move it", "next week", "mornings"]
}
```

That object is not trusted blindly. The reducer validates it with Zod, ignores
low-confidence turns, and applies deterministic invalidation rules. Guarded
business tools are blocked until `record_turn_understanding` has run for the
latest user turn.

## Same LLM, One Main-Agent Path

The current implementation does not use a separate hidden state-reader LLM
request.
The same main LLM receives the schema contract and must call
`record_turn_understanding` once at the start of the turn.

This is still not the LLM directly writing state. The LLM proposes structured
meaning through the tool schema, then TypeScript validates and reduces it into
official flow state.

The tradeoff:

- Main-agent tool path: one conversational model path and no extra hidden
  state-reader request.
- It may still take an additional model continuation after the internal tool
  returns, because the model must see the updated `<turn_state>` before safely
  speaking or calling business tools.
- A literal one-completion design would update state after the response, which
  is not safe for same-turn tool gating.

## LLM Is Still The Star

The harness does not replace the main LLM. It makes the main LLM better by
giving it the right memory at the right time.

Without the harness, the main LLM has to:

- remember every caller detail
- infer the active task
- decide whether state changed
- know whether a tool is safe
- remember which slot was offered
- avoid duplicate side effects

That is too much to rely on in a live voice call.

With the harness, the main LLM sees a compact state packet:

```xml
<turn_state>
intent: existing_appointment_reschedule
activePatient: caller
patientStatus: matched_not_verified
task: appointment_management
step: verify_patient
visitType: unknown
scheduling: reschedule collecting window=next week mornings
office: spring-hill
nextAction: ask_patient_name
blockedActions: add_patient, get_availability, book_appt
</turn_state>
```

The model still decides how to say the next thing. Code owns whether the memory
and side effects are valid.

## Pre-Call State Matters

The harness starts before the first caller turn. Phone lookup can preload:

- matched patient ID
- patient name and DOB
- upcoming appointments
- routing
- insurance hints
- allowed providers

That means the agent can cancel or reschedule from state without calling
`confirm_appt` again when the active patient and appointment are already loaded.
The hard requirements are still:

- active patient did not change
- appointment is loaded and upcoming
- caller explicitly confirmed cancellation
- side-effect pending action exists and is unconsumed

## What The Reducer Writes

The reducer currently writes:

- `activeIntent`
- `activeFlow`
- `step`
- `activePatientRef`
- patient identity slots
- relationship to caller
- `visitType`
- `coverageType`
- active patient insurance
- scheduling goal status
- appointment action
- preferred window
- selected slot ID
- booking confirmation signal
- note draft

It also invalidates stale downstream state when upstream facts change:

- patient change
- visit type change
- insurance change
- preferred window change

## Current Code Map

- `src/flow/understanding.ts`: schema, parser, reducer, state invalidation.
- `src/tools.ts`: `record_turn_understanding` internal tool applies the reducer
  and workflow tools are gated until the latest user turn is recorded.
- `src/agent.ts`: stores the latest caller transcript and requires
  `record_turn_understanding` before the next action.
- `src/main.ts`: stops final transcript keyword mutation.
- `src/flow/context.ts`: emits compact model-visible state.
- `src/__tests__/turn-understanding.test.ts`: reducer/schema coverage.
- `src/__tests__/transcript-eval-harness.test.ts`: semantic replay harness for
  known failure modes.

## Current Risks

1. **State update latency**
   - The separate state-reader timeout is gone.
   - Controlled calls must still capture time from user final transcript to
     first audible response because the main LLM may need an internal
     `record_turn_understanding` tool step before speaking.

2. **State update failures**
   - Invalid tool args or schema mismatch falls back to no state update or
     `unclear` handling.
   - That is safe, but it can miss useful memory updates.
   - We need state-update success/failure telemetry before broad deployment.

3. **Schema-update compliance**
   - The old keyword intent classifier has been removed from the flow package.
   - Controlled calls should verify that the model consistently calls
     `record_turn_understanding` before answer, lookup, confirmation, or
     side-effect tools.

4. **Schema gaps**
   - Real calls may expose missing fields, such as provider preference,
     appointment-specific correction, or caller relationship edge cases.
   - Add fields only when real call review proves the need.

5. **Stale intent carryover**
   - Backchannels should preserve task context, but incorrect unclear handling
     can keep stale intent alive too long.
   - This needs real-call review.

## Metrics Needed Before Broad Deployment

Capture per turn:

- state-update tool duration
- state-update success/failure
- state-update fallback reason
- state-update confidence
- proposed goal
- appointment action
- active patient before and after reducer
- invalidation reason when state is invalidated
- main LLM tool call after state packet

Capture per call:

- unresolved call outcome
- transfer outcome
- repeated availability count
- duplicate availability blocked count
- booking attempt count
- booking recovery outcome
- cancellation confirmation path
- patient switching events

## Controlled Real-Call Gate

Proceed to controlled real-call testing when:

- TypeScript passes.
- Unit and transcript evals pass.
- Lint and format checks pass.
- `git diff --check` passes.
- The runbook lists monitored numbers, stop conditions, and rollback.

Do not broaden traffic until controlled calls show:

- state-update latency is acceptable
- state-update failures are rare or harmless
- active patient state remains correct
- booking and cancellation side effects stay gated
- transfers and unresolved calls do not rise
- repeated availability loops improve

## Current Verdict

This is the right direction for Jarvis-level scheduling. The implementation is
now a stateful voice-agent harness, not just prompt engineering:

- LLM proposes meaning.
- Reducer owns memory.
- State packet guides the main LLM.
- Policy guards risky tools.
- Evals cover the known failure modes.

The next step is controlled real-call testing with latency and state-update
telemetry, not broad production deployment.
