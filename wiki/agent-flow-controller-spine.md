# Agent Flow Controller Spine

## Why this exists

Abita's current agent works, but too much business control lives in prompt prose,
tool descriptions, and model judgment. The reliability problem is not only prompt
wording. The agent needs a code-owned workflow spine that decides the current
flow, allowed actions, sequencing rules, routing decisions, and structured tool
outcomes.

The implementation should not use LiveKit Tasks or TaskGroup for this phase.
Those primitives are useful for bounded collection flows, but the core Abita
business rules need to be explicit TypeScript that can be unit-tested without a
voice session.

## Core architecture

```txt
caller audio
  -> STT and language runtime
  -> intent and slot extraction
  -> flow controller
  -> allowed tool or meta-tool
  -> structured outcome
  -> concise spoken response
```

The LLM owns:

- natural conversation
- bilingual phrasing
- empathy and tone
- extracting caller-provided facts
- asking the next human-friendly question
- recognizing that the caller changed topics or corrected a prior fact

Code owns:

- active flow and step
- active patient or patient candidate
- known facts, missing facts, and fact provenance
- required slots
- allowed and blocked tools
- insurance, routing, and scheduling rules
- duplicate tool prevention
- confirmation gates
- availability search budgets and cached slot sets
- transfer and end-call rules
- state updates after tools
- invalidating stale downstream state when the caller corrects upstream facts

## Design verdict after plan review

The code-owned spine is still the right direction, but the next layer should be
more explicit than a single call-level workflow state. Real calls are not a
linear schedule flow. A caller can ask a quick FAQ in the middle of scheduling,
switch from themselves to a child, ask a bare insurance question, correct a
spelled last name, or book for more than one patient in the same call.

The improved direction is:

```txt
CallState
  -> intent triage
  -> active patient context
  -> patient-scoped task state
  -> pending action ledger
  -> availability search cache and budget
  -> small model-visible next-action packet
  -> guarded tool execution
```

This is not a rigid workflow. It is a conversation runtime. The state describes
the facts currently known, the active task, which patient those facts belong to,
which actions are safe, and what should be invalidated if the caller corrects
something.

The current branch is a valid shadow-mode first slice. The next meaningful
upgrade is to make the harness operationally stricter in three places before
hard enforcement expands:

1. **Availability policy**: dedupe searches, cache slots, cap repeated
   `get_availability` calls, and force broaden/ask/transfer behavior after a
   budget.
2. **Patient-scoped state**: make canonical patient identity, spelling
   corrections, and multi-patient switching explicit before patient-specific
   tools run.
3. **Booking and pending-action guards**: require a confirmed, unconsumed
   pending action tied to the active patient, current slot, appointment type,
   and availability result before side effects.

Intent triage is still important, but it supports these three hardening lanes
rather than becoming a broad rigid workflow.

## Live-call production baseline

The latest 1000 production `AgentCall` rows validate the direction but also
change the implementation priority. These are screening signals from structured
call data and tool traces, not final human-labeled defects, so enforcement still
requires representative manual review.

Scope:

- 1000 calls reviewed.
- Window: 2026-05-18T14:44:54.220Z through 2026-05-21T12:29:19.319Z.
- 705 calls used at least one tool.
- 0 calls had new `flow` telemetry, so the current branch's shadow spine was
  not visible in this corpus.
- 552 calls completed and 448 escalated or transferred.

Measured pressure points:

- `get_availability`: 515 total tool calls.
- 185 calls used `get_availability`.
- 65 calls had 3+ availability calls.
- 25 calls had 5+ availability calls.
- Worst availability loop: 40 calls in one conversation.
- 34 calls had duplicate availability search signatures.
- 81 calls showed availability-after-budget risk.
- 158 calls used `verify_patient`; 61 had 2+ verification calls.
- 164 calls had caller spelling/correction signals near patient tools.
- 158 calls used `check_insurance`; 62 had 2+ insurance checks and 32 had 3+.
- 34 calls looked like bare-insurance triage risks.
- 77 calls had multi-patient signals; 45 also used patient tools.
- 122 calls attempted booking; 11 had 2+ booking attempts.
- 17 booking errors were detected, including 12 slot-unavailable errors and 4
  invalid appointment-type errors.
- 6 calls eventually booked successfully after booking errors.

What this means:

- Availability policy should be the first production-prioritized hardening lane.
- Patient-scoped state is not optional; live calls really do switch patients and
  contain corrections.
- Booking guards need stale-slot and duplicate-attempt handling, not just a
  generic "confirm before booking" instruction.
