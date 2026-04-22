# Agent Rewrite Progress

## Purpose

Track the rewrite phase by phase so it is clear:

- what has been implemented
- what remains
- what practical benefit each phase is expected to deliver
- what limitations still remain after each phase

## Status Summary

| Phase | Name | Status |
|---|---|---|
| 1 | State and Tool Hardening | Complete |
| 2 | Prompt Refactor | Complete |
| 3 | Identity and Registration Tasks | Complete |
| 4 | Scheduling Task Group | Complete |
| 5 | Reschedule Task Group | Complete |

---

## Phase 1: State and Tool Hardening

### Status

Complete

### What Changed

Implemented in:

- [src/tools.ts](/Users/chasefagen/livekit-agent/src/tools.ts)
- [src/main.ts](/Users/chasefagen/livekit-agent/src/main.ts)
- [src/__tests__/phase1-state-tools.test.ts](/Users/chasefagen/livekit-agent/src/__tests__/phase1-state-tools.test.ts)

Changes:

- replaced the flat session state with a nested `CallState`
- added `createInitialCallState(...)` for consistent session initialization
- added helper functions for:
  - working-state summaries
  - slot fingerprints
  - duplicate availability detection
  - appointment extraction
- updated tools to read/write the new state shape
- added guardrails and write-backs to:
  - `verify_patient`
  - `add_patient`
  - `update_insurance`
  - `get_availability`
  - `confirm_appt`
  - `book_appt`
  - `cancel_appt`
  - `check_insurance`
  - `transfer_call`

### Behavioral Benefits

This phase improves workflow reliability even before tasks are added.

Expected benefits:

- prevents new-patient registration when a patient is already identified
- prevents repeated same-date availability searches in the same unchanged state
- prevents duplicate booking of the same slot in one call
- prevents cancellation of appointments that are not loaded into session state
- persists appointment fetches and availability lookups into call state for later steps
- establishes a hidden workflow model that later tasks can rely on

### Why This Matters

Before Phase 1, workflow correctness depended mostly on prompt compliance.

After Phase 1, the runtime has real memory and real brakes:

- the code now knows who the patient is
- the code now knows whether registration should be allowed
- the code now knows what availability was already checked
- the code now knows what appointment data is loaded
- the code now knows whether a slot was already booked this call

This reduces failure modes caused by the model forgetting workflow rules mid-call.

### What It Does Not Solve Yet

Phase 1 does **not** yet improve:

- conversational smoothness in a major way
- dynamic task-based backtracking
- smaller active prompts
- task-local context injection
- more natural step-by-step scheduling flow

It is a reliability foundation, not the final conversational architecture.

### Known Limitations

- `book_appt` still uses the current raw parameter signature
- `book_appt` does not yet require a pre-selected slot from task state
- `get_availability` does not yet hard-require `reasonForVisit` because that would break the pre-task single-agent flow
- overlap detection is still heuristic because stored appointment duration is not part of the current data shape

### Validation

Ran successfully:

- `npm run typecheck`
- `npm run test -- src/__tests__/phase1-state-tools.test.ts`
- `npm run test`

### Exit Criteria

Phase 1 is considered complete because:

- the new nested state model compiles and is initialized in the live entry path
- the new tool guards are implemented
- focused tests exist and pass
- the full test suite passes

---

## Phase 2: Prompt Refactor

### Status

Complete

### What Changed

Implemented in:

- [src/prompt.ts](/Users/chasefagen/livekit-agent/src/prompt.ts)
- [workspace/ROUTER.md](/Users/chasefagen/livekit-agent/workspace/ROUTER.md)
- [workspace/IDENTIFY_REGISTER.md](/Users/chasefagen/livekit-agent/workspace/IDENTIFY_REGISTER.md)
- [workspace/SCHEDULE_RESCHEDULE.md](/Users/chasefagen/livekit-agent/workspace/SCHEDULE_RESCHEDULE.md)
- [src/__tests__/office-routing.test.ts](/Users/chasefagen/livekit-agent/src/__tests__/office-routing.test.ts)

Changes:

- split the monolithic workflow prompt into smaller modules
- added `buildBasePrompt()`
- added `buildRouterPrompt(...)`
- added `buildTaskPrompt(...)`
- kept `buildPrompt(...)` as the current single-agent entry point, now routed through the modular builder
- added a test for focused task prompt assembly

### Expected Benefits

