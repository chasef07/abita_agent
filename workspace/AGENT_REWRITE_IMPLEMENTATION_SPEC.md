# Agent Rewrite Implementation Spec

## Scope

This spec covers the first implementation of the agent rewrite.

## Status Note

This document captures the implementation spec for the main rewrite phases.

Several items here have now shipped, and the codebase has also added launch hardening beyond the original spec:

- effective routed-office state
- appointment-selection as an explicit workflow phase
- registration entry hard-gating
- transition modules for all major appointment workflows

For the current post-launch roadmap, see [AGENT_SOTA_NEXT_STEPS.md](/Users/chasefagen/livekit-agent/workspace/AGENT_SOTA_NEXT_STEPS.md).

Included:

- `CallState` redesign
- tool guards and state write-backs
- working-state summary helpers
- prompt refactor
- `AgentTask` and `TaskGroup` structure
- routing and regression behavior

Explicitly excluded for this phase:

- `slotToken` / `appointmentToken` tool redesign
- backend API contract changes
- context compaction beyond lightweight task summaries
- turn-detection retuning

The current tool signatures stay in place for now.

## Implementation Goal

Move workflow correctness out of the monolithic runbook and into:

- hidden call state
- task/task-group boundaries
- tool preconditions
- task-local prompts

while preserving the current middleware API shape.

## Phase Order

### Phase 1: State and Tool Hardening

Files:

- `src/tools.ts`
- `src/main.ts`

Deliverables:

- nested `CallState`
- initialization of all new state fields
- tool guards
- tool write-backs
- working-state summary helpers

No tasks yet in this phase.

### Phase 2: Prompt Refactor

Files:

- `src/prompt.ts`
- `workspace/ROUTER.md`
- `workspace/IDENTIFY_REGISTER.md`
- `workspace/SCHEDULE_RESCHEDULE.md`

Deliverables:

- smaller prompt modules
- shared base prompt assembly
- task-local prompt helpers

### Phase 3: Identity and Registration Tasks

Files:

- `src/agent.ts`
- new task files under `src/tasks/`

Deliverables:

- `IdentifyPatientTask`
- `RegistrationTask`
- front desk agent launches them as needed

### Phase 4: Scheduling Task Group

Files:

- `src/agent.ts`
- `src/tasks/VisitReasonTask.ts`
- `src/tasks/AvailabilityTask.ts`
- `src/tasks/BookingTask.ts`
- `src/workflows/ScheduleTaskGroup.ts`

Deliverables:

- scheduling flow moved into `TaskGroup`

### Phase 5: Reschedule Task Group

Files:

- `src/tasks/ExistingAppointmentTask.ts`
- `src/tasks/CancelAppointmentTask.ts`
- `src/workflows/RescheduleTaskGroup.ts`

Deliverables:

- reschedule flow moved into `TaskGroup`

## Final `CallState` Shape

Add this structure in `src/tools.ts`.

```ts
export interface CallState {
  officeKey: OfficeKey;
  effectiveOfficeKey: OfficeKey;
  officePhone: string;
  amdOfficePhone: string;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callerPhone: string;

  identity: {
    patientId: string | null;
    patientName: string | null;
    dob: string | null;
    insuranceCarrier: string | null;
    insPlanId: string | null;
    respPartyId: string | null;
    activePatientSource: "phone_lookup" | "verify_patient" | "add_patient" | null;
    switchedPatientThisCall: boolean;
  };

  workflow: {
    intent: "unknown" | "faq" | "schedule" | "confirm" | "cancel" | "reschedule" | "transfer";
    activeFlow:
      | "none"
      | "identify"
      | "existing_appointment"
      | "register"
      | "visit_reason"
      | "availability"
      | "booking"
      | "cancel";
    appointmentIntent: "schedule" | "confirm" | "cancel" | "reschedule" | null;
    verificationStatus: "not_started" | "single_match" | "multiple_matches" | "verified" | "no_match";
    verificationAttempts: number;
    registrationAllowed: boolean;
    registrationComplete: boolean;
  };

  scheduling: {
    reasonForVisit: string | null;
    lastAvailabilityQuery: {
      date: string;
      patientId: string | null;
      reasonForVisit: string | null;
      routing: string | null;
    } | null;
    lastAvailabilitySummary: string | null;
    lastAvailabilityRaw: unknown | null;
    selectedSlot: {
      startDatetime: string;
      columnId: number;
      profileId: number;
      duration: number;
      appointmentTypeId: number;
    } | null;
    bookedSlotsThisCall: string[];
    targetAppointmentId: number | null;
    appointments: CallerAppointment[];
  };

  insurance: {
    checkedInsurancePlan: string | null;
    routing: string | null;
    allowedProviders: string[];
    routingAmbiguous: boolean;
    preauthRequired: boolean;
  };

  conversation: {
    transferred: boolean;
  };
}
```