- The old "first enforced guard" candidate remains valid only if shadow data
  proves it has the lowest false-positive risk. Based on the 1000-call review,
  duplicate or over-budget availability is now the leading enforcement
  candidate to investigate.

## Interview-derived failure modes

The highest-value harness work should target these concrete failures:

1. **Initial intent confusion**
   - The agent must distinguish new appointment, existing appointment
     confirmation, cancellation, reschedule, bare insurance question, FAQ,
     transfer request, and unclear intent before touching side-effecting tools.
   - If intent is unclear, the next action is one clarifying question, not
     `verify_patient`, `add_patient`, or `get_availability`.

2. **Existing patient mistaken for new patient**
   - The agent sometimes tries to register a patient who is already on file or
     only calling to confirm an appointment.
   - Registration should be unavailable unless the patient lookup/verification
     path produced an explicit no-match or the caller explicitly says they are
     new.

3. **Medical vs routine-vision insurance triage**
   - A bare "do you take my insurance?" question is not enough to check
     coverage.
   - The controller must know whether the caller means medical/surgical eye care
     or routine eye exam/glasses/contacts before `check_insurance`.
   - The medical and routine-vision coverage maps can produce different answers
     for the same plan name.

4. **Patient verification quality**
   - The caller may spell a last name, correct a first name, or call for a
     family member.
   - Spelled values should become authoritative slot values. The tool call
     should read from structured state, not from the model's best memory of the
     transcript.

5. **Multi-patient calls**
   - One call can involve multiple patients and multiple appointment tasks.
   - The active patient must be explicit. Changing active patient invalidates
     availability, pending booking, pending notes, and appointment-management
     state tied to the previous patient.

6. **New patient registration**
   - The registration flow is broadly acceptable, but the harness must ensure it
     captures all required fields, uses the checked canonical insurance plan,
     and calls `add_patient` exactly once for one confirmed pending registration.

7. **Availability loops**
   - Repeated `get_availability` calls are a high-volume failure mode.
   - The agent should not scan date after date blindly. It needs a search
     policy, duplicate-date guard, cached slots, expansion rules, and a maximum
     number of searches before it summarizes constraints or transfers.

8. **Booking correctness**
   - `book_appt` must be called once, for the active patient, using a slot that
     came from the current availability result and the same routing lane.
   - Booking must require a pending confirmed action and consume that pending
     action after success.

## Patient-scoped harness

The current `CallFlowState` is call-scoped. The next version should keep that,
but add a patient registry and make scheduling/appointment tasks bind to a
specific patient reference.

Suggested shape:

```ts
type PatientRef = string;

interface CallFlowState {
  activeIntent: IntentKind | null;
  activePatientRef?: PatientRef;
  patients: Record<PatientRef, PatientContext>;
  taskStack: TaskFrame[];
  currentTask?: TaskFrame;
  pendingActions: PendingAction[];
  availabilitySearches: AvailabilitySearch[];
  guardObservations: GuardObservation[];
}

interface PatientContext {
  ref: PatientRef;
  status: "unknown" | "candidate" | "matched" | "verified" | "new" | "created";
  relationshipToCaller?:
    | "self"
    | "child"
    | "parent"
    | "spouse"
    | "other_family"
    | "other"
    | "unknown";
  firstName?: TrackedSlot;
  lastName?: TrackedSlot;
  dob?: TrackedSlot;
  phone?: TrackedSlot;
  patientId?: string;
  verificationAttempts: number;
  lastVerifiedArgsHash?: string;
  lastNoMatchReason?: string;
  canonicalNameSource?: "phone_lookup" | "caller_spelled" | "caller_spoken";
  spellingConfirmed?: boolean;
  insurance?: InsuranceContext;
  appointments: CallerAppointment[];
  activeSchedulingTaskId?: string;
  activeAppointmentTaskIds: string[];
}

interface TrackedSlot {
  value: string;
  source:
    | "phone_lookup"
    | "caller_spoken"
    | "caller_spelled"
    | "tool_result"
    | "agent_inferred";
  confidence: "low" | "medium" | "high";
  confirmed: boolean;
  turnId?: string;
}
```

Rules:

- Never call patient-specific tools without an `activePatientRef`.
- Never use stale appointment, availability, or booking state after switching
  `activePatientRef`.
- Prefer caller-spelled slot values over transcript-normalized values.
- A phone lookup match is `matched`, not fully `verified`, until the caller
  confirms the right patient.
