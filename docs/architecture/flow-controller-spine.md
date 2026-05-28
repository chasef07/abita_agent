# Agent Flow Controller Spine

Current implementation contract: `flow-controller-current-contract.md`.

Superseded state model: durable flow writes now go through the single-writer
event reducer described in `single-writer-flow-state-spec.md`. Older
`statePatch` examples in this document are historical only.

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

Related architecture note: `../history/flow-harness-learnings.md` captures the
state-update tool, reducer, memory, pre-call state, and LLM/harness balance
decisions behind this phase plan.

## Core architecture

```txt
caller audio
  -> STT and language runtime
  -> main LLM record_turn_understanding state-update tool
  -> deterministic state reducer
  -> flow controller
  -> allowed tool or meta-tool
  -> structured outcome
  -> concise spoken response
```

The LLM owns:

- natural conversation
- bilingual phrasing
- empathy and tone
- proposing structured `TurnUnderstanding` from each caller turn
- asking the next human-friendly question
- recognizing that the caller changed topics or corrected a prior fact

Code owns:

- accepting or ignoring the proposed `TurnUnderstanding`
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

The earlier branch was a valid shadow-mode first slice. The current branch has
now moved the live path to an active semantic reducer: the main LLM proposes
structured turn understanding through `record_turn_understanding`, and
TypeScript applies the state changes. The harness should now stay
operationally strict in three places before controlled real-call testing
expands:

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
- `advanceFlowForTurn` as the first deterministic turn-router layer after
  `record_turn_understanding`: it applies semantic state, resolves internal
  meta decisions like `prepareSchedulingPath`, and returns a concrete next
  action instead of leaking meta-tool decisions to the model/harness.
- `guardToolCall` for report-only guard observations. It records whether risky
  tools would be allowed, but does not block execution.
- `evaluateFlowToolPolicy` for pre-side-effect policy decisions before
  middleware/SIP calls.
- Explicit guard `enforcement` metadata distinguishes observe-only findings from
  runtime blocks while preserving the existing `mode: report_only` analytics
  shape.
- Structured `ToolOutcome` policy responses for high-confidence blocked paths:
  bare insurance checks before visit-type triage, availability before visit
  type, duplicate/exhausted availability searches, registration before
  insurance, cancellation before explicit confirmation, cancellation before a
  loaded appointment, insurance updates before verification, and booking without
  a matching confirmed pending action.
- Report-only availability policy state for search signatures, cached slots,
  duplicate counts, budget exhaustion, no-slot outcomes, invalidated searches,
  stale-slot rejection, and duplicate detection after cached slots are already
  satisfied.
- Booking ledger state for slot-bound pending booking actions, booking attempt
  hashes, booking error classes, consumed actions, and appointment-type
  invalidation. `book_appt` creates the confirmed pending action internally
  from reducer state before it submits the booking.
- Shared pending side-effect actions for cancellation, registration, insurance
  update, office routing, and transfer. The final side-effect tools create the
  confirmed action internally before they run, and the policy returns safe no-op
  outcomes for duplicate consumed actions.
- Semantic `TurnUnderstanding` schema and reducer for new appointment,
  existing appointment lookup/cancel/reschedule, insurance question, FAQ,
  new-patient registration, transfer request, patient identity details,
  preferred windows, visit type, insurance plan, corrections, backchannels, and
  unclear turns.
- Live runtime turn understanding via the main LLM's internal
  `record_turn_understanding` tool: the model proposes structured semantic
  state, TypeScript applies the reducer, and the tool returns the resulting
  `<turn_state>`. Final transcript events no longer mutate flow state with
  keyword rules.
- Compact `<turn_state>` packet injection in `Agent.onUserTurnCompleted`, using
  the current hidden state without injecting raw transcripts or tool output.
- The old flow-shadow prediction loop is no longer on the live runtime path.
  Analytics no longer emits empty shadow fields; semantic eval telemetry should
  use a new explicit shape when it is added.
- Flow state hydration from patient lookup/tool results in `src/tools.ts`.
- Active patient context is synced back into the legacy top-level tool fields
  before patient-bound middleware calls, so resumed patient tasks use the right
  `patientId`, name, DOB, and appointment set.
- First-name confirmation for a single pre-call phone lookup match marks that
  patient verified without another middleware verification call.
