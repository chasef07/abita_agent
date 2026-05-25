# Task-Plan Flow Harness Spec

Status: historical planning spec. The current implementation and tests are the
source of truth where they differ from this document.

Source traces: `SCL_ctXMgWUCKsZg` and `SCL_kPv8L7nVVxtm`, reviewed on
May 24, 2026.

## Source Of Truth

Use this document as background for the task-plan design. The current
implementation intentionally diverges from the older `reschedule_appt` model:
reschedules now book the replacement with `book_appt`, carrying the note
payload, then cancel the old appointment with `cancel_appt` after the
replacement succeeds.

The current implementation is still step/`nextAction` based. The target
implementation is task-plan based.

## Goal

Rewire the flow harness so every active workflow is represented as a durable
task plan, not only a one-turn `nextAction`.

The controller should answer these questions after every caller turn and every
tool result:

- What task are we doing?
- Which patient does the task belong to?
- Where are we in the whole task?
- What facts are known?
- What facts are still missing?
- What is the next safe action?
- Which tools are visible and allowed right now?
- Which side effects are blocked until explicit confirmation?

## Reason

The current reducer and controller already moved business logic out of the
prompt, but the command packet is still too local. It often answers "what is the
next step for this turn?" instead of "where is the whole task blocked?"

That is why an existing-appointment reschedule can reach this state:

```txt
patient verified
existing appointments loaded
old appointment implied by Dr. Bach
preferred replacement window = Monday at 1 PM
availabilitySearches = []
```

The correct frontier is `call get_availability`. The model instead called
`lookup_knowledge` because the harness had recorded the fact but had not moved a
long-horizon task plan to the availability-search phase.

The fix is not a larger prompt or a broader tool list. The fix is a typed task
automaton that computes the first blocked frontier of the task.

## Decision Summary

- `record_turn_understanding` remains the one-per-turn semantic fact update.
- The planner becomes the workflow authority after facts are recorded.
- Runtime context changes from step/`nextAction` to task phase, known facts,
  missing facts, next safe action, allowed tools, and blocked actions.
- The first implementation slice is appointment management only.
- Reschedule follows the legacy-proven sequence: `book_appt` for the
  replacement with the note payload, then `cancel_appt` for the old appointment.
- Wrapper guards and pending actions remain the safety boundary.

## Scope

This spec defines the target harness shape and the first implementation slice.
It intentionally does not require implementing every listed task plan up front.

The first production-quality slice is appointment management:

1. Existing appointment lookup.
2. Confirm existing appointment.
3. Reschedule existing appointment.
4. Planner-driven tool exposure for those phases.

The rest of the task plans stay in this document as the migration map. They
should be implemented only after the appointment-management slice proves the
planner contract, telemetry, and tests.

## Non-Goals

- Do not build one broad `handle_patient_request` tool.
- Do not move the workflow graph into prompt text.
- Do not expose every tool to make the agent feel flexible.
- Do not remove wrapper guards or pending-action ledgers.
- Do not migrate all workflows before the reschedule trace passes.
- Do not depend on LiveKit handoffs or task groups for this harness layer.

## Current Agent Context Review

This section documents the exact context shape the agent sees today on
flow-harness trunks.

### Static System Prompt

`src/agent.ts` constructs the LiveKit agent with:

```ts
instructions: buildPrompt(phoneLookup, trunkPhone)
tools: buildToolsForTrunk(trunkPhone)
```

For harness-enabled trunks, `src/prompt.ts` currently builds this static prompt:

1. `<role>` from `workspace/SOUL.md`.
2. `<voice>` from `workspace/VOICE.md`.
3. `<harness_operating_contract>` generated in `src/prompt.ts`.
4. `<flow_harness_runbook>` from `workspace/FLOW_HARNESS_RUNBOOK.md`.
5. `<context>` with current date/time, pre-call phone lookup, and office routing
   hints when applicable.
6. `<state_memory_contract>` requiring `record_turn_understanding` once per user
   turn.

The important current lines are:

```txt
The TypeScript flow harness owns workflow state, tool sequencing, and side-effect safety.
At the start of each caller turn, update state with record_turn_understanding,
then follow the returned compact command packet: nextAction, optional tool/args,
and instruction.
```

This is directionally right, but it still frames the controller contract as a
compact next-action packet. The target contract should describe a task-plan
frontier instead.

### Per-Turn Injected Context

On each completed caller turn, `Agent.onUserTurnCompleted` in `src/agent.ts`:

1. Stores `latestUserTranscript`.
2. Clears `turnUnderstandingAppliedForTranscript`.
3. Refreshes tools for the pending-turn state.
4. Adds a high-priority system message containing:
   - `compileTurnStatePacket(state.flow)`
   - `<state_update_required>`

The injected state packet is built in `src/flow/context.ts` and currently has
this shape:

```txt
<turn_state>
intent: ...
activePatient: ...
patientStatus: ...
task: ...
step: ...
visitType: ...
scheduling: ...
office: ...
nextAction: ...
blockedActions: ...
</turn_state>

<context_capsules>
objective: ...
patient: ...
step: ...
appointments: ...
scheduling_context: ...
confirmation_context: ...
</context_capsules>
```