- Multiple phone matches create multiple candidate patient contexts, but the
  model should not read names back to the caller.
- `verify_patient`, `add_patient`, `check_insurance`, `get_availability`, and
  `book_appt` should build arguments from canonical patient state, not fresh
  transcript extraction.
- A caller correction updates the canonical slot first, then invalidates any
  verification, availability, pending registration, or pending booking that used
  the prior value.
- Do not open registration after one failed verification unless the current
  patient context has an explicit no-match result or the caller explicitly says
  they are a new patient.
- Track verification attempt count and argument hash so repeat lookups can be
  distinguished from a valid retry after a corrected spelling or DOB.

## Intent triage state

Initial intent should be a first-class decision point. It should classify:

- `new_appointment`
- `existing_appointment_confirm`
- `existing_appointment_cancel`
- `existing_appointment_reschedule`
- `insurance_question`
- `faq`
- `new_patient_registration`
- `transfer_request`
- `unclear`

The controller should ask one focused clarifying question for `unclear`.

Examples:

- "Do I have an appointment tomorrow?" -> appointment lookup or use preloaded
  appointment state, not registration.
- "Do you take Aetna?" -> ask whether this is medical eye care or routine
  vision before `check_insurance`.
- "I need an appointment for my daughter" -> create/select a patient context
  for the daughter before verification or availability.
- "What time do you close?" during scheduling -> push an FAQ side task, answer,
  then return to the scheduling task.

## Flexible state switching and backtracking

The controller should allow interruptions without losing the main task.

Use a task stack:

```ts
interface TaskFrame {
  id: string;
  kind: "schedule" | "appointment_management" | "insurance" | "faq" | "transfer";
  patientRef?: PatientRef;
  step: FlowStep;
  returnTo?: string;
  createdAt: number;
}
```

If the caller asks an FAQ mid-schedule, push an `faq` task with `returnTo` set
to the scheduling task. After the answer, pop back and ask the next scheduling
question.

If the caller corrects an upstream fact, invalidate dependent downstream state:

- Patient changed -> invalidate appointments, pending booking, pending note,
  active availability, and registration state for the old patient.
- Visit type changed -> invalidate coverage type, routing, availability, and
  pending booking.
- Office/routing changed -> invalidate availability and pending booking.
- Insurance plan changed -> invalidate insurance result, availability, and
  pending booking.
- Slot changed -> invalidate pending booking confirmation.

The model can still speak naturally. Code decides what facts survived the
correction and what must be recollected.

## Pending action ledger

Every side effect should require a pending action record. Guards should enforce
the ledger, not just a loose step name.

```ts
type PendingAction =
  | {
      id: string;
      type: "book_appt";
      patientRef: PatientRef;
      slotHash: string;
      appointmentTypeId: number;
      officeKey: OfficeKey;
      routing?: SchedulingRouting;
      availabilitySearchId: string;
      spokenSummary: string;
      confirmed: boolean;
      consumed: boolean;
      confirmationTurnId?: string;
      createdTurnId: string;
      lastBookingAttemptHash?: string;
      bookingAttemptCount: number;
      lastBookingErrorClass?:
        | "slot_unavailable"
        | "invalid_appointment_type"
        | "duplicate_same_slot"
        | "middleware_error"
        | "unknown";
      slotInvalidated: boolean;
    }
  | {
      id: string;
      type: "cancel_appt";
      patientRef: PatientRef;
      appointmentId: number;
      spokenSummary: string;
      confirmed: boolean;
      consumed: boolean;
      createdTurnId: string;
    }
  | {
      id: string;
      type: "add_patient";
      patientRef: PatientRef;
      requiredFieldsComplete: boolean;
      spokenSummary: string;
      confirmed: boolean;
      consumed: boolean;
      createdTurnId: string;
    }
  | {
      id: string;
      type: "update_insurance" | "transfer_call" | "route_office";
      patientRef?: PatientRef;
      spokenSummary: string;
      confirmed: boolean;
      consumed: boolean;
      createdTurnId: string;
    };
```

Rules:

- `book_appt`, `cancel_appt`, `add_patient`, `update_insurance`, transfer, and
  office routing all require a matching pending action before execution.
- A successful side effect marks the pending action consumed.
- Duplicate tool calls for a consumed action return a safe no-op result.
- If a caller changes the patient, visit type, office, insurance, or slot, the
  affected pending action is cancelled and must be rebuilt.
- `book_appt` must match the active patient, selected slot hash, appointment
  type, office/routing lane, and source availability search.
