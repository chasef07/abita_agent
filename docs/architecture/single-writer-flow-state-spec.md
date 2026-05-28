# Single-Writer Flow State Spec

Status: implemented feature-branch spec. The reducer facade, transfer safety,
booking-confirmation safety, patient recording, planner command application,
workflow step updates, side-effect creation, side-effect consumption, and the
source reschedule incident are now routed through reducer events on
`codex/single-writer-flow-state-spec`.

Compatibility boundary: session mirror fields still exist where tool execution
or middleware contracts require them, and a few legacy helper functions remain
as reducer-internal adapters. The public workflow write path is now
`reduceFlowEvent(flow, event)`.

Source incident: `SCL_LUzHeJyBF4M6`, reviewed on May 27, 2026.

## Goal

Move durable workflow state to one writer.

The target runtime is:

```txt
caller turn
  -> understanding emits event candidates
  -> reducer applies accepted events
  -> planner derives the next command from state
  -> model speaks or calls an allowed tool
  -> tool returns facts
  -> reducer applies tool-result events
  -> planner derives the next command again
```

Only the reducer writes durable workflow state. Understanding, planner, policy,
and tools can propose events or return facts, but they do not directly advance
workflow state.

## Why

The current flow harness has too many state writers:

- `src/flow/understanding.ts` parses caller turns and mutates flow facts.
- `src/flow/intent.ts` changes `activeIntent`, `activeFlow`, `step`, and
  `currentTask`.
- Older `src/flow/plans/common.ts` logic applied planner state patches.
- Tool bodies in `src/tools.ts` mutate session and flow state after execution.
- Policy helpers in `src/tools.ts` can create confirmed pending actions while a
  side-effect tool is being evaluated.

That makes state hard to audit. If `activeIntent` becomes wrong, the transition
may have come from a parser heuristic, an intent starting point, a planner
patch, a tool result, or a side-effect helper.

The `SCL_LUzHeJyBF4M6` trace showed two concrete failures:

1. The caller said "Appointment changes." The deterministic parser matched the
   generic word `appointment` but not the plural `changes`, so the flow became
   `new_appointment` instead of `existing_appointment_reschedule`.
2. `transfer_call` was allowed because policy/tool code auto-created a
   confirmed pending transfer action from the same tool call. The final state
   shows the pending transfer `createdTurnId` and `confirmationTurnId` as the
   same tool-call id.

Both are symptoms of state ownership being spread across layers.

## Non-Goals

- Do not replace the LLM with a deterministic menu.
- Do not remove the planner.
- Do not remove the pending-action ledger.
- Do not remove tool guards.
- Do not rewrite every workflow in one PR.
- Do not introduce LiveKit Tasks or handoffs for this state layer.
- Do not change middleware contracts as part of this migration.

## Simplicity Requirements

This migration only succeeds if it makes the current implementation smaller to
reason about.

The implementation should reduce the number of durable state write paths from
many to one:

```txt
today:
  understanding writes state
  intent writes state
  planner patches state
  tools write state
  policy helpers write pending actions

target:
  reducer writes state
  every other layer returns facts, events, commands, or policy decisions
```

The reducer can be internally modular, but the public write path must stay
single:

```ts
reduceFlowEvent(flow, event)
```

Do not make the LLM choose from a large state-machine menu. The LLM-facing
surface should stay small and semantic:

```ts
type CallerTurnMeaning = {
  intent?:
    | "new_appointment"
    | "existing_appointment_confirm"
    | "existing_appointment_cancel"
    | "existing_appointment_reschedule"
    | "insurance_question"
    | "faq"
    | "transfer_request"
    | "unclear";
  facts?: {
    patient?: PatientIdentityFacts;
    scheduling?: SchedulingFacts;
    insurance?: InsuranceFacts;
    appointment?: AppointmentManagementFacts;
  };
  confirmation?: {
    type: "booking" | "cancel" | "reschedule" | "transfer" | "route_office";
    confirmed: boolean;
  };
  topicSwitch?: boolean;
  evidence: string[];
  confidence: number;
};
```