## State Initialization

Update `src/main.ts` so `session.userData` is initialized into the new nested structure.

Rules:

- single phone lookup match should initialize `identity` and `insurance`
- verified phone lookup should set `workflow.verificationStatus = "single_match"`
- unknown callers should set `workflow.verificationStatus = "not_started"`
- `workflow.intent` starts as `"unknown"`
- `workflow.activeFlow` starts as `"none"`

## Helper Functions

Add these helpers in `src/tools.ts`.

### `getState(ctx)`

Keep existing helper, but update to the new nested shape.

### `applyPatientResult(state, result)`

Update to write into:

- `identity`
- `insurance`
- reset scheduling state that is patient-specific

Reset:

- `scheduling.reasonForVisit`
- `scheduling.lastAvailabilityQuery`
- `scheduling.lastAvailabilitySummary`
- `scheduling.lastAvailabilityRaw`
- `scheduling.selectedSlot`

Do not erase unrelated conversation state.

### `slotFingerprint(...)`

Because this phase keeps current tool parameters, we still need a fingerprint helper for duplicate-booking prevention.

```ts
function slotFingerprint(params: {
  patientId: string;
  startDatetime: string;
  columnId: number;
  appointmentTypeId: number;
}): string
```

### `buildWorkingStateSummary(state, mode)`

Add a helper returning a compact summary string for:

- `"router"`
- `"identify"`
- `"register"`
- `"schedule"`
- `"reschedule"`

This summary is for prompts/tasks only.

## Tool Changes

## `verify_patient`

Keep signature:

```ts
verify_patient({ firstName, lastName?, dob?, usePhone? })
```

Behavior changes:

- on success:
  - `applyPatientResult`
  - `workflow.verificationStatus = "verified"`
  - `workflow.verificationAttempts = 0`
  - `workflow.registrationAllowed = false`
  - `identity.activePatientSource = "verify_patient"`
- on no match:
  - increment `workflow.verificationAttempts`
  - `workflow.verificationStatus = "no_match"`
- on multiple matches flow:
  - keep `workflow.verificationStatus = "multiple_matches"` until resolved

Registration should only be allowed when:

- caller explicitly said they are new, or
- verify flow has failed enough to permit fallback

## `add_patient`

Keep signature unchanged.

Add hard guards:

- reject if `workflow.registrationAllowed !== true`
- reject if `identity.patientId` already exists and `identity.switchedPatientThisCall !== true`
- reject if `insurance.checkedInsurancePlan` is missing
- reject if required params are obviously empty or placeholder-like

On success:

- `applyPatientResult`
- `workflow.registrationComplete = true`
- `workflow.registrationAllowed = false`
- `identity.activePatientSource = "add_patient"`

## `update_insurance`

Keep signature unchanged.

Update reads/writes to use nested state.

Reject if:

- `identity.patientId` is missing

On success:

- update `identity.insuranceCarrier`
- update `identity.insPlanId`
- update `identity.respPartyId`
- update insurance routing fields

## `get_availability`

Keep signature:

```ts
get_availability({ date })
```

Add hard guards:

- reject if `identity.patientId` is missing
- reject if `scheduling.reasonForVisit` is missing
- reject repeated same search unless caller changed inputs

Repeated same search means:

- same `date`
- same `identity.patientId`
- same `scheduling.reasonForVisit`
- same `insurance.routing`

On success:

- save raw result in `scheduling.lastAvailabilityRaw`
- save concise summary in `scheduling.lastAvailabilitySummary`
- save query in `scheduling.lastAvailabilityQuery`