- A slot-unavailable booking error invalidates the pending booking. The same
  booking action cannot be retried blindly; the controller must return to
  availability or offer another cached slot.
- An invalid appointment-type booking error invalidates the appointment type and
  routing lane for that pending action.
- Booking attempt count and attempt hash should be recorded in report-only mode
  before any hard blocking, so valid retries can be separated from loops.

## Availability search policy

Availability should be a controlled search, not free-form repeated tool calls.

```ts
interface AvailabilitySearch {
  id: string;
  patientRef: PatientRef;
  officeKey: OfficeKey;
  visitType: VisitType;
  coverageType?: InsuranceCoverageType;
  routing?: SchedulingRouting;
  appointmentTypeId?: number;
  requestedWindow?: string;
  searchedKeys: string[];
  cachedSlots: CachedSlot[];
  rejectedSlotHashes: string[];
  exactSearchCount: number;
  broadenCount: number;
  duplicateSearchCount: number;
  maxSearches: number;
  failureReasons: Array<
    | "no_slots"
    | "caller_rejected"
    | "slot_unavailable"
    | "invalid_appointment_type"
    | "duplicate_search"
    | "budget_exhausted"
  >;
  status: "active" | "exhausted" | "satisfied" | "invalidated";
}
```

Search key should include date/window, office, routing lane, visit type,
coverage type, appointment type, patient age lane, provider/column restrictions,
and any explicit caller constraints. A duplicate key should not call middleware
again.

Initial rules:

- No availability before visit reason.
- No availability before the correct office/routing lane is known.
- No duplicate same date/routing search.
- Reuse cached slots before calling again.
- If the caller rejects one offered slot, offer another cached slot when one is
  available.
- If `book_appt` returns slot unavailable, reject that slot hash and offer
  another cached slot before calling availability again.
- If `book_appt` returns invalid appointment type, invalidate the search lane
  and rerun routing before another booking attempt.
- After a small budget, summarize what was searched and either broaden the
  window, ask for a different preference, or transfer. Do not keep scanning
  one date at a time indefinitely.
- Changing patient, visit type, insurance, office, routing, or provider
  restrictions invalidates the search.
- Record exact search count, broaden count, duplicate count, and exhausted
  status in analytics even before the guard blocks anything.

Initial report-only thresholds:

- Flag 3+ availability calls in one call as loop risk.
- Flag 5+ availability calls as high-severity loop risk.
- Flag duplicate search signatures immediately.
- Flag booking after an exhausted availability search.
- Flag booking against a slot not produced by the current active search.

This directly targets the repeated `get_availability` loop failure mode.

## Guard and tool policy contract

Guards should evolve from observations into a single tool policy layer.

Every risky tool should go through:

```ts
type ToolPolicyResult =
  | { allowed: true; statePatch?: Partial<CallFlowState> }
  | {
      allowed: false;
      outcome: ToolOutcome;
      reason: GuardObservationReason;
      nextSafeStep: FlowStep;
    };
```

The policy layer should own:

- prerequisite checks
- duplicate detection
- patient binding
- stale state detection
- pending action validation
- state patches after success
- safe no-op responses for already-consumed actions

Tool bodies should remain execution boundaries. They should call the policy
before side effects, execute middleware/SIP only when allowed, and apply the
policy-approved state patch or outcome.

## Context injection direction

The model should not see the whole call state. It should see the smallest useful
packet for the current turn.

Inject a compact packet after report-only observations are validated:

```xml
<turn_state>
intent: new_appointment
activePatient: patient_2
patientStatus: matched_not_verified
task: scheduling
step: check_insurance
visitType: routine_vision
office: crystal-river
missingSlots: insurancePlan
nextAction: ask_insurance_plan
blockedActions: add_patient, get_availability, book_appt
</turn_state>
```

Rules:

- Inject in the turn-level context hook, not by rewriting the stable prompt
  prefix.
- Include only derived state and next action, not raw transcripts or raw tool
  output.
- Keep it short enough for voice latency.
- Redact or hash sensitive values unless the model needs to speak them.
- Prefer `nextAction` plus `blockedActions` over long prose instructions.

## Evaluation harness direction

The eval harness should be built from actual failure modes, not generic happy
paths.

Start with focused cases:

- initial intent: new appointment vs existing appointment vs FAQ vs insurance
- bare insurance question requires medical vs routine-vision clarification
- routine vision at Crystal River requires route before availability
- Hollywood/Sweetwater routine vision stays local
- existing patient does not enter registration
- no-match patient enters registration only after explicit no-match/new-patient
  path