- Transfer requests during recoverable scheduling get one controller-owned
  pushback before transfer is offered on a repeated request.
- Patient note writes are blocked until the active patient has a successful
  consumed booking action, keeping appointment reason/referrer notes tied to a
  completed booking.
- Tests covering flow state creation, context packet output, scheduling-path
  decisions, legacy intent classification, semantic turn-understanding reducer,
  deterministic turn routing, turn-state packet output, report-only guards,
  shadow observer compatibility, Spanish routine vision phrases, bare insurance questions,
  availability/booking recovery telemetry, and tool-side flow-state hydration.

Important non-goals for the current branch:

- No broad hard blocking yet; only the tested policy responses above are active.
- No LiveKit Tasks or TaskGroup.
- No middleware contract changes yet.

The current slice is an active state-injection plus shared policy spine: it
guides the model with compact hidden state, applies semantic caller-memory
updates before each response, and blocks high-confidence unsafe
repeats/no-confirmation/precondition paths. Phase 2 local eval gates are
complete; the next gate is controlled real-call testing after the full local
validation bundle passes on this active reducer branch.

Current step as of 2026-05-22:

- Phase 1 local control-plane implementation is locally green.
- Phase 2 local eval and validation suite is locally green.
- Phase 2.5 semantic state reducer is implemented: `TurnUnderstanding` is now
  the live state front door, not keyword-only intent mutation or shadow-only
  prediction.
- Latest local gate passed: `pnpm exec tsc --noEmit`, `pnpm test` (194 tests),
  `pnpm exec eslint .`, `pnpm run format:check`, and `git diff --check`.
- Added transcript-replay eval harness in
  `src/__tests__/transcript-eval-harness.test.ts`.
- Added reducer/schema coverage in `src/__tests__/turn-understanding.test.ts`.
- Current eval coverage includes pre-call appointment state, cancellation
  confirmation, past-appointment filtering, duplicate availability loops,
  pending booking actions, stale-slot recovery, invalid appointment-type
  recovery, multi-patient scoping, FAQ suspend/resume, first-name pre-call
  verification, reschedule ordering, transfer pushback, transfer gating,
  duplicate transfer/cancellation no-ops, transfer failure recovery, patient-note
  timing, Spring Hill routing confirmation, and compact turn-state privacy/size
  assertions.
- Next deliverable: Phase 3 controlled real-call testing against live calls,
  with every test call reviewed for repeated availability, stale booking,
  cancellation, patient-context, transfer, and latency issues.

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
schedulingGoal: schedule collecting
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

The rollout posture has changed: finish the full Jarvis/stateful
implementation locally, validate it with deterministic tests and transcript
evals, then run controlled real-call testing.

Build and test in this order:

1. Complete the local control plane:
   - intent state
   - patient-scoped state
   - canonical slot provenance and correction handling
   - task stack and active task ownership
   - pending action ledger
   - availability policy
   - booking and cancellation recovery
   - structured tool outcomes
   - compact turn-state injection
   - prompt/tool prose cleanup after code owns the rules
2. Add a single tool policy layer for risky tools. The policy layer may return
   structured `not_allowed` or safe no-op outcomes, but it must be unit-tested
   before any real-call run.
3. Build transcript-style eval suites from known failure modes before deploying
   the completed implementation.
4. Run the full local validation bundle:
   - typecheck
   - unit tests
   - lint
   - format check
   - transcript evals
   - focused policy/side-effect tests
5. Deploy to a controlled real-call test window with explicit rollback criteria.
6. Review real calls, latency, transfers, unresolved calls, tool loops, and bad
   side effects before broadening traffic.

Real-call testing is the validation phase for the completed stateful
implementation, not the point where missing control-plane pieces are first
designed.

## Next Implementation Step

The next step is **validation plus controlled real-call testing**, not another
shadow-only slice. The local implementation is now active enough to test live
call behavior, but it still needs the local release gate and runbook before
traffic expands.

Release-gate checklist after the semantic reducer cutover:

1. **Pending-action creation and lifecycle**
   - Implemented locally for booking and shared side effects through
     reducer-confirmed state inside the final side-effect tools.
   - Covered locally for successful consumption, duplicate consumed no-ops, and
     invalidation when dependent state changes.