This is compact and mostly safe. The missing piece is that it is still
step-centric. It tells the model a current `step` and a guessed `nextAction`, but
it does not expose the whole active task phase, known facts, missing facts, or
why a specific tool is the only safe frontier.

### Tool Result Context

The `record_turn_understanding` tool in `src/tools.ts` calls
`advanceFlowForTurn`, then returns `compactTurnCommandResponse`.

The current response shape is:

```json
{
  "status": "recorded",
  "nextAction": "ask_preferred_date",
  "action": "ask",
  "slot": "preferredDate",
  "instruction": "Confirm which existing appointment they want to move..."
}
```

or:

```json
{
  "status": "recorded",
  "nextAction": "confirm_appt",
  "action": "call_tool",
  "tool": "confirm_appt",
  "args": {},
  "instruction": "Call confirm_appt now."
}
```

This is the point where the current architecture becomes too shallow. The
response should become a compact projection of `WorkflowCommand`, not a local
`FlowDecision`.

### Current Context Problems

The current context is close, but not optimal for the task-plan harness:

- It repeats the right meta-rule, but uses "nextAction" as the central concept.
- It exposes `step` more strongly than task phase.
- It summarizes scheduling but not the full parent task.
- It says `appointments: loaded=N` but does not identify the selected or
  ambiguous target appointment in a planner-owned way.
- It allows `lookup_knowledge` in many step-based tool sets, even when the
  active frontier requires an operational scheduler tool.
- It does not show a durable missing-facts list, so the model has to infer what
  is blocking progress.

### Target Optimal Context

The optimal context stays compact, but the center of gravity changes from
`nextAction` to `taskPlan`.

Target per-turn packet:

```txt
<turn_state>
task: appointment_reschedule
taskId: task_appointment_management_caller_1
patient: caller verified
phase: searching_replacement
objective: move the selected existing appointment to a new time
known: oldAppointment=Monday 8:00 AM Dr. Bach; preferredWindow=Monday 1 PM
missing: replacementAvailability
nextSafeAction: call_tool get_availability
allowedTools: get_availability
blockedActions: reschedule_appt until exact replacement slot is offered and
                the caller confirms the full reschedule
</turn_state>
```

Target context rules:

- Static prompt should stay mostly behavioral: role, voice, short harness
  contract, and current caller context.
- Per-turn context should carry the active task plan, phase, known facts,
  missing facts, next safe action, allowed tools, and blocked side effects.
- The model should not see raw transcripts, raw middleware payloads, booking
  tokens, or internal IDs unless the next tool call requires them.
- Appointment summaries should be speakable. Internal IDs stay wrapper-owned.
- If a tool remains visible because SDK context is stale, wrapper policy must
  still enforce concrete prerequisites rather than a planner allow-list.

## Core Design

Keep the LLM focused on language and semantic extraction. Move task progress,
missing facts, tool visibility, and side-effect authority into TypeScript.

```txt
caller turn
  -> record_turn_understanding proposes semantic facts
  -> reducer accepts safe facts into patient/task state
  -> planner advances active task until blocked
  -> planner returns command packet and allowed tools
  -> agent speaks or calls exactly the safe next tool
  -> tool result patches state
  -> planner advances again
```

`record_turn_understanding` should not be the task planner. It should become a
fact-ingestion step.

## Planner Contract

Add a planner result that is richer than the current compact next-action packet.

```ts
export interface WorkflowCommand {
  taskId: string;
  taskKind: TaskKind;
  patientRef?: PatientRef;
  phase: string;
  objective: string;
  knownFacts: PlannerFact[];
  missingFacts: MissingFact[];
  nextAction: "ask" | "call_tool" | "confirm" | "respond" | "complete";
  tool?: AgentToolName;
  args?: unknown;
  allowedTools: AgentToolName[];
  blockedActions: BlockedAction[];
  statePatch?: PlannerStatePatch;
  instruction: string;
}
```

The model-visible `<turn_state>` should include a compact version:

```txt
task: reschedule existing appointment
phase: searching replacement appointment
known: patient Tree verified; old appointment Dr. Bach Monday 8:00 AM;
       requested replacement Monday 1:00 PM
missing: replacement availability
next safe action: call get_availability
allowed tools: get_availability
blocked: reschedule_appt until exact replacement slot is offered and confirmed
```

## Advance-Until-Blocked

Each task planner should run deterministic transitions until it reaches a real
boundary:

1. Missing caller fact.
2. Required tool call.
3. Required explicit confirmation.
4. Completed task.
5. Policy block that requires transfer or human handling.

Example:

```ts
export function advanceTaskPlan(state: CallFlowState): WorkflowCommand {
  let plan = ensureActiveTaskPlan(state);

  for (let i = 0; i < MAX_INTERNAL_TRANSITIONS; i += 1) {
    const result = advanceOnePhase(state, plan);
    if (result.blocked) return result.command;
    plan = result.plan;
  }

  return failClosed("planner_loop_limit");
}
```

The planner should never rely on the LLM to remember that the next phase follows
from previously captured facts.

## Planner Purity

Planner functions should not quietly mutate `CallFlowState`. They should compute
the next command and an explicit state patch.

Preferred pattern:

```ts
const command = planNextCommand(state);
applyPlannerPatch(state, command.statePatch);
```