- spelled last name is sent exactly to `verify_patient`
- multiple patients on one call keep separate patient contexts
- changing active patient invalidates availability and pending booking
- availability does not repeat the same date/routing search
- cached slots are reused before calling `get_availability` again
- availability search stops after budget and asks or transfers
- booking requires pending confirmed slot
- duplicate booking call is no-op after success
- cancel requires loaded appointment and explicit confirmation
- reschedule books new appointment before cancelling old appointment

Acceptance criteria before enforcing a guard:

- The report-only guard appears in real analytics.
- Review shows it catches real unsafe behavior.
- Review shows no meaningful valid-call false positives.
- Unit tests cover allowed and blocked paths.
- At least one transcript/eval case covers caller correction or backtracking.
- No meaningful latency regression appears in call analytics.

## First implementation slice

Build the smallest useful spine first:

1. Add `CallFlowState` to per-call `session.userData`.
2. Add a shared `ToolOutcome` shape for flow/meta-tool decisions.
3. Add a context compiler that can produce a small state packet for the model.
4. Add `prepareSchedulingPath` as the first meta-tool function.
5. Add controller/guard tests around visit triage, insurance, Crystal River
   routing, and scheduling prerequisites.

Do not rewrite every call path at once. Start with:

```txt
visit type -> insurance -> office routing -> scheduling
```

## Current branch state

Branch: `feature/flow-controller-spine`

Implemented:

- `CallFlowState`, `ToolOutcome`, and flow decision types under `src/flow/`.
- `createInitialFlowState` attached to `session.userData.flow` during session
  startup.
- `compileFlowContextPacket` for state-scoped model context.
- `prepareSchedulingPath` for visit triage, insurance/routing normalization,
  Crystal River to Spring Hill routing, urgent handling, and optical-shop
  transfer decisions.
- `guardToolCall` for report-only guard observations. It records whether risky
  tools would be allowed, but does not block execution.
- Shadow observer wiring in `src/main.ts`: final user transcripts generate
  redacted flow predictions, tool executions are compared against the latest
  prediction, and shadow events are sent in the analytics payload under `flow`.
- Flow state hydration from patient lookup/tool results in `src/tools.ts`.
- Tests covering flow state creation, context packet output, scheduling-path
  decisions, report-only guards, shadow mismatches, Spanish routine vision
  phrases, bare insurance questions, and tool-side flow-state hydration.

Important non-goals for the current branch:

- No hard blocking yet.
- No prompt injection of the flow packet yet.
- No LiveKit Tasks or TaskGroup.
- No middleware contract changes yet.

The current slice is a real shadow-mode spine: it observes and records expected
flow decisions without changing what the live model is allowed to do.

## State packet shape

The model should see a small compiled context packet, not the whole business
runbook every turn.

```xml
<flow_state>
activeFlow: scheduling
step: check_insurance
language: es
patientStatus: new
office: crystal-river
visitType: routine_vision
missingSlots: insurancePlan
allowedActions: ask_insurance_plan, check_insurance, prepareSchedulingPath
blockedActions: add_patient, get_availability, book_appt, cancel_appt
</flow_state>

<current_objective>
Collect the exact vision insurance plan, then check routine vision coverage.
</current_objective>
```

Keep the stable prompt prefix stable for caching. Put dynamic state later in the
context. Do not inject raw caller text or raw tool output into high-priority
instructions.

## Structured outcome shape

Every meta-tool should return the same shape:

```ts
type ToolOutcome = {
  outcome:
    | "success"
    | "needs_clarification"
    | "not_found"
    | "not_allowed"
    | "route_required"
    | "transfer_required"
    | "error";
  nextStep: FlowStep;
  statePatch?: Partial<CallFlowState>;
  speak?: string;
  facts?: Record<string, unknown>;
  retryable?: boolean;
};
```

## First meta-tool

`prepareSchedulingPath` should classify and normalize the fragile business
sequence before the model starts calling patient or scheduling tools.

Inputs:

```ts
{
  officeKey: OfficeKey;
  patientStatus: "unknown" | "matched" | "verified" | "new";
  visitReason?: string;
  insurancePlan?: string;
  coverageType?: "medical" | "routine_vision";
}
```

Responsibilities:

- classify medical vs routine vision vs optical-shop vs urgent
- choose medical or routine vision coverage
- recognize Crystal River routine vision as a Spring Hill routing case
- recognize plans rejected locally but accepted at Spring Hill
- return `needs_clarification` when visit type or plan is not specific enough
- return concise `speak` guidance that the LLM can translate and shorten

