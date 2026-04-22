# Agent V2 Architecture

This document describes the proposed v2 upgrade path for the voice agent platform.

The current codebase is a strong workflow-oriented v1.5:

- modular prompts
- structured hidden `CallState`
- scoped tasks
- task-group workflows
- code-level tool guards

The main limitation is that workflow transitions are still distributed across the codebase instead of being driven by one explicit transition layer.

## Current Architecture

Today, workflow movement is spread across several places:

- `src/agent.ts`
- task `onEnter()` methods
- task tool handlers
- task-group `onTaskCompleted()` callbacks
- tool guards in `src/tools.ts`

That means the state machine is real, but implicit.

Examples of current distributed transitions:

- `run_schedule_task_group` sets `intent`, `appointmentIntent`, and `activeFlow`
- `IdentifyPatientTask` can complete with either identified or registration-allowed outcomes
- `ScheduleTaskGroup` translates task completion into the next `activeFlow`
- `get_availability` rejects if prerequisites are missing
- `BookingTask` and `CancelAppointmentTask` finalize flows by mutating `activeFlow`

This is workable, but over time it becomes harder to:

- audit the whole workflow in one place
- reason about edge cases
- add new workflows safely
- keep prompts, tools, and state transitions aligned

## V2 Goal

V2 should keep the good parts of the current system while making workflow control explicit.

The core goal:

- move from distributed transitions to a central transition engine

That means:

- tasks produce typed outcomes
- a controller maps outcomes to events
- one transition function computes the next state
- workflow runners choose the next task from state, not from scattered callbacks

## Design Principles

1. Keep user-facing behavior stable while the internal architecture changes.
2. Preserve current prompt modules unless a change is required by the architecture.
3. Preserve current low-level tool APIs unless a change is required by the architecture.
4. Move control logic into code, not more prompt text.
5. Keep tests at the scenario level so the refactor can be validated without rewriting product expectations.

## Non-Goals

V2 is not:

- a prompt rewrite
- a tool redesign
- a product UX redesign
- an office expansion project
- a model/provider migration

## Target V2 Model

### 1. Workflow Event Layer

Tasks should no longer implicitly decide the next workflow step by mutating state in many places.

Instead, task completion should map to typed workflow events.

Examples:

```ts
type WorkflowEvent =
  | { type: "IDENTITY_CONFIRMED"; patientId: string | null }
  | { type: "REGISTRATION_ALLOWED"; reason: string }
  | { type: "REGISTRATION_COMPLETED"; patientId: string }
  | { type: "VISIT_REASON_CAPTURED"; reasonForVisit: string }
  | { type: "AVAILABILITY_SEARCHED"; foundSlots: boolean }
  | { type: "SLOT_SELECTED" }
  | { type: "BOOKING_COMPLETED" }
  | { type: "EXISTING_APPOINTMENT_SELECTED"; appointmentId: number }
  | { type: "CANCELLATION_COMPLETED" };
```

The exact event set can evolve, but the key is that task results become explicit workflow signals.

### 2. Central Transition Function

The transition engine should be the canonical place that decides how control state changes.

Example shape:

```ts
function transition(state: CallState, event: WorkflowEvent): CallState
```

or

```ts
function transition(state: CallState, event: WorkflowEvent): {
  state: CallState;
  nextStep: WorkflowStep | null;
}
```

This function should own:

- `activeFlow`
- next workflow step
- when registration becomes allowed
- when a flow is complete
- when the agent should remain in the same phase
- when a flow should stop safely

### 3. Workflow Step Layer

Instead of treating task-group wiring as the workflow definition, define workflow steps explicitly.

Example:

```ts
type WorkflowStep =
  | "identify_patient"
  | "register_patient"
  | "visit_reason"
  | "availability"
  | "booking"
  | "existing_appointment"
  | "cancel_original";
```

Each workflow can then declare its legal steps:

```ts
type WorkflowKind = "schedule" | "reschedule" | "confirm" | "cancel";
```

### 4. Workflow Runner

Each high-level workflow runner should:

1. start from a workflow kind
2. ask the transition layer which step is next
3. execute the matching task
4. convert the task result into a `WorkflowEvent`
5. feed the event back into the transition layer
6. repeat until complete or stopped