2. **Availability policy**
   - Implemented locally for duplicate search signatures, cached slot reuse,
     search budget, no-slot/rejected-slot/stale-slot/invalidated recovery, and
     booking error recovery.

3. **Intent/task split cleanup**
   - Implemented locally for appointment lookup, cancellation, reschedule, FAQ
     interruption/return, transfer request, and office routing separation.

4. **Patient-scoped state model**
   - Implemented locally for active patient registry, relationship to caller,
     per-patient identity/insurance/appointments/tasks, multi-patient switching,
     and return from interruptions.

5. **Canonical verification and correction handling**
   - Implemented locally for canonical patient state, caller-spelled name
     provenance, pre-call first-name confirmation, patient/visit/insurance
     invalidation, and active-patient tool-state sync.

6. **Booking and cancellation policy**
   - Implemented locally for active patient/current slot/routing/appointment
     type/source search/confirmation checks, stale-slot recovery,
     invalid-appointment-type recovery, loaded appointment requirements, and
     explicit cancellation confirmation.

7. **Structured tool outcomes**
   - Implemented locally for risky verification, insurance, registration,
     appointment lookup, booking, cancellation, note, office route, and transfer
     outcomes.

8. **Transcript eval harness**
   - Implemented locally for the current Phase 2/2.5 gate, including explicit
     semantic turn-understanding inputs instead of keyword-only transcript
     intent mutation.

9. **Real-call test runbook**
   - Next missing artifact: define test window, monitored numbers/offices,
     success metrics, stop conditions, rollback command, and post-test review
     checklist.

Pending-action lifecycle and transcript evals now pass locally. Before
real-call tests, run the full release gate and write down the controlled test
window, monitored numbers, stop conditions, and rollback command. During local
implementation, hard policies may be enabled only when they return safe
caller-facing outcomes and have focused tests.

Do not make the first enforced guard a broad workflow lock. The agent must still
be able to answer FAQs, switch patients, and accept corrections mid-flow.

## Immediate release decision

The previous immediate-release decision is superseded. Do not merge this branch
as only a shadow foundation if the goal is now to finish the full stateful
agent before real-call testing.

Immediate sequence:

1. Keep `feature/flow-controller-spine` as the full implementation branch.
2. Finish the pre-side-effect policy layer, availability policy, intent/task
   split, patient-scoped state, canonical corrections, pending actions,
   booking/cancellation policy, structured outcomes, evals, and the real-call
   runbook.
3. Run the full validation bundle locally.
4. Open one reviewable PR that clearly labels which parts are active policy,
   which are soft guards, and which are telemetry-only.
5. Deploy to a controlled real-call test window.
6. Review real-call traces before broad production traffic.

Any hard side-effect prevention must have tests and a safe caller-facing outcome
before it is enabled for real calls.

## Jarvis-level roadmap

The target is a stateful agent that can hold the caller's goal, active patient,
pending side effects, and recovery path across interruptions without becoming a
rigid workflow. The implementation should advance in these phases.

### Phase 1: full local control plane

Complete the stateful implementation before real-call testing.

Required local signals:

- `flow.currentState`
- `flow.activeIntent`
- `flow.guardObservations`
- semantic turn-understanding reducer state
- active patient reference
- patient registry with per-patient context
- active task/task stack state
- scheduling goal memory with preferred window and selected slot
- availability search counters and cached slots
- pending-action ledger with active and consumed actions
- booking/cancellation recovery state
- compact `<turn_state>` injection
- structured tool outcomes for risky tools

### Phase 2: local eval and validation suite

Build and pass the local validation layer before controlled real-call testing.

Status as of 2026-05-22: complete locally.

Required coverage:

- unit tests for state transitions and policy decisions
- transcript-style evals for known failure modes
- side-effect tests proving unsafe duplicate calls return safe no-op or
  `not_allowed` outcomes
- latency-sensitive checks around turn-state packet size
- regression tests for current successful scheduling/routing flows

Current green local coverage includes:

- pre-call appointments loaded from phone lookup state without requiring
  `confirm_appt` again
- first-name confirmation of a single pre-call matched patient
- explicit cancellation confirmation and loaded-appointment requirements
- past-appointment filtering before cancellation
- reschedule ordering that keeps cancellation gated while booking proceeds
- duplicate availability search blocking, cached alternatives, stale-slot
  recovery, invalid appointment-type recovery, and booking confirmation ledger
