# Flow Harness Hardening Spec

Status: historical issue analysis. Superseded for implementation by
`task-plan-flow-harness.md`.

Use `task-plan-flow-harness.md` as the source of truth when this document
conflicts with the newer planner design. In particular, the newer spec replaces
this document's older reschedule ledger with one model-facing `reschedule_appt`
action that carries the replacement appointment note payload.

Source trace: `SCL_GUJUpVwo8xwB`, reviewed on May 24, 2026.

## Purpose

The flow harness is already doing the right high-level job: the LLM captures
semantic meaning with `record_turn_understanding`, and TypeScript owns state,
sequencing, and side-effect safety. The next hardening pass should remove the
remaining places where workflow state can drift from the real caller request.

This spec covers seven issues found in the trace:

1. Reschedule intent was represented as cancellation state.
2. Replacement booking was not tied to a single reschedule ledger.
3. Explicit cancel confirmation was not owned by the reducer.
4. End-of-call "No" kept appointment-management state alive.
5. Verification allowed a guessed `lastName === firstName`.
6. Availability results exposed raw booking and AMD fields to the model.
7. Fallback telemetry counted adapter labels as real fallback models.

## Design Principle

Do not make the prompt carry these rules. The LLM should still speak naturally,
handle corrections, and propose structured intent. Code should own the workflow
routine once intent is known.

Keep `record_turn_understanding` as the only per-turn model-facing meta tool.
Add deterministic workflow routines behind it:

- `advanceNewPatientScheduling`
- `advanceExistingAppointmentReschedule`
- `advanceExistingAppointmentCancel`
- `advanceNoFurtherHelp`

These routines should return the existing compact command shape: ask a slot,
call a tool, confirm a side effect, respond, transfer, or end the call.

## Goals

- Represent "cancel it, I need a different time" as reschedule, not cancel.
- Keep reschedule state coherent from old appointment lookup through replacement
  booking, patient note, old cancellation, and final closeout.
- Make the reducer convert explicit confirmation into the exact pending action
  that the final side-effect tool will consume.
- Close the task cleanly when the caller says no after "anything else?"
- Prevent guessed patient-verification values from reaching middleware.
- Ensure model-visible availability results contain only speakable slot facts.
- Make fallback telemetry reflect actual model fallback, not wrapper labels.
- Add focused tests for each behavior before live rollout.

## Non-Goals

- Do not add a single broad `handle_patient_request` tool.
- Do not remove atomic business tools like `verify_patient`, `get_availability`,
  `book_appt`, or `cancel_appt`.
- Do not block quick FAQs, patient switches, corrections, or backtracking while a
  workflow is active.
- Do not change the external AMD or middleware contracts in this pass.
- Do not depend on LiveKit handoffs or task groups for this fix.

## Issue 1: Reschedule Misclassified As Cancel

### Failure

Caller said: "cancel it? I actually need a 1 PM."

The system treated the turn as `existing_appointment_cancel`, then later booked
a replacement and cancelled the original. The outcome was acceptable, but state
was contradictory:

- `activeIntent: existing_appointment_cancel`
- `activeFlow: scheduling`
- `currentTask.kind: schedule`
- `schedulingGoal.appointmentAction: cancel`

### Required Behavior

If a caller mentions cancelling or moving an existing appointment and also gives
a new desired time/date/window in the same turn, classify the workflow as
`existing_appointment_reschedule`.

Cancellation language in that context means "cancel the old appointment as part
of rescheduling", not "cancel only".

### State Requirement

Add a distinct reschedule state. Prefer explicit flow fields over overloading
`schedulingGoal.appointmentAction`.

```ts
type ReschedulePlanStatus =
  | "requested"
  | "loading_old_appointment"
  | "old_appointment_loaded"
  | "collecting_replacement_window"
  | "searching_replacement"
  | "offering_replacement"
  | "replacement_confirmed"
  | "replacement_booked"
  | "note_written"
  | "confirming_old_cancel"
  | "old_cancelled"
  | "complete"
  | "abandoned";

interface ReschedulePlan {
  id: string;
  patientRef: PatientRef;
  status: ReschedulePlanStatus;
  oldAppointmentId?: number;
  oldAppointmentSummary?: string;
  replacementAvailabilitySearchId?: string;
  replacementSlotId?: string;
  replacementSlotSummary?: string;
  replacementAppointmentId?: number;
  replacementAppointmentSummary?: string;
  oldCancellationConfirmed?: boolean;
  oldCancelled?: boolean;
  noteWritten?: boolean;
  createdTurnId: string;
  updatedAt: number;
}
```

Add this to `CallFlowState`:

```ts
reschedulePlan?: ReschedulePlan;
```

### Invariants

