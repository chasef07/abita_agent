# Workflow State Guard Plan

## Goal

Move the highest-risk conversation rules out of prompt prose and into code-owned workflow state.

The agent should still speak naturally and choose tools, but side-effecting tools should only execute when the current call state allows them. The first version should be a small guard layer, not a full rewrite of the agent.

## Why This Helps

The current prompt carries too much behavioral enforcement:

- verify before patient tools
- ask reason before availability
- offer one loaded slot before booking
- wait for explicit confirmation before booking or cancelling
- do not use stale availability
- do not create duplicate patients
- do not retry ambiguous mutations
- use routed office state consistently
- do not transfer too early

Those rules are safety and sequencing rules. They are more reliable as code checks than as repeated instructions in the prompt.

## Implementation Shape

Add four small modules:

- `src/state.ts` - typed workflow state and state mutation helpers
- `src/tool-policy.ts` - pure guard functions for side-effecting tools
- `src/turn-state.ts` - compact dynamic state summary for the model
- `src/__tests__/workflow-guards.test.ts` - regression tests for bad model behavior

Keep `src/tools.ts` as the execution boundary. Tools should call policy helpers before any API or SIP side effect.

## State Additions

Extend `CallState` with workflow fields:

```ts
type ActiveFlow =
  | "none"
  | "schedule"
  | "cancel"
  | "reschedule"
  | "register"
  | "insurance_update"
  | "transfer";

type PendingAction =
  | {
      type: "book_appt";
      slot: SelectedSlot;
      spokenSummary: string;
      confirmed: boolean;
    }
  | {
      type: "cancel_appt";
      appointmentId: number;
      spokenSummary: string;
      confirmed: boolean;
    }
  | {
      type: "add_patient";
      requiredFieldsComplete: boolean;
      spokenSummary: string;
      confirmed: boolean;
    }
  | {
      type: "update_insurance";
      spokenSummary: string;
      confirmed: boolean;
    }
  | {
      type: "transfer_call";
      transferMessageSpoken: boolean;
      confirmed: boolean;
    };
```

Recommended `CallState` fields:

- `activeFlow`
- `pendingAction`
- `lastCompletedStep`
- `reasonForVisit`
- `lastAvailabilityQuery`
- `lastAvailabilityRaw`
- `selectedAppointmentId`
- `bookedSlotsThisCall`
- `callerConfirmedPatient`
- `effectiveOfficeKey`

## Transition Helpers

Keep these helpers boring and explicit:

```ts
startFlow(state, "schedule");
completeStep(state, "patient_verified");
setPendingAction(state, pendingAction);
confirmPendingAction(state, actionType);
clearPendingAction(state);
clearFlow(state);
```

These functions should be pure state transitions with no network calls.

## Tool Policy

Create pure guard functions:

```ts
canBookAppointment(state, params)
canCancelAppointment(state, params)
canAddPatient(state, params)
canUpdateInsurance(state, params)
canTransferCall(state)
```

Each guard returns:

```ts
type PolicyResult =
  | { ok: true }
  | { ok: false; message: string; missing?: string[] };
```

Tools use the result before side effects:

```ts
const policy = canBookAppointment(state, params);
if (!policy.ok) return policy.message;

if (!makeCurrentSpeechUninterruptible(ctx)) return "...";

return callApi(...);
```

## First Guards To Ship

### Booking

`book_appt` requires:

- verified patient
- active flow is `schedule` or `reschedule`
- latest availability exists
- requested slot exists in latest availability result
- `pendingAction.type === "book_appt"`
- pending slot matches requested slot
- pending action is confirmed
- exact slot was not already booked this call

### Cancellation

`cancel_appt` requires:

- verified patient
- appointment is loaded in state
- appointment is upcoming
- `pendingAction.type === "cancel_appt"`
- pending appointment ID matches requested appointment ID
- pending action is confirmed

### Registration

`add_patient` requires:

- no verified patient with same name
- insurance was checked and can proceed
- all required fields are present
- `pendingAction.type === "add_patient"`
- pending action is confirmed

### Insurance Update

`update_insurance` requires:

- verified patient
- insurance was checked and can proceed
- subscriber fields are present
- `pendingAction.type === "update_insurance"`
- pending action is confirmed

### Transfer

`transfer_call` requires:

- not already transferred
- transfer message was spoken or pending transfer action is confirmed
- active pending action is `transfer_call`

## Turn State Injection

Add a compact dynamic state summary each turn:

```xml
<turn_state>
flow: schedule
patient: verified Jane Doe
reason_for_visit: follow-up
availability: 5 slots loaded for 2026-05-04
pending_action: book 2026-05-04 09:00 with Dr. Noel
needed_next: caller confirmation
</turn_state>
```

Only include this when useful. Do not dump the whole state object into the prompt.

Implementation options:

- Minimal first version: add the summary to `buildPrompt()` from current state only at session start where possible.
- Better version: use LiveKit turn-completion/context hooks to inject ephemeral turn state before each LLM turn.

Before implementing the better version, verify the current LiveKit JS API against docs.

## Prompt Slimming

After guards are in place, trim `workspace/RUNBOOK.md`.

Keep compact flow outlines:

```md
Schedule: verify patient -> ask reason -> check availability -> offer one slot -> wait for yes -> book.
Cancel: verify patient -> load appointments -> read back target appointment -> wait for yes -> cancel.
Register: collect fields -> check insurance -> read back required details -> wait for yes -> create patient.
```

Remove or reduce repeated prose about:

- not booking before confirmation
- not cancelling before confirmation
- not using stale availability
- not duplicate-calling tools
- tool success being the source of truth
- canonical insurance reminders repeated in multiple places

The prompt should describe the conversation. Code should enforce permissions.

## Rollout Plan

### Phase 1 - Tool-State Foundation

- Add state fields and transition helpers.
- Add policy helpers for `book_appt` and `cancel_appt`.
- Wire guards into those two tools.
- Add tests for bad model behavior.

Acceptance:

- `book_appt` cannot run before confirmation.
- `book_appt` cannot use stale or unseen slots.
- `cancel_appt` cannot run before confirmation.
- `cancel_appt` cannot use unknown or past appointment IDs.

### Phase 2 - Registration And Insurance Guards

- Add pending action support for `add_patient`.
- Add pending action support for `update_insurance`.
- Make `check_insurance` store enough state to distinguish accepted, rejected, and needs-clarification plans.

Acceptance:

- `add_patient` cannot run without accepted insurance and complete fields.
- `update_insurance` cannot run without accepted insurance and confirmation.
- rejected or unclear insurance cannot leak into mutations.

### Phase 3 - Transfer Guard

- Add transfer pending action.
- Require transfer message/confirmation before SIP transfer.
- Keep existing uninterruptible mutation behavior.

Acceptance:

- duplicate transfer remains blocked.
- transfer cannot fire before the transfer message path is satisfied.

### Phase 4 - Dynamic Turn State

- Add `buildTurnStateSummary(state)`.
- Inject it only when `activeFlow !== "none"` or a pending action exists.
- Keep the summary short and deterministic.

Acceptance:

- prompt gets shorter, not longer.
- state summary tells the model exactly what is missing next.

### Phase 5 - Prompt Reduction

- Remove redundant guard prose from `RUNBOOK.md`.
- Keep flow outlines and voice behavior.
- Re-run conversation tests/evals against real failure modes.

Acceptance:

- no loss of safety behavior because policy tests own it.
- lower prompt size and fewer contradictory instructions.

## Test Plan

Add focused unit tests before broad evals:

- model tries to book before confirmation -> blocked
- model tries to book a stale slot -> blocked
- model repeats same booking -> blocked
- model tries to cancel unknown appointment -> blocked
- model tries to cancel before confirmation -> blocked
- model tries to register without insurance check -> blocked
- model tries to update insurance with rejected/unclear insurance -> blocked
- model tries transfer before transfer action is ready -> blocked

Then add scenario tests:

- normal schedule flow succeeds
- normal cancel flow succeeds
- reschedule books new slot before cancelling old appointment
- caller changes mind after pending booking, pending action clears
- caller switches from schedule to transfer, old pending action clears

## Non-Goals

- Do not rewrite the whole agent into many agents in the first pass.
- Do not add a large formal state machine library.
- Do not move every prompt rule into code at once.
- Do not block read-only tools like `lookup_knowledge` unless there is a concrete bug.

## Risks

- Too much state can make the agent rigid. Keep the first version limited to side effects.
- Confirmation detection can be brittle if based only on raw text. Prefer explicit model/tool handoff where possible.
- Turn-state injection must stay compact or it recreates prompt bloat.
- PR 70 has useful tool-state ideas but is stale against current `main`; salvage the patterns, do not merge it blindly.

## Definition Of Done

- Side-effecting tools are guarded by code, not just prompt text.
- Tests prove bad model tool calls are blocked.
- `RUNBOOK.md` is shorter after code guards land.
- Current LiveKit observability and interruption behavior remain intact.
- The implementation preserves fast first turn and does not add an extra pre-call dependency.