## Rollout posture

Ship in phases:

1. Shadow mode: compute expected next action and guard observations, do not
   block.
2. Telemetry verification: prove live calls persist the new flow fields and
   guard observations; the current 1000-call baseline had none.
3. Availability-first report-only policy: track search signatures, budgets,
   cached slots, duplicate searches, and stale-slot invalidation.
4. Patient-scoped harness: add patient registry, canonical slot provenance, task
   stack, and multi-patient switching.
5. Booking and pending-action ledger: track confirmation, slot provenance,
   source availability search, attempt count, and booking error class.
6. Soft guards: return structured `not_allowed` or safe no-op outcomes instead
   of executing unsafe side effects.
7. First enforced path: enforce one narrow, proven guard only after real traces
   show it has low false-positive risk.
8. Context injection: inject compact turn-level state after the observed state
   and guard signals are trustworthy.
9. Prompt cleanup: remove duplicated business rules only after tests, evals, and
   live traces prove code owns those rules.

## Next implementation step

The next step is not prompt cleanup. It is **deployable shadow telemetry plus
availability-first report-only hardening**.

The 1000-call review gives a strong baseline, but it cannot prove guard
false-positive rates because those calls had no `flow` telemetry. Build the
next slice in this order:

1. Deploy or otherwise verify that new calls persist `flow.shadowEvents`,
   `flow.guardObservations`, `flow.mismatchCount`, stable tool argument hashes,
   availability counters, pending action status, and patient/task identifiers.
2. Add report-only availability policy state: search signatures, cached slots,
   rejected slot hashes, exact search count, broaden count, duplicate count, and
   budget status.
3. Add report-only booking ledger state: selected slot hash, appointment type,
   source availability search id, confirmation turn, attempt hash, attempt
   count, and booking error class.
4. Add patient-scoped canonical identity state for verification, spelling
   corrections, and multi-patient switching.
5. Review representative live traces from the highest-risk buckets before any
   hard blocking: availability loops, duplicate searches, booking errors,
   verification loops, insurance loops, and multi-patient calls.
6. Enforce only the narrow guard with the cleanest shadow evidence. Based on the
   current baseline, duplicate or over-budget availability is the leading
   candidate to investigate, while Crystal River routine-vision routing remains
   a good candidate if traces show low false-positive risk.
7. Add a soft `not_allowed` or safe no-op response for that one guard only.
8. Add tests proving the guard blocks the unsafe action, preserves valid
   interruptions, and returns the next safe step.

Until representative shadow traces are reviewed, keep all guards report-only.

Do not make the first enforced guard a broad workflow lock. The agent must still
be able to answer FAQs, switch patients, and accept corrections mid-flow.

## Path to completion

1. **Shadow spine** — current branch.
   - Flow state, context compiler, `prepareSchedulingPath`, shadow predictions,
     tool observations, analytics payload fields, and tests.

2. **Flow telemetry presence check**.
   - Confirm new production calls actually persist `flow.shadowEvents`,
     `flow.guardObservations`, `flow.mismatchCount`, stable tool argument
     hashes, state snapshots, and final flow outcomes.
   - Target `>95%` telemetry presence before using live traces to choose a hard
     enforcement candidate.

3. **Report-only guards** — current branch plus availability counters.
   - Keep `guardToolCall` non-blocking.
   - Record tool name, stable argument hash, allowed/blocked status, reason,
     current flow state snapshot, patient/task identifiers, pending action id,
     availability search id, and invalidation reason.
   - Start with `check_insurance`, `route_to_spring_hill`, `add_patient`,
     `get_availability`, `book_appt`, and `cancel_appt`.

4. **Real call review**.
   - Review analytics for shadow mismatches, guard violations, repeated tool
     calls, skipped insurance checks, bad Crystal River routing, premature
     registration, and booking before confirmation.
   - Manually inspect representative calls before enforcement: 10 availability
     loop calls, 10 duplicate-search calls, 10 booking-error calls, 10
     verification-loop calls, 10 insurance-loop calls, 10 multi-patient calls,
     and 10 existing-appointment intent calls.

5. **Availability search policy**.
   - Move this ahead of the full patient-scoped rewrite because it is the
     highest-volume measured issue.
   - Cache searched date/routing keys and returned slots.
   - Reuse cached slots before calling `get_availability` again.
   - Record exact search count, broaden count, duplicate search count, rejected
     slot hashes, and exhausted status.
   - Enforce a small search budget before broadening, asking a new preference,
     or transferring.
   - Invalidate availability on patient, visit type, insurance, office, routing,
     provider, appointment type, or age-lane changes.