This keeps reducer ownership visible. The code that decides "where are we in
the task?" should not also make hidden side-effect-like state changes that are
hard to test.

## State Model

`schedulingGoal` is currently overloaded. It carries new scheduling,
confirmation, cancellation, and reschedule concepts. That makes state flexible
but ambiguous.

Prefer task-specific plans, but distinguish parent task plans from reusable
subplans.

Parent task plans represent what the caller is trying to accomplish:

```ts
type ParentTaskPlan =
  | AppointmentConfirmPlan
  | AppointmentCancelPlan
  | AppointmentReschedulePlan
  | SchedulingPlan
  | RegistrationPlan
  | InsurancePlan
  | KnowledgeAnswerPlan
  | TransferPlan
  | EndCallPlan;
```

Subplans are reusable blockers or capabilities inside parent tasks:

```ts
type TaskSubplan =
  | PatientVerificationSubplan
  | AppointmentLookupSubplan
  | AvailabilitySearchSubplan
  | BookingSubplan
  | AppointmentNotePayloadSubplan
  | OfficeRoutingSubplan;
```

Parent plans own the lifecycle. Subplans own reusable prerequisites and tool
ledgers. This avoids turning patient verification, appointment lookup, or
availability search into competing top-level workflows.

Each parent plan owns:

- its phase
- patient binding
- known facts
- missing facts
- pending confirmations
- subplan/tool result ledgers
- invalidation rules when upstream facts change

## Tool Exposure

Dynamic tool exposure should keep the workflow tool set broad. The current
planner command is guidance for the model, not a hard visibility or allow-list
boundary.

Rules:

- `record_turn_understanding` remains preferred once per new caller turn, but
  workflow tools are not blocked solely because it has not run yet.
- After semantic facts are recorded, keep the broad workflow tool set visible.
- Wrapper guards remain the security boundary for concrete prerequisites:
  verified patient, current availability, loaded appointment, explicit
  confirmation, and duplicate/stale action protection.
- Dynamic exposure is latency and steerability control, not the safety layer.
- SDK tool visibility can lag inside an already-running model turn, so wrappers
  must enforce concrete state, not a stale planner allow-list.
- Side-effect tools remain serialized through pending actions even if the LLM or
  SDK attempts parallel calls.

## Parent Plans And Subplans

This section lists the target workflow taxonomy. The implementation order is
defined later; do not treat every heading here as part of the first slice.

### Intent Triage

Current issue: first-turn intent can be converted into a workflow too early or
too vaguely.

Plan phases:

- `listening`
- `clarifying_intent`
- `routed`

Known facts:

- caller goal
- confidence
- whether request is patient-specific
- whether request is side-effecting

Missing facts:

- intent if ambiguous
- patient binding if patient-specific

Changes:

- Route to a task plan only when intent is specific enough.
- Ask one clarifying question when intent is ambiguous.
- Keep FAQ and quick office questions lightweight.

Improvement:

- Prevents early patient verification for bare FAQs.
- Prevents appointment tools for unclear utterances like "hello" or "three."

### Knowledge Answer And FAQ

Current issue: `lookup_knowledge` can be used as a substitute for operational
tools, especially availability lookup.

Plan phases:

- `answering`
- `answered`

Known facts:

- question
- office context
- language

Missing facts:

- office or domain only if needed to answer accurately

Changes:

- `lookup_knowledge` is allowed only for informational questions.
- It is blocked when the active task frontier requires scheduler state, patient
  verification, booking, cancellation, registration, or insurance side effects.

Improvement:

- Stops "availability Dr. Bach Monday 1 PM" from going to knowledge search.
- Keeps true FAQs fast.

### Patient Verification Subplan

Current issue: patient identity is partly call-scoped and can drift across
family members, spelling corrections, and appointment tasks.

Plan phases:

- `needs_patient_identity`
- `collecting_first_name`
- `collecting_last_name_dob`
- `verifying`
- `verified`
- `no_match`
- `blocked`

Known facts:

- active patient ref
- relationship to caller
- first name, last name, DOB, phone
- source and confidence for each identity fact

Missing facts:

- first name for multiple phone matches
- last name and DOB after failed or ambiguous lookup

Changes:

- Verification becomes a reusable sub-plan for patient-bound tasks.
- Spelled values outrank spoken guesses.
- Tool args come from structured patient state, not transcript memory.
- `registrationAllowed` opens only after an explicit no-match path.

Improvement:

- Reduces guessed names and duplicate verification attempts.
- Makes multi-patient switching possible without corrupting active tasks.

### Existing Appointment Lookup Subplan

Current issue: confirm, cancel, and reschedule all need loaded appointments, but
appointment lookup is not modeled as its own reusable task frontier.

Plan phases:

- `needs_verified_patient`
- `loading_appointments`
- `appointments_loaded`
- `none_found`
- `lookup_failed`

Known facts:

- patient ref
- verified patient ID
- loaded appointment summaries
- cancel tokens or appointment IDs kept internal

Missing facts:

- verified patient
- appointment list

Changes:

- `confirm_appt` becomes the standard appointment-refresh tool for existing
  appointment workflows.
- If appointments are empty or stale, the planner refreshes before asking the
  model to reason about them.
- Appointment IDs stay internal unless a tool requires them.