Small event-builder functions turn this semantic shape into reducer events. The
model does not need to know `activeFlow`, `step`, `taskPlans`, or pending-action
internals.

## LLM State Mobility Contract

The LLM must be able to move between states easily by saying what the caller is
trying to do, not by naming implementation states.

Allowed model-level moves:

- Start or switch to a new appointment.
- Start or switch to existing appointment confirmation.
- Start or switch to existing appointment cancellation.
- Start or switch to existing appointment reschedule.
- Ask or answer an insurance question.
- Ask or answer an FAQ.
- Request transfer to a human.
- Provide patient identity facts.
- Provide scheduling facts like visit reason, preferred window, selected slot,
  appointment reason, or referring doctor.
- Confirm or deny the currently pending side effect.

The reducer decides whether the move is accepted, interrupts the current task,
pushes a return task, resumes a prior task, or asks a clarifying question. This
keeps topic changes flexible without letting the LLM mutate durable state
directly.

Example topic switch:

```txt
active task: scheduling appointment
caller: What time do you close?
LLM meaning: intent=faq, topicSwitch=true
reducer: pushes scheduling task, starts FAQ task
planner: call lookup_knowledge
tool result: answer returned
reducer: completes FAQ task and resumes scheduling
```

Example reschedule switch:

```txt
active task: generic scheduling
caller: Actually I need to move my appointment.
LLM meaning: intent=existing_appointment_reschedule, topicSwitch=true
reducer: invalidates incompatible new-booking facts, starts reschedule task
planner: ask identity or use verified patient state
```

## Ownership Model

### Understanding

Understanding owns semantic extraction only.

It may emit:

- caller intent candidates
- patient identity facts
- scheduling facts
- appointment-management facts
- confirmation facts
- topic-switch facts

It must not directly write:

- `activeIntent`
- `activeFlow`
- `step`
- `currentTask`
- `taskPlans`
- `schedulingGoal`
- `pendingActions`
- `pendingConfirmation`

### Reducer

The reducer owns all durable state transitions.

It receives typed events and writes:

- active flow and intent
- active patient
- patient identity and verification state
- task frames
- task plans
- scheduling goal facts
- pending confirmations
- pending side-effect actions
- availability cache invalidation
- transition log entries

### Planner

The planner becomes pure.

It receives `CallFlowState` and returns a `WorkflowCommand`.

It may derive:

- phase
- known facts
- missing facts
- next action
- allowed tools
- blocked actions
- spoken instruction
- tool args

It must not return or apply durable `statePatch`. Planner output carries the
task plan plus explicit transition fields; reducer events apply those fields.

### Policy

Policy only gates tool execution.

It may return:

- allowed
- blocked reason
- safe `ToolOutcome`
- guard observation

It must not create confirmed pending actions. A side-effect tool is allowed only
when reducer-owned state already contains the required confirmed pending action.

### Tools

Tools execute side effects and return facts.

They may:

- call middleware
- call SIP transfer
- return structured success, retry, or failure facts
- dispatch a tool-result event after execution

They must not decide workflow phase or create their own confirmation state.

## Core Types

Add `src/flow/events.ts`.

Internally, the reducer can use specific event types. Externally, callers should
prefer building events through the helpers in `events.ts` from
`CallerTurnMeaning`, tool results, and system decisions. This avoids forcing
every caller to know the full event taxonomy without adding another workflow
file.

```ts
export type FlowEvent =
  | UserIntentRecognizedEvent
  | PatientIdentityCapturedEvent
  | PatientVerifiedEvent
  | AppointmentsLoadedEvent
  | SchedulingFactCapturedEvent
  | AppointmentManagementRequestedEvent
  | TransferRequestedEvent
  | TransferPushbackOfferedEvent
  | TransferConfirmedEvent
  | SideEffectPendingCreatedEvent
  | ToolSucceededEvent
  | ToolFailedEvent
  | FactsInvalidatedEvent;

export interface FlowEventBase {
  id: string;
  type: string;
  createdAt: number;
  source:
    | "deterministic_understanding"
    | "model_understanding"
    | "tool_result"
    | "policy"
    | "planner"
    | "system";
  transcript?: string;
  confidence?: number;
  evidence?: string[];
}
```