6. **Tool-call signature dedupe**.
   - Hash normalized tool arguments without PHI.
   - Detect same tool plus same semantic arguments within one active task.
   - Treat duplicate `get_availability`, duplicate `book_appt`, duplicate
     `verify_patient`, and duplicate `check_insurance` as separate metrics
     because the recovery path differs.

7. **Patient-scoped state model**.
   - Add patient registry, active patient reference, candidate patients from
     phone lookup, and per-patient appointment/insurance/scheduling state.
   - Track fact provenance for names, DOB, phone, insurance, and appointment
     reason.
   - Treat caller-spelled values as authoritative unless explicitly corrected.
   - Track relationship to caller, verification attempts, last verification
     argument hash, no-match reason, canonical name source, and active
     appointment task ids.

8. **Canonical verification and correction handling**.
   - Build `verify_patient`, `add_patient`, and `book_appt` arguments from
     canonical patient state.
   - When the caller corrects spelling, DOB, phone, visit type, insurance,
     office, slot, or patient relationship, update the canonical slot first and
     invalidate dependent downstream state.
   - Do not let a transcript-normalized value override a caller-spelled value
     unless the caller explicitly corrects it.

9. **Intent triage controller**.
   - Separate new appointment, existing appointment, cancellation, reschedule,
     insurance question, FAQ, transfer, and unclear intent before side effects.
   - Ask one clarifying question for unclear intent.
   - Prevent registration unless there is an explicit new-patient or no-match
     path.

10. **Booking and pending-action ledger**.
   - Require pending confirmed actions for `add_patient`, `book_appt`,
     `cancel_appt`, `update_insurance`, `route_to_spring_hill`, and
     `transfer_call`.
   - Mark actions consumed after successful side effects.
   - Return safe no-op outcomes for duplicate calls against consumed actions.
   - Tie `book_appt` to active patient, selected slot hash, appointment type,
     office/routing lane, source availability search id, and confirmation turn.

11. **Booking error recovery**.
   - On slot unavailable, invalidate the selected slot and return to cached
     alternatives or availability search.
   - On invalid appointment type, invalidate the appointment type/routing lane
     before another booking attempt.
   - Record booking attempt count and last error class before blocking retries.

12. **First enforced guard**.
   - Enforce only one narrow rule first, chosen from shadow data.
   - Leading candidates after the 1000-call baseline are duplicate/over-budget
     availability and stale-slot booking prevention.
   - Crystal River routine vision route-before-availability remains a good
     candidate if live traces show low false-positive risk.
   - Return a structured `not_allowed` outcome, not an exception.

13. **Insurance and registration sequencing guards**.
   - New patient scheduling cannot call `add_patient` before `check_insurance`.
   - Routine vision must use `coverageType: "routine_vision"`.
   - Bare insurance questions must triage medical vs routine vision first.
   - Unclear insurance plans must not proceed to registration.

14. **Scheduling sequencing guards**.
   - No `get_availability` before visit reason.
   - No `book_appt` before patient verification, preloaded phone-match identity,
     or creation.
   - No `book_appt` without recent availability and caller confirmation.
   - No duplicate same tool/same args unless caller changed the request.
   - No `cancel_appt` before appointment lookup and explicit cancellation
     confirmation.

15. **Context packet injection**.
   - Inject the compiled flow packet into model-visible context after guard
     observations look sane.
   - Keep the base prompt stable and put dynamic state later in context.
   - Prefer `nextAction`, missing slots, active patient, and blocked actions
     over long prose.

16. **Prompt cleanup**.
   - Remove duplicated business sequencing from `RUNBOOK.md` and tool
     descriptions once code owns those rules.
   - Keep prompt content focused on voice, tone, language switching, and current
     objective.

17. **Structured tool outcomes everywhere**.
   - Gradually normalize real tool responses into `ToolOutcome`.
   - Suggested order after the live-call review: `get_availability`,
     `book_appt`, `verify_patient`, `check_insurance`, `add_patient`,
     `route_to_spring_hill`, `cancel_appt`, `lookup_knowledge`,
     `transfer_call`.
   - Store full structured data in state when needed; return concise
     model-visible summaries.

18. **Additional meta-tools**.
   - Keep `prepareSchedulingPath` as the first meta-tool.
   - Add only if repeated traces justify them: `prepareAvailabilitySearch`,
     `prepareAppointmentBooking`, `prepareNewPatientRegistration`,
     `prepareCancellation`, `prepareTransfer`.