- multi-patient task scoping and patient-change invalidation
- FAQ suspend/resume during scheduling
- one-time scheduling transfer pushback plus transfer ledger/no-op/failure
  recovery
- patient-note timing after successful booking
- Spring Hill routine-vision routing confirmation
- compact `<turn_state>` packet privacy and size checks
- semantic turn-understanding reducer coverage for reschedule windows, negated
  cancellation, child-patient switching, stale-state invalidation, and schema
  parsing

### Phase 2.5: semantic reducer runtime cutover

Status as of 2026-05-22: implemented locally.

Runtime behavior:

- `src/agent.ts` stores the latest caller transcript and injects a requirement
  that the main LLM call `record_turn_understanding` before answering or using
  business tools.
- `src/tools.ts` exposes `record_turn_understanding`, validates the schema, runs
  the reducer, and returns the updated turn-state packet.
- Final `UserInputTranscribed` events reset STT profile only; they no longer
  update flow state with keyword intent logic.
- The reducer writes patient identity, relationship, visit type, coverage type,
  preferred window, selected slot, booking confirmation, note draft, and active
  intent from a typed schema.
- If state-update input is missing or invalid, workflow tools are blocked until
  `record_turn_understanding` runs. This includes appointment lookup, knowledge
  lookup, confirmation recorders, and side-effect tools. The runtime does not
  fall back to keyword intent mutation.

### Phase 3: controlled real-call test

Deploy only after the full local control plane and eval suite pass. Start with a
controlled real-call window, not broad production traffic.

Rank issues by:

- repeated `get_availability`
- duplicate availability signatures
- booking after stale slots
- verify loops
- insurance loops
- registration during existing-patient calls
- multi-patient confusion
- transfers after many tools

Review representative calls to separate real unsafe behavior from valid caller
changes. Stop or roll back if unresolved calls, transfers, latency, or bad side
effects rise.

### Phase 4: intent state

Add an intent controller that writes `activeIntent` before side-effecting tools
run.

Status as of 2026-05-22: implemented through the semantic reducer. The legacy
keyword classifier has been removed; tests and shadow prediction now use
structured `TurnUnderstanding` inputs instead of transcript keyword inference.

Intent state should classify:

- `new_appointment`
- `existing_appointment_confirm`
- `existing_appointment_cancel`
- `existing_appointment_reschedule`
- `insurance_question`
- `faq`
- `new_patient_registration`
- `transfer_request`
- `unclear`

Intent owns what the caller is trying to do. Flow step owns where the agent is
inside that task. Patient ref owns who the task is about.

Example target state:

```txt
activeIntent: insurance_question
activePatientRef: caller
activeFlow: insurance
step: triage_visit_type
nextAction: ask_medical_or_routine_vision
blockedActions: add_patient, get_availability, book_appt
```

### Phase 5: turn-state injection

Inject a compact state packet into each turn after the observed state is
trustworthy. The packet should guide the model without exposing the whole state
object.

Status as of 2026-05-22: implemented in `Agent.onUserTurnCompleted` after the
semantic reducer applies the current turn.

Target shape:

```xml
<turn_state>
intent: existing_appointment_confirm
activePatient: caller
patientStatus: matched_not_verified
task: appointment_management
step: verify_patient
visitType: unknown
scheduling: confirm collecting
office: spring-hill
nextAction: verify_or_load_appointment
blockedActions: add_patient, get_availability, book_appt
</turn_state>
```

Rules:

- Keep the base prompt stable for caching.
- Inject dynamic state later in context.
- Include `nextAction` and `blockedActions`.
- Do not inject raw transcripts or raw tool output.
- Keep it short enough for voice latency.

### Phase 6: first soft guard

Enable soft guards only after local tests pass and the controlled real-call test
has an explicit rollback path.

Likely first candidates:

- no duplicate same availability search signature
- no repeated availability search after budget exhaustion
- no booking against a stale or inactive slot
- no `add_patient` unless active intent is registration and state has explicit
  no-match/new-patient evidence

The first enforced guard should return a structured `not_allowed` or safe no-op
outcome, not throw an exception and not lock the full workflow.

### Phase 7: patient-scoped tasks

Make multi-patient calls first-class.

Each patient context should own:

- identity slots and provenance
- verification status
- insurance state
- loaded appointments
- active scheduling task
- availability search cache
- pending booking/cancel/add-patient actions

The agent must be able to suspend one patient's task, switch to another patient,
then return without mixing identity, insurance, availability, or booking state.

### Phase 8: pending action ledger

Every side effect should require a pending action with:

- patient ref
- action type
- spoken summary
- confirmation turn
- source state
- consumed flag
- invalidation reason

Applies to:

- `book_appt`
- `cancel_appt`
- `add_patient`
- `update_insurance`
- `transfer_call`
- office routing

This is what prevents duplicate booking, accidental registration, and
unconfirmed cancellations.

### Phase 9: availability policy

Availability becomes a controlled search instead of free-form tool repetition.

Required behavior:

- cache returned slots
- reuse cached slots before searching again
- dedupe same search signature
- enforce a search budget
- broaden after failed exact searches
- invalidate on patient, visit type, insurance, office, routing, provider,
  appointment type, or age-lane changes
- recover cleanly after stale-slot booking errors

### Phase 10: booking recovery

Booking state should track:

- selected slot
- source availability search
- appointment type id
- routing lane
- confirmation turn
- attempt count
- last error class

Recovery rules:

- Slot unavailable -> invalidate the slot and offer a cached alternative or
  rerun availability.
- Invalid appointment type -> invalidate appointment type/routing lane and
  recompute before retry.
- Duplicate booking against consumed action -> safe no-op.

### Phase 11: eval and review loop

Build evals from real calls, not imagined happy paths.

Suites:

- initial intent
- existing vs new patient
- insurance medical vs routine vision
- Crystal River routing
- spelling correction
- multi-patient switching
- availability loop prevention
- stale-slot booking
- cancellation confirmation
- FAQ interruption and return

Each suite should assert state, allowed tool, blocked tool, state patch, pending
action state, and spoken response category.

### Phase 12: prompt cleanup

Only after code owns the rules:

- remove duplicated business sequencing from prompt/runbook/tool prose
- keep the prompt focused on voice, language, concise behavior, and objective
- keep tool descriptions narrow and state-backed

The prompt should guide how the agent sounds. Code should own what is allowed.

### Phase 13: Jarvis-level completion criteria

Call the agent "Jarvis-level" only when these are true in live traces and evals:

- First-turn latency remains acceptable.
- The agent tracks current caller intent.
- The agent tracks the active patient.
- The agent can switch patients and return.
- Spelled and corrected facts override stale transcript guesses.
- The agent does not repeat tools blindly.
- Availability loops materially drop from the 1000-call baseline.
- Booking happens once against the current slot and current patient.
- Stale-slot booking errors trigger recovery, not repeated booking attempts.
- Side effects require confirmed pending actions.
- The model receives a small state packet each turn.
- Evals cover the major failure modes.
- Transfers and unresolved calls do not rise.

## Path to completion

1. **Full implementation branch**.
   - Keep `feature/flow-controller-spine` as the full Jarvis implementation
     branch.
   - Current completed base: flow state, intent state, turn-state injection,
     semantic turn-understanding state update/reduction, deterministic
     turn-router resolution, report-only guard observations, narrow policy
     enforcement, structured policy outcomes, availability search telemetry,
     booking confirmation actions, shared
     side-effect confirmation actions, and booking attempt telemetry.
   - Current patient-state slice: same-patient verification hydration no longer
     invalidates current availability, conflicting patient verification switches
     to a separate patient context, caller-spelled names keep authoritative
     provenance, relationship-to-caller is tracked on patient contexts, quick
     questions can suspend and return to the previous patient task, resumed
     patient tasks sync into real tool execution state, and real patient changes
     invalidate stale availability plus pending actions.
   - Do not split a deploy-only shadow foundation unless the rollout goal
     changes again.

2. **Tool policy layer**.
   - Put risky tools through shared policy before side effects.
   - Return allowed patches or structured `not_allowed`/safe no-op outcomes.
   - Applies to `verify_patient`, `check_insurance`, `add_patient`,
     `get_availability`, `book_appt`, `cancel_appt`, `update_insurance`,
     `route_to_spring_hill`, and `transfer_call`.
   - Current active policy blocks bare insurance checks before visit-type triage,
     availability before visit type, duplicate/exhausted availability,
     registration before insurance, cancellation before explicit confirmation or
     before a loaded appointment, insurance update before verification, and
     booking without a matching confirmed pending action.