Representative events:

```ts
export interface AppointmentManagementRequestedEvent extends FlowEventBase {
  type: "appointment_management_requested";
  action: "confirm" | "cancel" | "reschedule";
  patientRef: PatientRef;
}

export interface TransferRequestedEvent extends FlowEventBase {
  type: "transfer_requested";
  reason: "human_request" | "clinical_or_admin_escalation" | "partial_failure";
  patientRef?: PatientRef;
}

export interface TransferConfirmedEvent extends FlowEventBase {
  type: "transfer_confirmed";
  confirmed: boolean;
  patientRef?: PatientRef;
}

export interface ToolSucceededEvent extends FlowEventBase {
  type: "tool_succeeded";
  toolName: WorkflowToolName;
  outputClass: string;
  facts: Record<string, unknown>;
}
```

Add a transition log field to `CallFlowState`:

```ts
transitionLog?: FlowTransition[];

export interface FlowTransition {
  eventId: string;
  eventType: FlowEvent["type"];
  source: FlowEventBase["source"];
  before: FlowTransitionSnapshot;
  after: FlowTransitionSnapshot;
  changed: string[];
  createdAt: number;
}
```

The snapshot should be compact:

```ts
export interface FlowTransitionSnapshot {
  activeIntent: IntentKind | null;
  activeFlow: ActiveFlow;
  step: FlowStep;
  activeTaskPlanId?: string;
  currentTaskId?: string;
  patientStatus: PatientStatus;
  pendingActions: number;
}
```

## Reducer Contract

Add `src/flow/event-reducer.ts`.

```ts
export function reduceFlowEvent(
  flow: CallFlowState,
  event: FlowEvent,
): FlowReduceResult {
  const before = snapshotFlowTransition(flow);
  applyFlowEvent(flow, event);
  const after = snapshotFlowTransition(flow);
  appendTransition(flow, event, before, after);
  return { event, before, after, changed: changedFields(before, after) };
}
```

Reducer invariants:

- A caller turn can produce multiple events, but durable state is applied in a
  deterministic order.
- Existing appointment management wins over generic scheduling when both are
  plausible.
- Transfer request detection wins over generic "make appointment" scheduling
  language when the caller asks for a person, representative, or office staff.
- `transfer_call` cannot run unless a confirmed transfer pending action exists.
- `cancel_appt` cannot run unless a confirmed cancel pending action exists.
- `book_appt` cannot run unless a confirmed booking pending action exists.
- Tool result events are the only way to mark side effects consumed.
- Patient-changing events invalidate downstream patient-scoped pending actions.
- Availability-changing events invalidate stale selected slots.

## Event Priority

For each caller turn, event candidates are prioritized before reduction:

1. Emergency or clinical escalation.
2. Explicit transfer or human request.
3. Cancellation or reschedule of an existing appointment.
4. Confirmation or denial for the active pending confirmation.
5. Patient identity facts requested by the current command.
6. Scheduling facts requested by the current command.
7. Insurance facts requested by the current command.
8. Generic scheduling intent.
9. FAQ.
10. Backchannel or unclear.

This prevents the `SCL_LUzHeJyBF4M6` failure where "Can I talk to somebody to
make the appointment?" was treated as generic scheduling because it contained
`appointment`.

## Transfer Flow

Target behavior:

```txt
Caller: Can I talk to somebody?
event: transfer_requested
reducer: if recoverable scheduling and pushback not offered, mark pushback
planner: respond with one help-first pushback

Caller: I need to talk with somebody.
event: transfer_requested
reducer: create pending transfer confirmation, not confirmed
planner: ask explicit transfer confirmation

Caller: Yes.
event: transfer_confirmed
reducer: mark pending transfer confirmed
planner: call transfer_call

transfer_call succeeds
event: tool_succeeded transfer_call
reducer: mark pending transfer consumed and terminal handoff state
```