19. **Decision-point evals**.
   - Build a small first suite, then expand toward a failure-mode matrix.
   - Cover insurance/routine vision, Crystal River routing, new-patient
     registration, existing appointments, multi-patient calls, spelled-name
     verification, availability loop prevention, booking confirmation, booking
     error recovery, cancellation, transfer, and side-task FAQ recovery.
   - Assert active patient, flow step, allowed tool, blocked tool, state patch,
     pending action state, availability cache state, and spoken response
     category.

20. **Gradual enforcement**.
   - Enforce guards in this order only if shadow data supports the false-positive
     risk:
     - No duplicate same availability search signature.
     - No repeated availability search after budget is exhausted.
     - No booking against a slot outside the active availability search.
     - No retry of a slot-unavailable booking without a new slot.
     - Crystal River routine vision route before availability.
     - No `add_patient` before insurance check.
     - No `book_appt` before verified, preloaded phone-match, or created
       patient.
     - No `book_appt` before confirmation.
     - No `cancel_appt` before cancellation confirmation.

21. **Analytics visibility**.
   - Each call should show current flow state, shadow predictions, actual tool
     calls, guard observations, blocked actions, and final outcome.
   - Add patient/task identifiers, pending action status, availability search
     counters, and invalidation reasons.
   - Keep raw PHI out of guard hashes and analytics unless explicitly required
     by downstream review.

22. **Success metrics against the 1000-call baseline**.
   - Flow telemetry presence: from 0% to `>95%`.
   - Availability 3+ rate: from 6.5% to `<2%`.
   - Availability 5+ rate: from 2.5% to `<0.5%`.
   - Duplicate availability searches: from 3.4% to `<1%`.
   - Booking repeat attempts: from 1.1% to near zero unless the caller changed
     slot or appointment details.
   - Transfer after 3+ tools should fall without increasing bad bookings,
     unresolved calls, or latency.

23. **Completion criteria**.
   - Prompt is smaller and no longer owns business sequencing.
   - Tool results are structured.
   - Controller owns routing and scheduling gates.
   - Patient context owns identity, appointments, and patient-specific tasks.
   - Pending action ledger owns side-effect confirmation and duplicate
     prevention.
   - Availability search policy prevents loops.
   - Evals cover risky flows, caller corrections, booking error recovery, and
     multi-patient switching.
   - Live traces show fewer skipped insurance/routing/booking mistakes.
   - Live traces show fewer repeated availability loops.
   - Transfers and unresolved calls do not increase.
   - No meaningful latency regression.

## Plan review verdict

Reviewed against the research/source material, this plan is still the right
direction. The important choice is to make code-owned state, report-only guards,
structured outcomes, patient-scoped context, and pending actions the control
plane before changing the prompt.

The plan should become more detailed in the harness layer, not more prompt-heavy.
The risk is not that the controller is too structured; the risk is making it
step-rigid. The right design is fact-driven state with backtracking and
invalidation rules.

Keep these constraints:

- Do not make prompt text the source of truth for business sequencing.
- Do not inject raw caller transcript text or raw tool output into high-priority
  instructions.
- Do not make state transitions depend on model memory of old turns when a
  structured slot exists.
- Do not assume dynamic LiveKit tool filtering is available until verified
  against the installed SDK and current docs; use report-only guards first.
- Do not build speculative meta-tools. Add meta-tools only when traces show a
  repeated tool sequence worth collapsing.
- Do not enforce broad workflow locks that prevent quick questions, patient
  switches, corrections, or backtracking.
- Do not use LiveKit `TaskGroup` as the top-level flow owner. It can be
  revisited later for bounded collection flows, but not for routing, insurance,
  booking, cancellation, or transfer policy.

## Source context

- State-driven workflow grounding: https://arxiv.org/abs/2403.11322
- Meta-tools for repeated agent workflows: https://arxiv.org/abs/2601.22037
- Context engineering for agents: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- OpenAI context management split between local context and model-visible
  context: https://openai.github.io/openai-agents-js/guides/context/
- OpenAI agent safety guidance on prompt injection, structured outputs, and
  evals: https://platform.openai.com/docs/guides/agent-builder-safety
- LangChain context engineering patterns for state-aware prompts and tools:
  https://docs.langchain.com/oss/python/langchain/context-engineering
- LiveKit Tasks/TaskGroup docs reviewed but intentionally not used in this
  phase: https://docs.livekit.io/agents/logic/tasks.md