3. **Availability policy**.
   - Reuse cached slots before another search.
   - Dedupe search signatures.
   - Enforce search budget and broaden/ask/transfer recovery.
   - Track no-slot, rejected-slot, stale-slot, exhausted, and invalidated states.

4. **Patient-scoped state and correction engine**.
   - Implemented base: patient registry, conflicting verification switches,
     same-patient hydration, per-patient insurance/appointment hydration,
     canonical slots, relationship-to-caller modeling, caller-spelled
     provenance, task suspend/return, and downstream invalidation on patient
     changes.
   - Remaining: broader correction invalidation for appointment, provider, and
     task ownership changes.

5. **Pending action ledger**.
   - Create confirmed pending actions before side-effect tools run.
   - Consume successful actions and return no-op for duplicate consumed actions.
   - Cancel or rebuild actions on patient, visit type, office, insurance,
     routing, slot, appointment, or relationship changes.

6. **Booking and cancellation recovery**.
   - Booking must match active patient, selected slot, appointment type, routing
     lane, source search, and confirmation.
   - Current behavior rejects slot-unavailable errors, keeps cached alternatives
     when available, invalidates stale/invalid appointment-type lanes, and
     returns structured recovery outcomes.
   - Cancellation requires a loaded appointment and explicit confirmation,
     consumes successful or already-cancelled actions, removes cancelled
     appointments from patient state, resumes a suspended prior task when present,
     and returns structured retry outcomes on not-found/provider failures.

7. **Structured tool outcomes**.
   - Normalize risky tool outputs into `ToolOutcome`.
   - Store full state internally.
   - Return concise model-facing summaries.
   - Current normalized risky outputs: verification success/not-found,
     insurance checks and route-required outcomes, registration success/failure,
     insurance update success/failure, appointment lookup
     success/not-found/failure, booking success/recovery/failure, cancellation
     success/recovery/failure, patient note save outcomes, office routing, and
     transfer success/failure.

8. **Prompt and tool prose cleanup**.
   - Remove business sequencing from prompt/runbook/tool prose only after code
     owns it.
   - Keep voice, tone, language switching, and current objective in the prompt.

9. **Transcript eval harness**.
   - Cover new appointment, existing appointment, cancellation, reschedule,
     insurance medical/routine, Crystal River routing, registration,
     multi-patient, caller corrections, availability loops, stale-slot booking,
     cancellation confirmation, FAQ interruption, and transfer recovery.
   - Assert state, allowed/blocked tool, state patch, pending action,
     availability cache, and spoken category.
   - Started with a thin replay harness seeded from pre-call state and mocked
     tool outcomes. The harness treats pre-call appointments as loaded state, so
     skipped `confirm_appt` is valid when the active patient did not change; the
     hard safety gates are loaded appointment state plus explicit pending
     cancellation confirmation.
   - Current status: Phase 2 coverage is complete for the local gate, including
     pre-call first-name verification, reschedule ordering, patient-note timing,
     duplicate transfer/cancellation no-ops, transfer failure recovery, and
     compact turn-state privacy/size assertions. Phase 2.5 adds semantic
     reducer coverage so the harness no longer depends on keyword-only intent
     mutation.

10. **Local release gate**.
    - `pnpm exec tsc --noEmit`.
    - `pnpm test`.
    - `pnpm exec eslint .`.
    - `pnpm run format:check`.
    - Transcript evals.
    - Focused side-effect/policy tests.
    - `git diff --check`.

11. **Real-call test runbook**.
    - Define test window, offices/numbers, operator expectations, monitored
      dashboards/log commands, success metrics, stop conditions, rollback
      command, and post-call review checklist.

12. **Controlled real-call test**.
    - Deploy the completed implementation only after the local gate passes.
    - Review every test call at first, then a 100-300 call sample.
    - Stop or roll back on bad side effects, latency regression, transfer spike,
      unresolved-call spike, or wrong-office/routing failures.

13. **Production promotion**.
    - Promote only after real-call evidence shows fewer repeated availability
      loops, no increase in transfers/unresolved calls, no bad bookings or
      cancellations, and acceptable latency.

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