Improvement:

- Stops dead ends after verification.
- Gives confirm, cancel, and reschedule one shared source of appointment truth.

### Confirm Existing Appointment

Current issue: confirmation can find appointments, speak them, then leave the
task alive. A later "sure" may trigger another `confirm_appt` or keep the
workflow in appointment-management mode.

Plan phases:

- `needs_lookup`
- `presenting_appointments`
- `confirmation_answered`
- `complete`

Known facts:

- patient ref
- appointment summaries
- whether the caller only wanted details or asked to confirm receipt

Missing facts:

- appointment list

Changes:

- After appointments are read back, the task can complete unless the office
  has a separate confirmation side effect.
- If the caller says "sure" after "would you like to confirm both?", record the
  conversational confirmation and close the task instead of re-calling lookup.
- The next "anything else?" answer should route to a fresh task or `EndCallPlan`.

Improvement:

- Prevents zombie appointment-confirm tasks.
- Makes "no" after "anything else?" end cleanly.

### Cancel Existing Appointment

Current issue: cancellation and reschedule can be confused. The reducer may ask
for cancel confirmation when the caller is really asking whether to reschedule.

Plan phases:

- `needs_lookup`
- `selecting_appointment`
- `confirming_cancel`
- `cancelling`
- `cancelled`
- `complete`

Known facts:

- target appointment
- exact spoken cancel summary
- explicit cancel confirmation

Missing facts:

- which appointment if multiple
- explicit confirmation

Changes:

- Cancellation is only selected when the caller wants cancellation only.
- "Move", "reschedule", "later", or a new time/date creates or switches to a
  reschedule plan.
- The reducer creates a confirmed pending cancel action when the caller confirms
  the exact readback.

Improvement:

- Prevents accidental cancellation during reschedule.
- Makes side-effect authority explicit before `cancel_appt`.

### Reschedule Existing Appointment

Current issue: this is the main failure. The state captures a preferred window,
but the harness does not carry the whole reschedule lifecycle.

The target should be simpler than separate booking, note-writing, and
cancellation phases. To the caller and to the model-facing tool contract,
reschedule should be one confirmed action: replace the old appointment with the
new selected appointment.

Every replacement appointment should still have the required AP note payload.
The distinction is ownership: note facts travel inside the booking/reschedule
operation, not as a separate model-visible `add_patient_note` phase after the
new appointment is created.

Plan phases:

- `requested`
- `needs_verified_patient`
- `loading_existing_appointments`
- `selecting_old_appointment`
- `collecting_replacement_window`
- `searching_replacement`
- `offering_replacement`
- `confirming_reschedule`
- `rescheduling`
- `complete`
- `partial_failure`

Known facts:

- patient ref
- old appointment ID and speakable summary
- target selection status
- provider preference if relevant
- appointment kind or routing facts derived from the old appointment when
  possible
- note payload for the replacement appointment, using existing captured
  appointment reason/referrer facts where available
- preferred replacement window
- offered replacement slot
- exact reschedule confirmation

Missing facts:

- verified patient
- loaded appointments
- selected old appointment when multiple are plausible
- replacement window
- replacement availability
- note reason/referrer only if the current state cannot supply required note
  payload for the replacement appointment
- explicit yes to replace the old appointment with the exact offered new slot

Changes:

- Create `AppointmentReschedulePlan` as soon as reschedule intent is known.
- Load appointments with `confirm_appt` if missing.
- Select the old appointment from loaded appointment summaries.
- If more than one loaded appointment matches the caller's description, ask
  which appointment before searching replacement availability.
- Once old appointment and preferred window are known, call `get_availability`.
- Offer one replacement slot.
- After the caller confirms the full replacement, call one planner-approved
  reschedule action.
- Do not call `add_patient_note` as a separate reschedule phase. The final
  reschedule action should carry the same appointment note payload that booking
  carries today: appointment reason and referring doctor, or explicit "none"
  where appropriate.
- Do not expose direct `book_appt` and `cancel_appt` to the model for the final
  reschedule action. The harness should expose one `reschedule_appt` action or
  equivalent internal wrapper.

Improvement:

- Turns the bad trace into a deterministic path:

```txt
Dr. Bach old appointment + Monday 1 PM replacement window
  -> get_availability
  -> offer slot
  -> confirm full reschedule after yes
  -> reschedule_appt
  -> complete
```

Atomicity requirement:

- The model-facing action must be one action: `reschedule_appt`.
- Preferred backend behavior is a true atomic reschedule endpoint.
- If the underlying integration only supports "book new" and "cancel old" as
  separate calls, the harness wrapper must still present one action to the
  model, must not report success until both operations succeed, and must enter
  `partial_failure` if the replacement is booked but old cancellation fails.
- `partial_failure` is not a normal completion state. It should block closeout,
  log high-severity telemetry, and route to a human or office recovery path so
  the patient is not silently left with two appointments.

Required target-selection fields:

```ts
interface AppointmentReschedulePlan {
  targetAppointmentId?: number;
  targetSelectionStatus: "none" | "ambiguous" | "selected";
  targetSelectionEvidence: string[];
  replacementSlotId?: string;
  appointmentReason?: string;
  referringDoctor?: string;
  rescheduleConfirmed?: boolean;
  rescheduleOperationId?: string;
}
```