- cleaner separation between persona/voice and workflow logic
- easier prompt iteration by workflow area
- future task prompts can reuse the shared base without duplicating the full runbook
- smaller, more focused prompt assembly is now possible for later task/task-group phases
- fewer hidden prompt conflicts because workflow content is organized by purpose

### Why This Matters

Before Phase 2, prompt assembly came from:

- `SOUL.md`
- `VOICE.md`
- one large `RUNBOOK.md`

After Phase 2, prompt assembly is modular:

- shared base prompt
- router workflow prompt
- task prompt builder for future tasks

That means later phases can activate only the prompt content relevant to the current workflow step instead of always loading the whole workflow manual.

### What It Does Not Solve Yet

Phase 2 does **not** yet:

- activate task-local prompts in runtime
- materially shrink the live prompt used by the current single-agent flow
- provide task-level regression behavior
- improve tool discipline by itself

It prepares the prompt surface for later phases; it does not yet change orchestration.

### Validation

Ran successfully:

- `npm run typecheck`
- `npm run test`

### Exit Criteria

- new prompt modules exist
- `src/prompt.ts` uses the new modular assembly model
- task-focused prompt building is available for later phases
- the full test suite passes

---

## Phase 3: Identity and Registration Tasks

### Status

Complete

### What Changed

Implemented in:

- [src/agent.ts](/Users/chasefagen/livekit-agent/src/agent.ts)
- [src/tasks/IdentifyPatientTask.ts](/Users/chasefagen/livekit-agent/src/tasks/IdentifyPatientTask.ts)
- [src/tasks/RegistrationTask.ts](/Users/chasefagen/livekit-agent/src/tasks/RegistrationTask.ts)
- [workspace/ROUTER.md](/Users/chasefagen/livekit-agent/workspace/ROUTER.md)
- [src/__tests__/office-routing.test.ts](/Users/chasefagen/livekit-agent/src/__tests__/office-routing.test.ts)

Changes:

- added `IdentifyPatientTask`
- added `RegistrationTask`
- added top-level orchestration tools:
  - `run_identify_patient_task`
  - `run_registration_task`
- updated the router prompt to point scheduling entry into the new workflow tools
- kept the current scheduling, booking, and appointment-change tools on the top-level agent for now because scheduling task groups have not landed yet

### Expected Benefits

- identity resolution is now a focused task instead of a freeform part of the main agent loop
- registration can now run inside a dedicated task with its own prompt and tool surface
- switched-patient and true new-patient flows have a clearer orchestration path
- the top-level agent now has a concrete bridge into task-based workflows instead of only prompt-level instructions

### Why This Matters

Before Phase 3, Phase 2 had task prompt builders but no runtime task execution.

After Phase 3:

- the top-level front desk agent can launch a real identity workflow
- the top-level front desk agent can launch a real registration workflow
- these workflows now run with task-local prompts and task-local tools

This is the first phase where the rewrite stops being only scaffolding and begins changing live orchestration.

### What It Does Not Solve Yet

Phase 3 does **not** yet:

- move scheduling into a task group
- move rescheduling into a task group
- shrink the top-level tool surface for scheduling actions
- enforce the full slot-selection workflow before booking

The top-level agent still retains the scheduling and appointment-change tools until Phase 4.

### Validation

Ran successfully:

- `npm run typecheck`
- `npm run test`

### Exit Criteria

- identity and registration tasks exist
- the top-level agent exposes orchestration tools that launch those tasks
- prompt and tests reflect the new orchestration surface
- the full test suite passes

---

## Phase 4: Scheduling Task Group

### Status

Complete

### What Changed

Implemented in:

- [src/tasks/VisitReasonTask.ts](/Users/chasefagen/livekit-agent/src/tasks/VisitReasonTask.ts)
- [src/tasks/AvailabilityTask.ts](/Users/chasefagen/livekit-agent/src/tasks/AvailabilityTask.ts)
- [src/tasks/BookingTask.ts](/Users/chasefagen/livekit-agent/src/tasks/BookingTask.ts)
- [src/workflows/ScheduleTaskGroup.ts](/Users/chasefagen/livekit-agent/src/workflows/ScheduleTaskGroup.ts)
- [src/agent.ts](/Users/chasefagen/livekit-agent/src/agent.ts)
- [workspace/ROUTER.md](/Users/chasefagen/livekit-agent/workspace/ROUTER.md)

Changes:

- added `VisitReasonTask`
- added `AvailabilityTask`
- added `BookingTask`
- added `ScheduleTaskGroup`
- added top-level orchestration tool `run_schedule_task_group`
- updated router guidance to prefer the scheduling task group for fresh scheduling

### Expected Benefits

- scheduling now has an explicit ordered workflow instead of relying only on the top-level prompt
- visit reason collection is separated from availability search
- availability search is separated from booking
- scheduling can now regress within the task group instead of always relying on the top-level agent to recover
- task-local prompts and tool surfaces now apply to the scheduling path itself

### Why This Matters

Before Phase 4, identity and registration were task-based, but scheduling still lived on the top-level agent.

After Phase 4:

- the top-level agent can launch a full scheduling task group
- scheduling runs as a structured workflow
- slot selection is now recorded before the booking task runs
- booking can now happen from workflow state instead of only freeform prompt steering

This is the phase where the core appointment scheduling path becomes genuinely workflow-driven.

### What It Does Not Solve Yet

Phase 4 does **not** yet:

- move rescheduling into its own task group
- fully remove old scheduling tools from the top-level agent
- redesign booking/cancel tools to token-based handles

The system is still partly hybrid until rescheduling is moved in Phase 5.

### Validation

Ran successfully:

- `npm run typecheck`
- `npm run test`

### Exit Criteria

- scheduling task files exist
- `ScheduleTaskGroup` exists and is wired into the top-level agent
- the router prompt points new scheduling into the task group
- the full test suite passes

---

## Phase 5: Reschedule Task Group

### Status

Complete

### What Changed

Implemented in:

- [src/tasks/ExistingAppointmentTask.ts](/Users/chasefagen/livekit-agent/src/tasks/ExistingAppointmentTask.ts)
- [src/tasks/CancelAppointmentTask.ts](/Users/chasefagen/livekit-agent/src/tasks/CancelAppointmentTask.ts)
- [src/workflows/RescheduleTaskGroup.ts](/Users/chasefagen/livekit-agent/src/workflows/RescheduleTaskGroup.ts)
- [src/tasks/AvailabilityTask.ts](/Users/chasefagen/livekit-agent/src/tasks/AvailabilityTask.ts)
- [src/tasks/BookingTask.ts](/Users/chasefagen/livekit-agent/src/tasks/BookingTask.ts)
- [src/agent.ts](/Users/chasefagen/livekit-agent/src/agent.ts)
- [workspace/ROUTER.md](/Users/chasefagen/livekit-agent/workspace/ROUTER.md)

Changes:

- added `ExistingAppointmentTask`
- added `CancelAppointmentTask`
- added `RescheduleTaskGroup`
- added top-level orchestration tool `run_reschedule_task_group`
- updated router guidance to prefer the reschedule workflow for moving or changing existing appointments
- generalized availability and booking tasks so they can run in schedule or reschedule mode

### Expected Benefits

- rescheduling now follows an explicit workflow instead of being handled freeform at the top level
- existing appointment selection is separated from replacement search
- replacement booking is separated from old appointment cancellation
- the system now enforces the intended order: book new first, cancel old second
- the rewrite no longer depends on the top-level agent to manually remember the reschedule sequence

### Why This Matters

Before Phase 5, fresh scheduling was workflow-driven but rescheduling was still hybrid.

After Phase 5:

- fresh scheduling has a task group
- rescheduling has a task group
- both major appointment workflows now have explicit step boundaries

This completes the main workflow rewrite and removes the biggest remaining hybrid path.

### What It Does Not Solve Yet

Phase 5 does **not** yet:

- redesign scheduling write actions to opaque slot or appointment tokens
- add dedicated end-to-end task-group tests for realistic multi-turn scheduling and rescheduling transcripts
- retune voice turn-taking or interruption behavior

The architecture rewrite is complete, but there is still room for further hardening and polish.

### Validation

Ran successfully:

- `npm run typecheck`
- `npm run test`

### Exit Criteria

- existing appointment selection task exists
- cancellation task exists
- `RescheduleTaskGroup` exists and is wired into the top-level agent
- router guidance points reschedule calls into the workflow
- the full test suite passes

---

## Overall Rewrite Outcome

When all phases are complete, the agent should have:

- one long-lived front desk agent
- focused tasks for structured workflow steps
- explicit task groups for scheduling and rescheduling
- hidden state as workflow truth
- smaller active prompts
- narrower tool surfaces
- cleaner backtracking when callers change direction

The net effect should be a front desk receptionist that is both:

- more reliable operationally
- more natural conversationally