This replaces much of the current distributed `onTaskCompleted()` logic.

### 5. Control State vs Derived State

In v2, `CallState` should distinguish between:

- control state
- derived/observational state

Control state:

- `identity.patientId`
- `workflow.intent`
- `workflow.appointmentIntent`
- `workflow.activeFlow`
- `workflow.registrationAllowed`
- `workflow.verificationStatus`
- `scheduling.reasonForVisit`
- `scheduling.selectedSlot`
- `scheduling.targetAppointmentId`

Derived or summary state:

- `identity.activePatientMatchesLookup`
- `identity.activePatientSource`
- `scheduling.appointmentsLoadedAt`
- `scheduling.lastAvailabilitySummary`

This does not mean the summary fields must be removed immediately.
It means the transition engine should not rely on fields that exist only for debugging or prompt summaries unless that dependency is intentional.

## What Stays Mostly the Same

The following parts should change as little as possible in phase 1:

- `workspace/SOUL.md`
- `workspace/VOICE.md`
- `workspace/ROUTER.md`
- `workspace/IDENTIFY_REGISTER.md`
- `workspace/SCHEDULE_RESCHEDULE.md`
- `workspace/APPOINTMENT_CHANGES.md`
- low-level middleware tools in `src/tools.ts`
- office config and knowledge file model

The task classes can also stay mostly intact, but they should move toward returning outcomes instead of deciding all transitions themselves.

## Proposed File Layout

The exact structure can vary, but a clean v2 layout could look like this:

```text
src/
  workflows/
    engine/
      workflow-events.ts
      workflow-steps.ts
      transition.ts
      schedule-transition.ts
      reschedule-transition.ts
      confirm-transition.ts
      cancel-transition.ts
      run-workflow.ts
    ScheduleWorkflow.ts
    RescheduleWorkflow.ts
    ConfirmWorkflow.ts
    CancelWorkflow.ts
```

Phase 1 can be smaller than that. It does not need every workflow extracted immediately.

## Migration Strategy

### Phase 1: Schedule Only

Start with `schedule` only.

Why:

- it is the most common workflow
- it exercises identity, registration, visit reason, availability, and booking
- it is enough to prove the transition-engine model

Phase 1 changes:

- define schedule workflow events
- define schedule transition logic
- add a workflow runner for schedule
- refactor `runScheduleTaskGroup` to call the new runner
- keep existing tasks
- keep the same outward behavior and tests

Success criteria:

- schedule scenario tests still pass
- no user-facing behavior regression
- fewer direct `activeFlow` mutations spread across schedule code

### Phase 2: Reschedule

After schedule is stable:

- introduce reschedule events
- move existing appointment + visit reason + availability + booking + cancel transitions under the engine

This is the next highest-value workflow because it is the most transition-heavy.

### Phase 3: Confirm and Cancel

These are simpler flows and can follow after the engine model is proven on schedule/reschedule.

### Phase 4: State Cleanup

Once transition control is centralized:

- trim stale or redundant state
- separate control state from summary state more clearly
- remove remaining transition logic from tasks where it is no longer needed

## Testing Strategy

V2 should be validated with three test layers:

### 1. Transition Unit Tests

Pure tests for the transition function:

- given state + event
- expect next state + next step

This is the main new test layer introduced by v2.

### 2. Workflow Integration Tests

Ensure the workflow runner executes the correct task sequence for real scenarios.

### 3. Existing Scenario Tests

Keep current `workflow-e2e` and prompt-contract tests as the regression safety net.

The current scenario tests should remain the product-level truth.

## Risk Control

To avoid turning v2 into a rewrite:

1. Do one workflow at a time.
2. Keep current prompts and tools stable.
3. Preserve the current state shape initially.
4. Keep existing tests green at every step.
5. Add transition unit tests before broad migration.

## Success Criteria

V2 is successful if:

- schedule flow can be understood primarily from one transition definition
- task results map cleanly to workflow events
- adding a new workflow step no longer requires hunting through many files
- fewer ad hoc `activeFlow` mutations exist in task classes and task-group callbacks
- product behavior remains stable

## Immediate Next Step

The next real implementation step is:

- introduce a schedule-only transition engine and migrate `runScheduleTaskGroup` first

Do not start with all workflows at once.