The planner may infer the target from provider/time only when the loaded
appointments produce a unique match. Otherwise it must ask the caller which
appointment they mean.

### New Appointment Scheduling

Current issue: scheduling already has many facts, but the controller treats it
as a line of next steps rather than a plan with invalidation.

Plan phases:

- `triaging_visit_type`
- `checking_insurance_if_needed`
- `routing_office`
- `needs_patient_status`
- `collecting_visit_context`
- `collecting_preference`
- `searching_availability`
- `offering_slot`
- `confirming_booking`
- `booking`
- `booked`
- `complete`

Known facts:

- patient status
- visit type
- reason
- office lane
- provider preference
- date/time preference
- active availability result
- offered slot
- booking confirmation
- appointment note payload

Missing facts:

- visit type when medical vs routine matters
- routing consent for Crystal River routine vision
- patient identity or registration facts
- reason/referring doctor when required
- explicit yes to exact offered slot

Changes:

- Scheduling becomes a typed plan for both new and existing patients.
- Availability searches are attached to the plan and invalidated when visit
  type, office, provider, patient, or preferred window changes.
- Booking consumes a confirmed pending booking action tied to a specific slot.
- Booking carries the appointment note payload. Do not model note-writing as a
  separate post-booking phase for normal scheduling.

Improvement:

- Reduces repeated availability loops.
- Prevents stale-slot and wrong-lane booking.

### Registration

Current issue: new-patient registration can be opened too eagerly after lookup
uncertainty.

Plan phases:

- `allowed_after_no_match`
- `collecting_demographics`
- `collecting_contact`
- `collecting_insurance`
- `confirming_registration`
- `creating_patient`
- `registered`
- `complete`

Known facts:

- explicit no-match or caller says new patient
- name, DOB, phone, address
- insurance plan and coverage type
- confirmed registration readback

Missing facts:

- required demographic fields
- coverage plan if office requires it
- explicit confirmation

Changes:

- Registration is blocked until the planner can explain why it is allowed.
- `add_patient` requires a confirmed pending registration action.
- Insurance facts come from checked canonical plan state where applicable.

Improvement:

- Prevents duplicate patient creation.
- Keeps registration from becoming a fallback for bad verification.

### Insurance

Current issue: bare insurance questions can trigger checking before the harness
knows whether the caller means medical eye care or routine vision.

Plan phases:

- `clarifying_coverage_type`
- `collecting_plan`
- `checking`
- `answered`
- `updating_patient_insurance`
- `complete`

Known facts:

- plan name
- medical vs routine vision context
- office lane
- patient ref when updating an existing patient

Missing facts:

- coverage type for ambiguous questions
- plan name
- explicit confirmation before updating stored insurance

Changes:

- Bare "do you take my insurance?" asks medical vs routine when needed.
- `check_insurance` is allowed only after coverage context is known enough.
- `update_insurance` is separate from answering a coverage question and needs
  explicit confirmation.

Improvement:

- Avoids wrong answers from the wrong coverage map.
- Separates informational checks from patient-record updates.

### Office Routing Subplan

Current issue: routing rules can be treated as prompt text instead of a stateful
decision with required consent.

Plan phases:

- `determining_lane`
- `explaining_route`
- `confirming_route`
- `routing`
- `routed`
- `complete`

Known facts:

- requested office
- visit type
- insurance/routine lane
- routing reason
- caller agreement

Missing facts:

- visit type or coverage lane
- caller agreement when routing changes the requested office

Changes:

- Routing is a plan phase, not a prose instruction.
- `route_to_spring_hill` is exposed only after the caller agrees to the exact
  route.

Improvement:

- Prevents silent office changes.
- Keeps availability searches on the right office lane.

### Availability Search Subplan

Current issue: availability loops are a high-volume failure mode, and knowledge
lookup can be mistaken for scheduler availability.

Plan phases:

- `ready_to_search`
- `searching`
- `results_cached`
- `offering`
- `broadening`
- `exhausted`

Known facts:

- patient ref
- office lane
- visit type/reason
- provider preference
- preferred window
- search signature
- cached result set
- offered slot

Missing facts:

- enough scheduling context to form a search

Changes:

- Dedupe identical search signatures.
- Cache result sets by task and patient.
- Track search budget and broaden rules.
- Expose model-visible slot facts only, not raw AMD fields.
- Block `lookup_knowledge` as an availability substitute.

Improvement:

- Fewer repeated searches.
- Better latency and less model confusion.

### Booking Subplan

Current issue: booking correctness relies on a mixture of prompt instruction,
slot data, and wrapper checks.

Plan phases:

- `offering_slot`
- `awaiting_exact_yes`
- `booking`
- `booked`
- `failed_retryable`
- `failed_terminal`

Known facts:

- active patient
- offered slot ID
- slot summary spoken to caller
- appointment type/routing lane resolved by middleware
- explicit yes to that exact slot

Missing facts:

- exact slot confirmation

Changes:

- Booking requires a confirmed pending booking action.
- The pending action is tied to patient ref, slot ID, availability search ID,
  and spoken summary.
- `book_appt` consumes the pending action on success.

Improvement:

- Prevents duplicate booking attempts.
- Prevents stale or wrong-patient booking.