Implementation rules:

- Remove tool-call-time transfer auto-confirmation.
- Add a reducer path that creates `pending_transfer_call_*` only from
  `transfer_requested` or `transfer_confirmed` events.
- Policy requires the confirmed pending transfer action before allowing
  `transfer_call`.
- The tool still handles duplicate in-flight transfers and already-transferred
  no-ops, because those are execution safety checks.

## Appointment Reschedule Flow

Target behavior for the source incident:

```txt
Caller: Appointment changes.
event: appointment_management_requested action=reschedule
reducer: activeIntent=existing_appointment_reschedule
planner: ask identity or call verify_patient if enough identity exists

verify_patient succeeds and loads appointment
event: patient_verified + appointments_loaded
reducer: stores verified patient and old appointment list
planner: ask replacement window

Caller: for next week
event: scheduling_fact_captured preferredWindow=next week
reducer: attaches preferred window to reschedule task
planner: get availability or ask any missing note facts
```

Implementation rules:

- `appointment changes`, `appointment change`, `change appointment`,
  `changed appointment`, `changing appointment`, `move appointment`,
  `different day`, `different time`, and `next week instead` map to
  appointment-management reschedule when the subject is an existing appointment.
- Generic `appointment` scheduling intent must not override an active
  appointment-management task unless the caller explicitly asks to schedule a
  separate new appointment.
- Existing loaded appointments satisfy the old-appointment lookup prerequisite
  when there is exactly one upcoming appointment.
- Reschedule still books the replacement first and cancels the old appointment
  only after replacement booking succeeds.

## Compatibility Plan

Do not convert the whole harness in one cut. Use a reducer facade first.

### Phase 0: Spec and Transition Audit

Deliverables:

- This spec.
- `FlowTransition` snapshots.
- Audit comments or tests identifying current state writers.
- A `CallerTurnMeaning` shape that preserves the current
  `record_turn_understanding` ergonomics while routing accepted changes through
  the reducer.

No runtime behavior change.

### Phase 1: Reducer Facade

Status: implemented in this branch.

Deliverables:

- `src/flow/events.ts`
- `src/flow/event-reducer.ts`
- `reduceFlowEvent` logs transitions.
- Existing `advanceWorkflow` is refactored internally to emit events, but its
  public return shape remains stable.
- Existing deterministic and model-provided turn understanding are converted to
  `CallerTurnMeaning`, then to events.

Behavior target:

- No user-visible behavior change.
- Every change to `activeIntent`, `activeFlow`, `step`, `currentTask`,
  `activeTaskPlanId`, `schedulingGoal`, or `pendingActions` gets a transition
  log entry.

### Phase 2: Transfer Reducer Ownership

Status: implemented in this branch.

Deliverables:

- Transfer request and confirmation events.
- Transfer pending action creation moves to the reducer.
- `transfer_call` policy blocks unconfirmed transfers.
- `planTransfer` becomes pure over reducer-owned state.

Required tests:

- First human request during recoverable scheduling produces pushback only.
- Second human request asks explicit transfer confirmation.
- Affirmative confirmation creates confirmed pending transfer action.
- `transfer_call` without confirmed transfer is blocked.
- `transfer_call` with confirmed transfer succeeds.
- Duplicate in-flight transfer still no-ops safely.

### Phase 3: Appointment Management Reducer Ownership

Status: implemented for the incident and safety-critical reschedule path. The
source incident now replays as reschedule intent, reschedule preferred-window
facts stay attached to the reschedule task, replacement booking must be
confirmed through the reducer, and old-appointment cancellation still waits for
successful replacement booking.

Deliverables:

- Appointment confirm, cancel, and reschedule events.
- Existing appointment selection and loaded appointment facts move through the
  reducer.
- Reschedule preferred window and selected replacement slot are reducer-owned.
- Planner reads state and returns command only.

Required tests:

- `Appointment changes.` becomes `existing_appointment_reschedule`.
- The full `SCL_LUzHeJyBF4M6` transcript reaches reschedule state before human
  transfer.
- `for next week` is a replacement window in reschedule, not a visit reason.
- Reschedule cannot call `cancel_appt` before replacement booking succeeds.
- Replacement booking carries appointment reason and referring doctor.

### Phase 4: Scheduling and Insurance Reducer Ownership

Status: implemented for caller-turn facts, booking safety, and scheduling-path
transition ownership. Booking confirmation is reducer-owned, unconfirmed
booking actions are blocked by policy, and stale/consumed booking actions are
handled through the pending action ledger. `prepareSchedulingPath` no longer
returns a `statePatch`; it returns an explicit transition shape consumed by the
reducer. Insurance checks, routine-vision routing, availability visit context,
and tool-driven workflow steps now emit reducer events. Session mirror fields
remain only for middleware compatibility.

Deliverables:

- New appointment scheduling facts move through events.
- Insurance plan and coverage facts move through events.
- Availability search invalidation moves through reducer events.
- Planner state patches are removed from scheduling.

Required tests:

- Routine vision routing still routes Crystal River through Spring Hill.
- Duplicate availability search guards still work.
- Booking confirmation and stale-slot invalidation still work.
- New patient registration still checks insurance first.

### Phase 5: Remove Legacy Patch Writers

Status: implemented for planner command application and side-effect write
paths. `applyPlannerPatch` was removed, `WorkflowCommand.statePatch` was
removed, planner commands carry the concrete task plan plus explicit transition
fields, `ToolOutcome.statePatch` was removed, generic workflow step updates go
through `workflow_step_updated`, tool success consumes pending actions via
`tool_succeeded`, and tool-layer patient, insurance, routing, guard, and
reschedule progress writes now emit reducer events. Legacy helper functions
that remain are reducer-internal adapters or session mirror updates, not
alternate public workflow writers.

Deliverables:

- Remove durable `statePatch` from `WorkflowCommand`.
- Delete or shrink `applyPlannerPatch`.
- Remove direct workflow mutation from tool bodies except through
  `reduceFlowEvent`.
- Make transition log the primary workflow debugging surface.

Required tests:

- Existing flow controller suite passes.
- Tool interruption suite passes.
- Transcript eval harness passes.
- Historical flow replay passes for representative traces.

## File-Level Plan

### New Files

- `src/flow/events.ts`
- `src/flow/event-reducer.ts`
- `src/flow/turn-state-reducer.ts`

Event creation helpers live in `events.ts`, and compact transition logging is
private to `event-reducer.ts`. Keeping those colocated is deliberate: the
migration should reduce state-write places, not create extra indirection.

### Primary Changed Files

- `src/agent.ts`
  - Convert deterministic understanding output into events.
  - Call `reduceFlowEvent` before refreshing tools.

- `src/flow/understanding.ts`
  - Stop applying state directly.
  - Own extraction, normalization, and inferred semantic facts only.
  - Fix appointment-management phrase coverage.
  - Prioritize transfer/human request before generic scheduling.

- `src/flow/turn-state-reducer.ts`
  - Own reducer-side caller-turn state application formerly housed in
    `understanding.ts`.
  - Keep caller-turn mutation behind `reduceFlowEvent`.

- `src/flow/reducer.ts`
  - Become the caller-turn orchestration layer around event reduction and
    planner derivation.
  - Preserve the existing return shape until callers are migrated.

- `src/flow/plans/common.ts`
  - Delete `applyPlannerPatch`.
  - Build commands without `WorkflowCommand.statePatch`.
  - Carry only the task plan and explicit command transition fields needed by
    the reducer.

- `src/flow/plans/simple.ts`
  - Make transfer planning depend on reducer-owned pending transfer state.

- `src/flow/plans/appointment/reschedule.ts`
  - Make reschedule planning read reducer-owned old appointment, replacement
    window, selected slot, and confirmation facts.

- `src/flow/policy.ts`
  - Block side-effect tools unless reducer-owned confirmed pending actions
    already exist.
  - Do not rely on tool-call-time auto-confirmation.