- While `reschedulePlan.status` is before `confirming_old_cancel`,
  `activeIntent` must be `existing_appointment_reschedule`, not
  `existing_appointment_cancel`.
- `schedulingGoal.appointmentAction` may be `reschedule` during replacement
  search/booking, but must not become `cancel` until the old cancellation is the
  active step.
- The active scheduling task may book the replacement, but the reschedule plan
  owns the overall workflow.

## Issue 2: Double Booking Without Final Appointment Concept

### Failure

The trace booked 8:30 AM, then booked 11:00 AM, then cancelled 8:30 AM. That is
correct for reschedule safety, because losing both appointments is worse than
temporarily holding both. The missing piece is a single ledger that explains why
two consumed booking actions exist.

### Required Behavior

Reschedule must be ledger-backed. A consumed replacement booking should not just
look like another ordinary scheduling action.

### Required Ledger Updates

- When the caller requests reschedule, create `reschedulePlan`.
- When `confirm_appt` returns appointments, set `oldAppointmentId` and
  `oldAppointmentSummary`.
- When replacement availability is offered, set
  `replacementAvailabilitySearchId`, `replacementSlotId`, and
  `replacementSlotSummary`.
- When `book_appt` succeeds for the replacement, set
  `replacementAppointmentId`, `replacementAppointmentSummary`, and
  `status: "replacement_booked"`.
- When `add_patient_note` succeeds, set `noteWritten: true` and
  `status: "note_written"`.
- When `cancel_appt` succeeds for the old appointment, set `oldCancelled: true`
  and `status: "complete"`.

### Final Appointment Concept

Expose a compact final-appointment capsule to the model:

```txt
reschedule: replacement booked; old appointment pending cancellation
replacement: Monday 11:00 AM with Dr. Noel
old appointment: Monday 8:30 AM with Dr. Noel
next action: confirm cancellation of old appointment
```

Do not expose raw appointment IDs unless the next tool call requires them.

## Issue 3: Reducer Does Not Own Cancel Confirmation

### Failure

The model sent `confirmation.cancelConfirmed: true`, but
`record_turn_understanding` returned another `confirm_cancel` command. The final
`cancel_appt` tool later auto-created and consumed the confirmation internally.

That works, but it makes side-effect authority too implicit.

### Required Behavior

The reducer must convert explicit caller confirmation into a confirmed pending
cancel action when all required facts are known.

### Confirmation Rule

If all are true:

- Current active step is `confirm_cancel` or
  `reschedulePlan.status === "confirming_old_cancel"`.
- The latest user turn is an explicit affirmative confirmation.
- The old appointment is loaded and has a stable appointment ID.
- The confirmation is for the specific spoken appointment summary.

Then `record_turn_understanding` should return:

```json
{
  "nextAction": "cancel_appt",
  "action": "call_tool",
  "tool": "cancel_appt",
  "args": { "appointmentId": 9961010 }
}
```

The reducer should create or mark the matching `pendingActions[]` item as:

```ts
{
  type: "cancel_appt",
  appointmentId,
  confirmed: true,
  consumed: false,
  confirmationTurnId: currentTurnId
}
```

The `cancel_appt` wrapper should still validate and consume the pending action.
It should no longer be the first component that decides confirmation exists.

## Issue 4: End-Of-Call "No" Interpreted As Appointment Management

### Failure

After the agent asked "Anything else?", the caller said "No." The spoken
response was fine, but `record_turn_understanding` kept
`manage_existing_appointment` and returned `confirm_appt`.

### Required Behavior

Add a no-further-help path.

Possible schema change:

```ts
type TurnGoal =
  | ...
  | "no_further_help";
```

or add a dedicated field:

```ts
conversationStatus?: "active" | "no_further_help";
```

### Controller Rule

If the current state is in an answer/closeout posture and the caller says no,
nope, that's all, nothing else, or similar:

- Set `activeFlow: "end"`.
- Set `step: "answer"` or a new `step: "end"` if added.
- Complete or clear the active task if no side effect is pending.
- Return `end_call` or `respond` with a closeout instruction.
- Do not call `confirm_appt`.

### Safety Rule

If there is a pending unconsumed side effect, "no" should not silently abandon it
unless the agent just asked whether to proceed with that side effect. In that
case, mark the pending action rejected/invalidated and return to answer.

## Issue 5: Too Many Verification Attempts And Guessed Last Name

### Failure

The trace reached `verificationAttempts: 6`, and one bad call used:

```json
{
  "firstName": "Kyle",
  "lastName": "Kyle",
  "dob": "08/18/2000"
}
```

The caller had not provided last name yet. The model guessed.

### Required Behavior

Add a verification policy guard before middleware:

- Block `verify_patient` when `lastName === firstName` unless the last name slot
  source is `caller_spelled` or the caller explicitly confirmed the last name is
  the same as the first name.
- After first-name plus phone returns multiple matches, ask for DOB or last name
  according to the tool result, but do not invent either slot.
- After DOB still does not uniquely verify the patient, ask: "What is the last
  name?" before another full verify.
- Add a max-attempt recovery posture. After too many failed verification calls,
  ask one focused correction question or transfer, rather than trying another
  guessed combination.

### Policy Output

Blocked verification should return a model-facing tool result like:

```json
{
  "outcome": "not_allowed",
  "reason": "last_name_not_provided",
  "speak": "Ask for the patient's last name before verifying again.",
  "retryable": false
}
```

## Issue 6: Availability Tool Result Leaks Raw Fields

### Failure

The model-visible `get_availability` result included:

- `bookingToken`
- `columnId`
- `profileId`
- `duration`
- `requiresForce`
- raw `datetime`

The wrapper stores slots in state, but still returns raw-ish slot objects to the
LLM.

### Required Behavior

Split slot storage from slot presentation.

Hidden session state keeps full booking material:

```ts
interface StoredAvailabilitySlot {
  slotId: string;
  bookingToken: string;
  columnId: number;
  profileId: number;
  startDatetime: string;
  duration: number;
  provider: string;
  publicProvider: string;
  spoken: string;
  date: string;
  time: string;
  requiresForce?: boolean;
}
```

Model-visible result returns only:

```ts
interface ModelAvailabilitySlot {
  slotId: string;
  spoken: string;
  provider: string;
  date: string;
  time: string;
  dateShifted?: boolean;
}
```

Allowed response shape:

```json
{
  "status": "success",
  "outcome": "availability_found",
  "requestedDate": "2026-05-25",
  "actualDate": "2026-05-25",
  "shouldRetrySameSearch": false,
  "nextAction": "offer_slots",
  "slots": [
    {
      "slotId": "J",
      "spoken": "2026-05-25 11:00 AM with Dr. Noel",
      "provider": "Dr. Noel",
      "date": "2026-05-25",
      "time": "11:00 AM"
    }
  ]
}
```

Duplicate-search blocked responses should also return sanitized cached slots.

## Issue 7: Fallback Telemetry Counts Adapter Labels

### Failure

The report showed `fallbackUsed: true`, but `usedModels` mostly contained the
primary model plus `FallbackAdapter` wrapper labels. That should not be treated
as actual fallback unless a real fallback child model emitted metrics.

### Required Behavior

Normalize model usage before reporting:

- Filter adapter/wrapper labels from `modelsUsed`, including `FallbackAdapter`
  and provider-prefixed variants that end in `/FallbackAdapter`.
- Keep actual model names, for example `zai-org/GLM-4.7`.
- Set `fallbackUsed: true` only if the configured fallback child model appears
  in normalized LLM metrics or provider metadata explicitly reports fallback
  selection.
- Keep raw metrics available in lower-level debug telemetry if needed.

Expected summary for the trace shape:

```json
{
  "modelsUsed": ["zai-org/GLM-4.7"],
  "fallbackUsed": false
}
```

## Workflow Routines

### `advanceExistingAppointmentReschedule`

Inputs:

- `CallFlowState`
- latest `TurnUnderstandingStateUpdate`

Responsibilities:

1. Ensure active patient is verified or ask for patient identity.
2. Ensure current appointments are loaded or call `confirm_appt`.
3. Select the old appointment if only one exists; otherwise ask which one.
4. Preserve the desired replacement window if the caller gave one.
5. Search availability when patient, visit type, old appointment, and desired
   window are ready.
6. Offer a replacement slot.
7. Book the confirmed replacement slot.
8. Add patient note only after replacement booking succeeds.
9. Ask explicit confirmation to cancel the old appointment.
10. Cancel the old appointment only after reducer-owned confirmation.
11. Close with the final replacement appointment summary.

### `advanceExistingAppointmentCancel`

Responsibilities:

1. Ensure active patient is verified.
2. Load current appointments.
3. Ask which appointment if multiple are loaded.
4. Read back exact appointment details.
5. Convert explicit confirmation into pending cancel action.
6. Call `cancel_appt`.
7. Close or ask if anything else is needed.

### `advanceNoFurtherHelp`

Responsibilities:

1. Detect caller closing turns only in answer/closeout posture.
2. Complete active tasks when no pending side effects remain.
3. Return `end_call` or a short closeout response.
4. Avoid appointment lookup, availability search, or verification.

## Model-Visible Context Changes

Add a reschedule capsule when a plan exists:

```xml
<context_capsules>
reschedule: replacement booked; old cancellation needs confirmation
oldAppointment: Monday 8:30 AM with Dr. Noel
replacementAppointment: Monday 11:00 AM with Dr. Noel
nextSafeAction: confirm_old_cancellation
</context_capsules>
```

Do not expose:

- booking tokens
- cancel tokens
- column IDs
- profile IDs
- appointment IDs unless the next required tool call needs one
- raw tool output

## Affected Files

Likely implementation targets:

- `src/flow/types.ts`
- `src/flow/understanding.ts`
- `src/flow/controller.ts`
- `src/flow/turn-router.ts`
- `src/flow/context.ts`
- `src/flow/pending-actions.ts`
- `src/flow/policy.ts`
- `src/tools.ts`
- `src/tooling/tool-exposure.ts`
- `src/call-observability.ts`

Likely test targets:

- `src/__tests__/turn-understanding.test.ts`
- `src/__tests__/flow-controller.test.ts`
- `src/__tests__/transcript-eval-harness.test.ts`
- `src/__tests__/tool-interruptions.test.ts`
- `src/__tests__/tool-exposure.test.ts`
- `src/__tests__/call-observability.test.ts`

## Test Plan

Add tests before implementation.

### Reschedule Intent

Input:

```txt
Yeah, can you cancel it? I actually need a 1 PM.
```

Expected:

- `activeIntent: existing_appointment_reschedule`
- `reschedulePlan.status: requested`
- `schedulingGoal.appointmentAction: reschedule`
- no `confirm_cancel` command before replacement booking

### Reschedule Ledger

Simulate:

1. Original 8:30 appointment exists.
2. Caller asks for 1 PM.
3. No 1 PM slot exists; 11:00 is offered.
4. Caller confirms 11:00.
5. Replacement booking succeeds.
6. Note write succeeds.
7. Caller confirms old cancellation.
8. Old cancellation succeeds.

Expected:

- `replacementAppointmentId` is set after replacement booking.
- `oldCancelled` is false until `cancel_appt` succeeds.
- Final state is `reschedulePlan.status: complete`.
- The final active appointment capsule points at 11:00.

### Reducer-Owned Cancel Confirmation

Given `reschedulePlan.status: confirming_old_cancel`, loaded old appointment,
and caller says "Yes":

Expected:

- `record_turn_understanding` returns `cancel_appt`.
- Pending cancel action exists before `cancel_appt.execute`.
- `cancel_appt` consumes that pending action.

### End Call

Given the agent just asked "Anything else?" and caller says "No":

Expected:

- no `confirm_appt`
- no `get_availability`
- no `verify_patient`
- state moves to `activeFlow: end`
- command is `end_call` or `respond` closeout

### Verification Guard

Given first name Kyle and DOB known, but no last name slot:

Expected:

- `verify_patient({ firstName: "Kyle", lastName: "Kyle", ... })` returns
  `not_allowed`.
- The command asks for last name.

Given last name was explicitly spelled as Kyle:

Expected:

- verification is allowed.

### Availability Sanitization

Given middleware returns full slot data:

Expected model-visible slot fields:

- `slotId`
- `spoken`
- `provider`
- `date`
- `time`
- optional `dateShifted`

Forbidden model-visible fields:

- `bookingToken`
- `columnId`
- `profileId`
- `duration`
- `requiresForce`

### Fallback Telemetry

Given metrics include `zai-org/GLM-4.7` and `FallbackAdapter` labels only:

Expected:

- `modelsUsed: ["zai-org/GLM-4.7"]`
- `fallbackUsed: false`

Given metrics include two real child models:

Expected:

- both real models appear
- `fallbackUsed: true`

## Rollout Acceptance Criteria

Before live deployment:

- Unit tests cover all seven issues.
- Transcript eval includes the exact `cancel it, I actually need a 1 PM` shape.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, and relevant prettier checks pass.
- Real-call trace review shows no contradictory
  `activeIntent: existing_appointment_cancel` during replacement booking.
- Availability model-visible outputs no longer contain booking tokens or AMD
  internals.
- No increase in average TTFT or total latency beyond the existing harness
  baseline.
- No bad side effects: no cancellation before explicit cancellation
  confirmation, no replacement booking without exact slot confirmation, and no
  duplicate transfer/cancel/booking side effects.

## Implementation Order

1. Add schema/tests for reschedule classification and no-further-help.
2. Add `ReschedulePlan` state and context capsule tests.
3. Implement `advanceExistingAppointmentReschedule`.
4. Move cancel confirmation ownership into the reducer/pending-action layer.
5. Add verification guard for guessed last names.
6. Sanitize availability model-facing results.
7. Normalize fallback telemetry.
8. Run the local validation bundle and replay the trace shape through transcript
   eval.