### Appointment Note Payload Subplan

Current issue: appointment note facts can become detached from the booking or
reschedule operation, or use model-inferred details.

Plan phases:

- `needed`
- `collecting_note_facts`
- `ready`
- `skipped`

Known facts:

- appointment reason
- referring doctor if required
- reschedule old/new appointment summaries if applicable
- destination action: `book_appt` or `reschedule_appt`

Missing facts:

- required note fields

Changes:

- Note facts are collected before the side effect that creates or replaces the
  appointment.
- `book_appt` and `reschedule_appt` carry the note payload.
- `add_patient_note` is not part of the normal post-booking or reschedule path.
  It is reserved for exceptional recovery or workflows that explicitly need a
  separate note after an already-existing appointment.
- Model-facing schema stays narrow: appointment reason and referring doctor, or
  explicit "none" where appropriate.
- Office, patient, default ID, and middleware details remain wrapper-owned.

Improvement:

- Note facts stop racing separately from appointment creation.
- The model no longer needs broad note-writing authority.

### Multi-Patient Switching

Current issue: callers can handle multiple family members in one call, while
tool state can stay attached to the previous patient.

Plan phases:

- `active_patient_known`
- `switch_requested`
- `confirming_switch_if_needed`
- `switched`

Known facts:

- active patient ref
- patient registry
- task IDs per patient

Missing facts:

- identity facts for the new patient

Changes:

- Every patient-bound task carries `patientRef`.
- Switching active patient invalidates availability, booking confirmations,
  appointment lookup, and pending side effects for the previous patient unless
  deliberately resumed.
- Model-visible capsules clearly state the active patient.

Improvement:

- Prevents cross-patient side effects.
- Allows one call to complete several patient tasks safely.

### Corrections And Backtracking

Current issue: corrections can patch one field without invalidating downstream
state.

Plan phases:

- `correction_detected`
- `invalidating_downstream`
- `replanning`

Known facts:

- corrected field
- old value
- new value
- affected task IDs

Missing facts:

- confirmation only if the correction is ambiguous

Changes:

- Facts carry provenance and dependency edges.
- Correcting patient, office, visit type, provider, preferred window, or target
  appointment invalidates dependent availability, pending booking, and pending
  cancellation actions.

Improvement:

- Stops stale downstream decisions after callers correct themselves.

### Transfer

Current issue: transfer should remain a last resort but must be clean when the
planner cannot safely proceed.

Plan phases:

- `transfer_needed`
- `explaining_transfer`
- `awaiting_agreement`
- `transferring`
- `complete`

Known facts:

- reason
- destination
- caller agreement
- speech finished and uninterruptible

Missing facts:

- explicit agreement unless the policy allows immediate transfer

Changes:

- Transfer is a task plan with a pending action.
- `transfer_call` is exposed only after agreement and speech safety gates.
- Parallel transfer attempts stay blocked by an in-flight guard.

Improvement:

- Keeps transfer consistent without making it the default escape hatch.

### End Call And No Further Help

Current issue: after "anything else?", a caller's "no" can keep the prior task
alive.

Plan phases:

- `asked_anything_else`
- `no_further_help`
- `closing`
- `complete`

Known facts:

- prior task completed or paused
- caller declined more help

Missing facts:

- none

Changes:

- Add a no-further-help semantic outcome.
- Close active task state before ending or idling.
- Do not route "no" back into appointment management.

Improvement:

- Ends calls naturally.
- Prevents stale tasks from re-opening tools.

## Parallel Tool Calls

LLMs and the SDK may attempt parallel tool calls. The harness should support
parallelism only where it is semantically safe.

Allowed:

- independent, read-only informational lookups when no task frontier is active
- internal state update followed by one planner-approved operational tool

Blocked:

- multiple side effects in one turn
- booking and cancelling in parallel
- transfer plus another side effect
- duplicate availability searches with the same signature
- side-effect tool calls missing concrete prerequisites or confirmation

The side-effect ledger remains the final authority. Dynamic tools reduce the
chance of bad calls, but pending actions prevent damage.

## Current-To-Target Implementation Delta

This section maps the current harness implementation to the task-plan
implementation.

### 1. Prompt Assembly

Current:

- `src/prompt.ts` builds static context from `SOUL.md`, `VOICE.md`,
  `FLOW_HARNESS_RUNBOOK.md`, pre-call lookup, and the state memory contract.
- The harness operating contract tells the model to follow `nextAction`.

Target:

- Keep `SOUL.md` and `VOICE.md`.
- Keep the harness runbook short.
- Change the operating contract from "follow nextAction" to "follow the current
  task-plan frontier."
- Keep pre-call lookup in `<context>`, but avoid duplicating workflow rules that
  the planner now owns.

Expected prompt contract:

```txt
The TypeScript flow harness owns workflow state, task phase, missing facts,
tool sequencing, and side-effect safety. At the start of each caller turn, call
record_turn_understanding once to update facts. Then follow the latest
task-plan command: phase, missingFacts, nextSafeAction, allowedTools, and
blockedActions.
```

### 2. Turn-State Injection

Current:

- `src/agent.ts` injects `compileTurnStatePacket(state.flow)` after every caller
  turn.