If the result contains a suggested slot chosen by the task later, that selection is stored in `scheduling.selectedSlot`, not in the tool.

## `confirm_appt`

Keep signature unchanged.

Add:

- persist returned appointments into `scheduling.appointments`

If task logic resolves a single current appointment later, that writes:

- `scheduling.targetAppointmentId`

## `book_appt`

Keep signature unchanged for this phase:

```ts
book_appt({ columnId, profileId, startDatetime, duration, appointmentTypeId })
```

Add hard guards:

- reject if `identity.patientId` is missing
- reject if `scheduling.selectedSlot` is missing or does not match the incoming parameters
- reject if the slot fingerprint is already in `scheduling.bookedSlotsThisCall`
- reject if there is an overlapping known appointment unless `workflow.appointmentIntent === "reschedule"`

On success:

- push fingerprint into `scheduling.bookedSlotsThisCall`
- clear `scheduling.selectedSlot` or leave it as the committed selected slot
- optionally refresh appointments later through `confirm_appt`

## `cancel_appt`

Keep signature:

```ts
cancel_appt({ appointmentId })
```

Add hard guards:

- reject if `scheduling.targetAppointmentId` is missing and the passed ID is not known in `scheduling.appointments`
- reject if caller intent is not cancel/reschedule

On success:

- clear or update `scheduling.targetAppointmentId`

## Prompt Refactor

Create these new files:

- `workspace/ROUTER.md`
- `workspace/IDENTIFY_REGISTER.md`
- `workspace/SCHEDULE_RESCHEDULE.md`

Keep:

- `workspace/SOUL.md`
- `workspace/VOICE.md`

### `ROUTER.md`

Contains:

- intent detection
- FAQ behavior
- transfer rules
- when to launch tasks/task groups

### `IDENTIFY_REGISTER.md`

Contains:

- identity rules
- switched-patient handling
- new-patient detection
- registration collection rules

### `SCHEDULE_RESCHEDULE.md`

Contains:

- visit reason behavior
- availability rules
- booking/reschedule local flow

## `src/prompt.ts` Refactor

Replace monolithic prompt assembly with:

- `buildBasePrompt()`
- `buildRouterPrompt()`
- `buildTaskPrompt(mode, stateSummary)`

Task prompt assembly should also be able to include office-specific workflow context, including routed-office state when scheduling tools have already been switched to another office.

Suggested functions:

```ts
export function buildBasePrompt(): string
export function buildRouterPrompt(phoneLookup?: PhoneLookupResult, trunkPhone?: string): string
export function buildTaskPrompt(mode: "identify" | "register" | "schedule" | "reschedule", stateSummary: string): string
```

## Task File Layout

Create:

- `src/tasks/IdentifyPatientTask.ts`
- `src/tasks/RegistrationTask.ts`
- `src/tasks/VisitReasonTask.ts`
- `src/tasks/AvailabilityTask.ts`
- `src/tasks/BookingTask.ts`
- `src/tasks/ExistingAppointmentTask.ts`
- `src/tasks/CancelAppointmentTask.ts`

Create:

- `src/workflows/ScheduleTaskGroup.ts`
- `src/workflows/RescheduleTaskGroup.ts`

## Task Contracts

## `IdentifyPatientTask`

Input:

- current `chatCtx`
- `CallState`

Tools:

- `verify_patient`

Completion:

- patient identified, or
- registration allowed

Regression:

- none, this is usually the earliest step

## `RegistrationTask`

Tools:

- `check_insurance`
- `add_patient`

Completion:

- registration succeeds

Regression:

- return to identification if caller switches patient

## `VisitReasonTask`

Tools:

- none initially

Completion:

- `scheduling.reasonForVisit` populated

Regression:

- go back to identification if patient changes

## `AvailabilityTask`

Tools:

- `get_availability`

Completion:

- caller selects one slot and `scheduling.selectedSlot` is populated

Regression:

- if caller changes patient -> identify
- if caller changes visit type materially -> visit reason
- if caller asks for another date -> stay in availability

## `BookingTask`

Tools:

- `book_appt`

Completion:

- booking succeeds

Regression:

- if caller changes date -> availability
- if caller changes patient -> identify

## `ExistingAppointmentTask`

Tools:

- `confirm_appt`

Completion:

- `scheduling.targetAppointmentId` set

Regression:

- if caller changes patient -> identify

## `CancelAppointmentTask`

Tools:

- `cancel_appt`

Completion:

- cancellation succeeds

Regression:

- if appointment target changes -> existing appointment task

## `ScheduleTaskGroup`

Implementation:

```ts
const taskGroup = new beta.TaskGroup({
  chatCtx,
  summarizeChatCtx: true,
  onTaskCompleted: async ({ taskId, result }) => {
    // persist workflow progress into state if needed
  },
});
```

Order:

1. `IdentifyPatientTask`
2. `RegistrationTask` if `workflow.registrationAllowed === true`
3. `VisitReasonTask`
4. `AvailabilityTask`
5. `BookingTask`

## `RescheduleTaskGroup`

Order:

1. `IdentifyPatientTask`
2. `ExistingAppointmentTask`
3. `VisitReasonTask` if needed
4. `AvailabilityTask`
5. `BookingTask`
6. `CancelAppointmentTask`

## `src/agent.ts` Rewrite

Keep one top-level `FrontDeskAgent`.

Responsibilities:

- build with router prompt
- own greeting
- answer quick questions
- launch task groups based on detected intent

Suggested methods:

```ts
private async runScheduleFlow(): Promise<void>
private async runRescheduleFlow(): Promise<void>
private async runIdentifyOnlyFlow(): Promise<void>
```

Do not expose all workflow tools on the top-level agent once tasks are in place.

The top-level agent should only expose:

- `lookup_knowledge`
- `check_insurance`
- `transfer_call`

Workflow tools should live inside tasks.

## Task Prompt Template

Each task prompt should include:

1. current role
2. working-state summary
3. narrow goal
4. local rules
5. sample phrases
6. short tool preambles
7. exit and regression conditions

## Example `AvailabilityTask` Prompt Shape

```text
You are currently handling appointment scheduling.

Current call state:
- patient: verified existing patient
- office: Spring Hill
- visit reason: blurry vision follow-up
- already checked: 2026-04-22, no openings
- next step: offer the nearest alternative and continue toward selecting one slot

Goal:
- move the caller toward one booked appointment

Rules:
- search one date at a time
- do not re-run the same search unless the caller changed the request
- book only after explicit agreement

Sample phrases:
- "nothing open that day, but I've got Thursday morning"
- "ok, the next thing I have is Friday at ten"
- "that day is full, but I can get you in the day after"

Tool preambles:
- "let me check that"
- "ok, I'm looking at that now"
- "pulling that up"

Exit when:
- the caller selects a slot, or
- the caller changes the date or patient and the workflow needs to regress
```

## Regression Rules

All tasks must support adaptive backtracking.

Examples:

- if the caller says "actually this is for my son" during booking:
  - clear patient-specific scheduling selections
  - set `identity.switchedPatientThisCall = true`
  - regress to `IdentifyPatientTask`

- if the caller changes from "Friday" to "next Monday":
  - keep patient and reason
  - clear selected slot
  - stay in or regress to `AvailabilityTask`

- if the caller asks an unrelated FAQ during a workflow:
  - optionally let `FrontDeskAgent` answer
  - then resume the active workflow from current state

## Acceptance Criteria By Phase

### Phase 1 acceptance

- state compiles and initializes
- existing tools read/write nested state
- invalid `add_patient` during existing-patient flow is blocked
- repeated same-date `get_availability` without new input is blocked
- duplicate `book_appt` in the same call is blocked

### Phase 2 acceptance

- prompt assembly works with new files
- router prompt is smaller than current monolithic runbook prompt
- working-state summary can be generated for each mode

### Phase 3 acceptance

- identity and registration can run through tasks
- switched-patient flow regresses correctly

### Phase 4 acceptance

- scheduling runs through a task group
- changing the date does not restart the whole flow
- booking only happens after a selected slot is stored in state

### Phase 5 acceptance

- rescheduling books before canceling
- changing the target appointment regresses correctly