- `src/tools.ts`
  - Remove auto-confirm behavior for `transfer_call`.
  - Emit tool-result events after successful or failed side effects.
  - Emit reducer events for patient payloads, insurance checks, availability
    context, routing, reschedule progress, and workflow step movement.
  - Keep execution safety checks such as speech interruption, duplicate
    in-flight transfer, and already-transferred no-op.

### Tests

- `src/__tests__/turn-understanding.test.ts`
- `src/__tests__/flow-controller.test.ts`
- `src/__tests__/transcript-eval-harness.test.ts`
- `src/__tests__/tool-interruptions.test.ts`
- `scripts/replay-historical-flow.ts`

## State Writer Audit

The implementation routed or reviewed these prior write paths:

- `applyTurnUnderstandingFromTranscript`, `applySchedulingUnderstanding`,
  `applyInsuranceUnderstanding`, `applySchedulingGoalAfterIntent`, and
  `applyInferredIntentState` were removed from `understanding.ts` as public
  writer paths. Caller-turn state application now lives in
  `turn-state-reducer.ts` and is invoked by reducer events.
- `applyPlannerPatch` was deleted. Planner state changes now enter through
  `planner_command_applied`.
- Tool-call-time side-effect auto-confirmation was removed. A blocked
  registration or insurance-update attempt can create an unconfirmed
  `side_effect_confirmation_requested` action, and caller confirmation later
  marks that action confirmed through reducer state.
- `book_appt` no longer creates or confirms its own booking pending action.
  `book_appt` requires a reducer-created confirmed booking action.
- `add_patient`, `update_insurance`, `cancel_appt`, `route_to_spring_hill`, and
  `transfer_call` consume pending actions through `tool_succeeded`.
- `verify_patient` records verified patient state through `patient_recorded`.
- Patient payload metadata is applied through `patient_payload_applied`.
- Patient verification attempts are applied through
  `patient_verification_attempted`.
- Active-patient insurance updates are applied through
  `active_patient_insurance_updated`.
- Insurance checks are applied through `insurance_checked`.
- Routine-vision office routing and availability visit context are applied
  through `routine_vision_office_ensured` and
  `availability_visit_context_ensured`.
- Reschedule replacement booking and old-appointment cancellation progress are
  applied through reducer events.
- Tool guard telemetry is written through `tool_guard_observed`.

Remaining direct writes in tool bodies are session mirrors or execution-local
safety state, such as `state.patientId`, `lastAvailabilitySlots`,
`transferInFlight`, and middleware office phone fields. Those are not the
workflow authority, but they remain necessary for the current tool contract.

Current branch progress:

- `recordVerifiedPatient` is reducer-owned through `patient_recorded`.
- Side-effect pending actions are created through
  `side_effect_confirmation_requested` or caller-turn confirmation events, then
  confirmed only by reducer-owned caller confirmation state.
- Side-effect pending actions are consumed through `tool_succeeded`.
- `transfer_call` no longer auto-creates a confirmed transfer action.
- `src/tools.ts` and `src/agent.ts` no longer assign durable `state.flow`
  workflow fields directly; they emit reducer events.

## Deletion and Shrink Targets

The implementation should not just add new files. It should shrink or delete
old state ownership paths as phases complete.

Completed simplifications:

- `applyPlannerPatch` is deleted.
- Transfer auto-confirmation is removed.
- Booking auto-confirmation is removed.
- Side-effect consumption moved to `tool_succeeded`.
- Patient verification writes moved to `patient_recorded`.
- Planner command application moved to `planner_command_applied`.
- `WorkflowCommand.statePatch` is removed.
- `ToolOutcome.statePatch` is removed.
- `understanding.ts` is no longer a flow-state writer.
- Generic tool-driven step movement goes through `workflow_step_updated`.
- Tool/agent workflow writes now go through explicit reducer events.

Remaining future shrink target:

- Tool bodies still maintain session mirror fields and execution-local state
  required by middleware and telephony, such as `state.patientId`,
  `lastAvailabilitySlots`, booking tokens, and transfer in-flight flags.

If the new reducer is added while all old write paths remain permanently, this
spec has failed.

## Observability

Every reducer transition should be visible in call analytics payloads:

```json
{
  "eventType": "appointment_management_requested",
  "source": "deterministic_understanding",
  "changed": ["activeIntent", "activeFlow", "step", "currentTask"],
  "before": {
    "activeIntent": null,
    "activeFlow": "intro",
    "step": "understand_intent"
  },
  "after": {
    "activeIntent": "existing_appointment_reschedule",
    "activeFlow": "appointment_management",
    "step": "verify_patient"
  }
}
```

The final call payload should make it easy to answer:

- Which event first set the active intent?
- Which event changed the task?
- Which event created a pending side effect?
- Which event confirmed it?
- Which event consumed it?
- Which planner command was derived after each event?

## Rollout Strategy

Use the existing flow harness enablement path for rollout. This branch does not
add a separate `FLOW_SINGLE_WRITER_MODE`; reducer events are the live write path
when the flow harness is enabled.

Recommended rollout:

1. Run unit, transcript, and historical replay validation locally.
2. Review transition logs for the source incident and representative traces.
3. Deploy to one office trunk with the existing flow harness enabled.
4. Watch transition logs, guard observations, and tool outcomes.
5. Roll out to the remaining trunks once representative calls are clean.

## Acceptance Criteria

The implementation is done when:

- `SCL_LUzHeJyBF4M6` replays as reschedule intent from "Appointment changes."
- `Can I talk to somebody to make the appointment?` is a transfer request, not
  a generic scheduling turn.
- `transfer_call` cannot create its own confirmed pending transfer action.
- The LLM can switch tasks by emitting a small semantic meaning object, without
  naming reducer internals such as `step`, `activeFlow`, or `taskPlans`.
- A temporary FAQ or transfer request can interrupt and resume scheduling
  without losing the active scheduling task.
- Every durable flow transition is recorded with event type, source, before,
  after, and changed fields.
- Planner commands can be derived without applying planner state patches.
- Tool side effects are consumed only after tool-result events.
- Existing booking, cancellation, transfer, and availability guard tests pass.
- Historical replay shows no unexplained divergence for covered flows.

## Risks

### Behavior Drift

Risk: migrating writers can subtly change edge-case call behavior.

Mitigation: migrate one workflow at a time and run transcript replay after each
phase.

### Over-Centralized Reducer

Risk: the reducer becomes a large switch statement that is hard to maintain.

Mitigation: use event-specific handlers grouped by workflow:

- `reduceTransferEvent`
- `reduceAppointmentManagementEvent`
- `reduceSchedulingEvent`
- `reducePatientEvent`
- `reduceToolResultEvent`

The public write path remains single, but implementation stays modular.

### Planner Regression

Risk: removing planner state patches can make planner output stale if the
reducer does not apply the same explicit command transition.

Mitigation: planner commands now carry the concrete task plan and explicit
transition fields. The reducer owns the write and records the transition.

### Confirmation Regression

Risk: stricter transfer confirmation may add one extra turn.

Mitigation: that is intentional for side-effect safety. The first recoverable
scheduling human request still gets one help-first pushback; the second asks
for explicit transfer agreement; an affirmative answer immediately allows
`transfer_call`.

## Implementation Order

1. Add event types and transition logging.
2. Add parser tests for appointment changes, transfer precedence, and preferred
   windows in reschedule.
3. Add transfer reducer events and enforce transfer confirmation.
4. Add the `SCL_LUzHeJyBF4M6` transcript regression.
5. Move appointment reschedule facts into reducer-owned events.
6. Convert planner commands into reducer-applied command events.
7. Remove direct state mutation from transfer and reschedule paths.
8. Expand to scheduling, insurance, and registration.
9. Remove legacy planner patch writes, `WorkflowCommand.statePatch`, and
   `ToolOutcome.statePatch`.