- `src/flow/context.ts` builds a step-centric packet with `intent`, `task`,
  `step`, `scheduling`, `nextAction`, and `blockedActions`.

Target:

- `src/agent.ts` keeps the same injection hook.
- `compileTurnStatePacket` reads the latest `WorkflowCommand` or recomputes a
  pure planner snapshot.
- The packet becomes task-plan-centric:
  - task kind
  - task ID
  - patient ref and verification status
  - phase
  - known facts
  - missing facts
  - next safe action
  - allowed tools
  - blocked side effects

No raw transcript or raw tool payload should be injected.

### 3. Turn Understanding

Current:

- `record_turn_understanding` uses `applyTurnUnderstandingFromTranscript`.
- Then `advanceFlowForTurn` calls the task-plan planner through
  `planNextCommand`.
- The result is compressed by `compactTurnCommandResponse`.

Target:

- `record_turn_understanding` still runs once per user turn.
- It only applies semantic facts: intent, patient facts, appointment target
  clues, preferred window, confirmations, corrections, and no-further-help.
- After fact ingestion, the planner computes `WorkflowCommand`.
- `compactTurnCommandResponse` returns the compact projection of
  `WorkflowCommand`.

The LLM-facing result should include at least:

```json
{
  "status": "recorded",
  "task": "appointment_reschedule",
  "phase": "searching_replacement",
  "missingFacts": ["replacementAvailability"],
  "nextAction": "get_availability",
  "action": "call_tool",
  "tool": "get_availability",
  "allowedTools": ["get_availability"],
  "blockedActions": ["reschedule_appt"],
  "instruction": "Call get_availability now."
}
```

### 4. Planner Entry Point And Modules

Current:

- The old `src/flow/controller.ts` decision implementation has been removed.
- `src/flow/plans/task-planner.ts` owns the live `planNextCommand` dispatch.
- Per-plan behavior is split across:
  - `src/flow/plans/appointment/confirm.ts`
  - `src/flow/plans/appointment/cancel.ts`
  - `src/flow/plans/appointment/reschedule.ts`
  - `src/flow/plans/scheduling.ts`
  - `src/flow/plans/simple.ts`
- Shared command construction, patch application, and `FlowDecision`
  compatibility live in `src/flow/plans/common.ts`.

Target:

- Keep the pure planner entry point:

```ts
export function planNextCommand(state: CallFlowState): WorkflowCommand;
```

- Keep planner modules split by plan family:
  - `advanceAppointmentLookupSubplan`
  - `advanceAppointmentConfirmPlan`
  - `advanceAppointmentReschedulePlan`
- Do not reintroduce the old controller decision path; legacy `FlowDecision` is produced only
  by adapting a `WorkflowCommand`.

Planner behavior for the bad trace:

```txt
verified patient + loaded appointments + unique Dr. Bach target + Monday 1 PM
  -> phase=searching_replacement
  -> nextSafeAction=call_tool get_availability
  -> allowedTools=[get_availability]
```

### 5. State Types

Current:

- `CallFlowState` has `activeIntent`, `activeFlow`, `step`, `currentTask`,
  `schedulingGoal`, `pendingActions`, and `availabilitySearches`.
- `SchedulingGoalState.appointmentAction` is overloaded for schedule, confirm,
  cancel, and reschedule.

Target:

- Add task-plan state while keeping legacy fields during migration:

```ts
interface CallFlowState {
  taskPlans?: Record<string, ParentTaskPlan>;
  activeTaskPlanId?: string;
  lastWorkflowCommand?: WorkflowCommand;
}
```

- First slice adds:

```ts
type ParentTaskPlan =
  | AppointmentConfirmPlan
  | AppointmentReschedulePlan;

type TaskSubplan = AppointmentLookupSubplan;
```

- `schedulingGoal` remains for legacy scheduling until the scheduling plan
  migration.
- Reschedule state moves out of `schedulingGoal.appointmentAction` and into
  `AppointmentReschedulePlan`.

### 6. Tool Exposure

Current:

- `src/tooling/tool-exposure.ts` computes visible tools from `flow.step`,
  `activeIntent`, and a few helper predicates.
- Pending turns expose `record_turn_understanding` plus current step tools.
- `lookup_knowledge` remains visible in many operational states.
- There is no model-facing `reschedule_appt` tool today; reschedule is currently
  assembled from appointment lookup, availability, booking, and cancellation
  behavior.

Target:

- Pending turns expose `record_turn_understanding` plus the broad workflow tool
  set because the SDK may capture tools before the state update runs.
- After turn understanding is recorded, the broad workflow tool set remains
  visible.
- Wrapper gates reject calls only when concrete state is missing or stale, not
  because the tool is outside the latest planner command.
- `lookup_knowledge` remains visible broadly.
- Add a model-facing `reschedule_appt` tool or an internal planner command with
  the same contract. The model should not orchestrate direct `book_appt` plus
  `cancel_appt` for reschedules.

### 7. Tool Policy And Side Effects

Current:

- Wrapper guards enforce many safety checks.
- Pending actions protect booking, cancellation, route, transfer, registration,
  and insurance update side effects.

Target:

- Keep wrapper guards.
- Attach each pending action to task plan ID, patient ref, and planner phase.
- Add a `reschedule_appt` pending action for the confirmed replacement of one
  old appointment with one offered new slot.
- The `reschedule_appt` pending action must carry the note payload required for
  the replacement appointment, not trigger a later `add_patient_note` action.
- A side-effect wrapper must validate:
  - pending action exists when required
  - pending action is confirmed and unconsumed
  - patient/task IDs match
  - required patient, appointment, availability, and note facts exist
- For reschedule, success means the replacement appointment exists and the old
  appointment is cancelled. Anything less is `partial_failure`, not success.

### 8. Tests And Telemetry

Current:

- Existing reducer and tool-exposure tests cover many step-level behaviors.
- SDK-level tests verify broad tool exposure, concrete prerequisite gates, and
  dynamic tool refresh behavior.

Target:

- Add transcript-shaped regression tests for the appointment-management slice.
- Assert planner command, missing facts, allowed tools, and blocked actions.
- Add telemetry fields:
  - `planner.taskKind`
  - `planner.phase`
  - `planner.missingFacts`
  - `planner.allowedTools`
  - `planner.blockedActions`
  - `planner.commandSource`
  - hidden-tool attempted calls

## Implementation Path

### Phase 1: Contract And Regression Tests

- Add tests for the `SCL_kPv8L7nVVxtm` reschedule trace.
- Assert that once old appointment and preferred window are known, the command
  is `call_tool get_availability`.
- Assert `lookup_knowledge` is not exposed for scheduler availability.
- Assert confirm appointment tasks complete after the appointment readback path.
- Assert ambiguous target appointment selection asks the caller instead of
  guessing.
- Assert reschedule does not expose `add_patient_note`, direct `book_appt`, or
  direct `cancel_appt` as the final model-facing action.
- Assert the final confirmed action is one `reschedule_appt` command.
- Assert `reschedule_appt` includes the appointment note payload required for
  the replacement appointment.
- Assert replacement-booked/old-cancel-failed enters `partial_failure`.

### Phase 2: First-Slice Planner Types

- Add `WorkflowCommand`.
- Add `AppointmentConfirmPlan`.
- Add `AppointmentReschedulePlan`.
- Add `AppointmentLookupSubplan`.
- Add planner capsules to `<turn_state>` for those plans.
- Keep legacy fields during migration, but treat task plans as authoritative.
- Do not add registration, insurance, transfer, or all scheduling plan types in
  this phase.

### Phase 3: Pure Appointment Planner

- Implement a pure `planNextCommand(state)` path for appointment management.
- Return explicit `statePatch` values instead of mutating state from inside the
  planner.
- Apply planner patches through one reducer helper.
- Keep existing `FlowDecision` compatibility only as a `WorkflowCommand`
  adapter; do not keep or reintroduce the old controller decision path.

### Phase 4: Reschedule Planner

- Implement `advanceExistingAppointmentReschedule`.
- Create or hydrate `AppointmentReschedulePlan`.
- Bind old appointment selection, preferred window, availability search,
  replacement slot, confirmation, and reschedule operation result into one
  ledger.
- Enforce unique target selection before availability.
- Call `get_availability` as soon as target appointment and preferred window are
  both known and required visit context is present.
- Call one `reschedule_appt` action after the caller confirms the exact
  replacement. Include the replacement appointment note payload in that action.
  Do not call `add_patient_note` as a separate reschedule step.

### Phase 5: Broad Tool Exposure With Concrete Guards

- Keep the broad workflow tool set visible.
- Use `WorkflowCommand.allowedTools` as planner guidance and telemetry, not as
  a hard tool frontier.
- Keep wrapper enforcement tied to concrete state because SDK tool visibility
  can lag during the current model turn.
- Add telemetry for hidden-tool attempted calls and planner phase.

### Phase 6: Expand Appointment Management

- Implement `AppointmentCancelPlan` after reschedule is passing.
- Share `AppointmentLookupSubplan` across confirm, cancel, and reschedule.
- Close confirm tasks cleanly after appointment readback and conversational
  confirmation.
- Add `EndCallPlan` for "no further help" after task completion.

### Phase 7: Task-by-Task Migration

Recommended order after appointment management:

1. Availability search subplan.
2. Booking subplan.
3. New appointment scheduling.
4. Registration.
5. Insurance.
6. Office routing.
7. Transfer.
8. Multi-patient switching and corrections.

### Phase 8: Enforcement And Observability

- Record planner phase, missing facts, allowed tools, blocked tools, and task ID
  in call telemetry.
- Add eval fixtures for full task transcripts, not only single tool calls.
- Promote planner violations from report-only to enforcement once false
  positives are understood.

## Success Criteria

- The harness can explain why it is asking, calling, confirming, or refusing.
- Every patient-bound tool call is tied to a patient ref and task ID.
- Every side effect consumes a confirmed pending action.
- Every availability search has a task-owned search signature and budget.
- Existing appointment reschedules cannot skip from "new preferred time" to
  knowledge lookup or cancellation.
- "No" after task completion closes the task.
- Model-visible state is smaller but more useful: task, phase, known facts,
  missing facts, next safe action, allowed tools.

## Main Pushback

Do not make this a mega-prompt.

The prompt should not encode a hidden graph of office workflows. The harness
should own the graph. The LLM should turn caller language into facts and speak
the planner's next safe action naturally.
