# Canonical Call State Spec

Status: implemented in this branch.

Owner branch: `codex/canonical-call-state-spec`.

## Goal

Make the agent harness stateful with one clear source of truth and no duplicated
writable domain state.

The current harness already uses `session.userData.flow` for workflow decisions,
planner state, turn-state injection, and dynamic tool exposure. The remaining
cleanup is to stop also storing the same patient, appointment, insurance, and
routing facts as top-level `CallState` fields.

Target mental model:

```txt
flow tells us what is true in the call
planner decides what should happen next from flow
context tells the LLM only what it needs from flow
tools act using flow plus private backend handles
runtime records what happened
```

## First Principles

Every fact must have exactly one canonical home.

```txt
If the LLM can reason from it, it belongs in flow.
If only tools need it to execute, it belongs in private.
If it is operational bookkeeping, it belongs in runtime.
```

The LLM does not own state. Tool bodies do not own state. Session mirror fields
do not own state. Durable call state changes through reducer events.

## Target Shape

`CallState` should become a small session envelope:

```ts
interface CallState {
  flow: CallFlowState;
  private: PrivateToolState;
  runtime: RuntimeCallState;
}
```

These are grouping boundaries, not three competing state models. A fact still has
one canonical owner inside one group.

### `flow`

Canonical call and workflow state. This is the only durable state used by:

- planner commands
- turn-state context
- tool exposure
- tool guards
- user-facing workflow decisions

Examples:

- active patient
- patient identity and verification status
- public appointments and appointment load status
- insurance plan meaning and coverage type
- routing decision
- active office
- scheduling goal
- public availability searches and speakable slot summaries
- appointment-management task state
- pending confirmations and pending actions
- current task, task stack, and active intent

### `private`

Backend-only execution handles. These must not be exposed to the LLM unless a
tool intentionally returns a safe public summary.

Examples:

- AdvancedMD `insPlanId`
- AdvancedMD `respPartyId`
- appointment cancel tokens
- availability booking tokens
- raw middleware-only appointment data
- raw middleware-only availability data

This data is canonical for backend execution only. It should be keyed by stable
flow references such as `patientRef`, `slotId`, or `appointmentId`.

Private state must not duplicate public identity facts that already live in
`flow`. If a tool needs the active `patientId`, a selector should read it from
`flow`, not from `private`.

### `runtime`

Operational harness bookkeeping. Runtime state can affect orchestration, but it
does not define patient, appointment, insurance, or workflow truth.

Examples:

- latest user transcript
- transcript already applied flag
- latest tool exposure telemetry
- tool execution history
- STT profile
- flow guard observations
- pre-call lookup telemetry
- original caller phone and trunk phone
- SIP room and participant metadata
- transfer in-flight flags

## Current Problem

The current implementation is flow-led but still hybrid.

`CallState` contains `flow`, but also top-level domain mirrors:

```ts
patientId
patientName
dob
insuranceCarrier
checkedInsurancePlan
checkedInsuranceCoverageType
routing
appointments
appointmentsStatus
lastAvailabilityRouting
lastAvailabilitySlots
bookableAvailabilitySlots
availabilitySlotSequence
officeKey
amdOfficePhone
```

Some tool helpers write both places. For example, patient payload application
records the patient into `flow` and then directly assigns top-level session
fields. Appointment helpers also update top-level appointments and then emit
flow events.

This creates two risks:

1. Drift: `flow` and top-level fields can disagree after a partial update.
2. Ambiguity: future code has to guess whether `flow` or `CallState` is the
   real source for a fact.

The goal is not to delete useful runtime metadata. The goal is to delete
duplicated writable domain state.

Active office is part of call meaning and belongs in `flow`. Original caller
phone, original trunk phone, SIP identifiers, and call id are runtime metadata.
Backend office phone should be derived from active office configuration unless a
tool boundary explicitly needs a private override.

## Non-Goals

- Do not rewrite unrelated harness subsystems beyond this state migration.
- Do not change external middleware contracts unless unavoidable.
- Do not expose backend-only tokens or IDs to the LLM.
- Do not collapse every concern into one giant `flow` object.
- Do not keep a compatibility bridge as the permanent architecture.
- Do not change dynamic tool loading or phase-based tool exposure in this build.
- Do not remove reducer events, planner commands, pending actions, or tool
  guards.
- Do not make the LLM choose implementation states.

## Invariants

These invariants should be true after the migration.

1. Domain reads go through selectors.
2. Domain writes go through reducer events.
3. Private backend handles live under `state.private`.
4. Runtime orchestration fields live under `state.runtime`.
5. No tool directly writes top-level patient, appointment, insurance, or routing
   mirrors.
6. `compileTurnStatePacket()` reads only from `flow`.
7. Dynamic tool exposure behavior is not changed in this build.
8. Side-effect guards validate against `flow` and retrieve execution handles
   from `private`.
9. Public availability searches and selected slot summaries live in `flow`;
   booking tokens and raw slot payloads live in `private`.
10. Active office lives in `flow`; original call metadata lives in `runtime`.
11. Any temporary bridge is one-way from canonical state to legacy fields.
12. A test should fail if legacy domain mirror writes are reintroduced.

## Selectors

Before removing fields, add selectors so tools do not need to know the internal
shape of `flow` or `private`.

Recommended selector groups:

```ts
getActivePatient(state)
getActivePatientId(state)
getActivePatientDob(state)
getActiveAppointments(state)
getAppointmentById(state, appointmentId)
getInsuranceContext(state)
getRoutingContext(state)
getSchedulingContext(state)
getActiveOffice(state)
getSelectedAvailabilitySlot(state)
getPatientBackendRefs(state, patientRef)
getAppointmentCancelToken(state, appointmentId)
getAvailabilityBookingToken(state, slotId)
```

Selector rules:

- A selector returns one canonical answer.
- A selector must not mutate state.
- A selector must prefer `flow` for public/domain facts.
- A selector must use `private` only for backend execution handles.
- A selector should make missing-state behavior explicit with `null`, a typed
  result, or a guard error.

Temporary migration rule:

- During Step 1 and Step 2, selectors may fall back to legacy fields only when
  the canonical container has not been populated yet.
- Every fallback must be local to the selector layer.
- Tool bodies must not implement their own fallback logic.
- Each fallback must be deleted in Step 5.

## Reducer Events

Existing reducer events should remain the public write path. Add new events only
where the current event set cannot express a needed fact clearly.

Likely needed or audited events:

- `patient_recorded`
- `patient_payload_applied`
- `active_patient_appointments_recorded`
- `active_patient_appointment_removed`
- `insurance_updated`
- `routing_resolved`
- `availability_recorded`
- `availability_slot_selected`
- `booking_attempt_recorded`
- `booking_completed`
- `cancel_completed`
- `office_routed`

Reducer rules:

- Tool results are converted into flow events.
- Tool results may also update `private` handles.
- Tool bodies do not patch flow fields directly.
- Event names should describe facts, not UI steps.

## Private Tool State

Suggested shape:

```ts
interface PrivateToolState {
  patients: Record<
    PatientRef,
    {
      insPlanId?: string | null;
      respPartyId?: string | null;
      raw?: unknown;
    }
  >;
  appointments: Record<
    string,
    {
      patientRef?: string;
      appointmentId: number;
      cancelToken?: string;
      raw?: unknown;
    }
  >;
  availability: {
    slots: Record<
      string,
      {
        bookingToken?: string;
        raw?: unknown;
      }
    >;
  };
}
```

The exact type can be narrower during implementation. The important rule is
that backend handles do not live as duplicated top-level domain fields and do not
mirror public facts already owned by `flow`.

## Implementation Plan

This will be implemented in one coordinated pass, not split across multiple
feature branches or PRs. The steps below are still the execution order inside
that pass, because each step reduces risk before the next one removes legacy
state.

### Step 1: Add Shape And Selectors

- Introduce `state.private` and `state.runtime` while keeping old fields.
- Add selectors for patient, appointment, insurance, routing, and backend
  handles.
- Populate new canonical containers where doing so is obviously mechanical, and
  use selector-local legacy fallback where writes have not migrated yet.
- Keep existing behavior unchanged.
- Add tests proving selectors return the same facts currently used by tools.

Exit criteria:

- No behavior change.
- Typecheck and focused flow/tool tests pass.
- New code can read canonical state through selectors.
- Any legacy fallback is isolated inside selectors and named as temporary.

### Step 2: Move Tool Reads

- Replace direct reads of legacy top-level fields in tools with selectors.
- Start with patient identity and appointments.
- Then migrate insurance, routing, availability, booking, and cancellation.
- Keep old fields temporarily synchronized for compatibility.

Exit criteria:

- Tool bodies no longer need direct reads of `state.patientId`,
  `state.appointments`, `state.checkedInsurancePlan`, `state.routing`,
  `state.lastAvailabilitySlots`, or `state.officeKey`.
- Existing tests still pass.

### Step 3: Move Tool Writes

- Replace direct writes to duplicated top-level fields with reducer events.
- Update private backend handles through explicit private-state helpers.
- Keep one temporary compatibility sync helper only if old fields still exist.

Allowed temporary bridge:

```ts
syncLegacyCallStateFromCanonicalState(state)
```

Bridge rule:

- Only the bridge may write legacy domain mirrors.
- Tool bodies may not write them directly.
- The bridge must never read legacy fields to repair or backfill `flow`.

Exit criteria:

- A search for direct writes to legacy domain fields finds only the bridge.
- Reducer events own public/domain state changes.
- Private helpers own backend handles.

### Step 4: Tighten Context Around Planner Args

- Ensure turn-state context includes planner command args when safe and useful.
- Keep private backend handles out of model context.
- Verify side-effect tools validate against `flow` and retrieve execution data from
  `private`.
- Do not change dynamic tool loading or make tools phase-scoped in this build.

Exit criteria:

- Context is compiled from `flow`.
- Side-effect execution uses `flow` plus `private`, not legacy mirrors.
- Dynamic tool loading behavior remains unchanged.

### Step 5: Delete Legacy Domain Mirrors

- Remove duplicated top-level fields from `CallState`.
- Remove the compatibility bridge.
- Delete tests that only exist for legacy mirror behavior.
- Add regression tests that assert no top-level domain mirrors return.

Exit criteria:

- `CallState` contains only `flow`, `private`, and `runtime` groups.
- No direct references remain for removed fields.
- Broad typecheck and test suite pass.

## Single-Pass Work Order

Complete these in one branch before merging:

1. Add canonical state containers and selectors.
2. Migrate patient identity and appointment reads.
3. Migrate appointment writes and cancel-token private state.
4. Migrate insurance, routing, and AdvancedMD backend refs.
5. Migrate availability, booking, and scheduling side-effect reads.
6. Migrate active office changes and immutable call metadata.
7. Tighten context around safe planner args.
8. Delete legacy domain mirrors and selector fallbacks.
9. Add no-regression checks for removed mirrors and private-token isolation.

Do not leave the branch in a half-migrated architecture where legacy domain
mirrors remain as a long-term compatibility path.

## Highest-Risk Areas

### Cancellation

Cancellation needs both public appointment state and private cancel tokens. The
public appointment belongs in `flow`; the cancel token belongs in `private`.

Migration must preserve:

- preloaded appointment cancellation
- token refresh
- appointment removal after successful cancellation
- explicit confirmation guard behavior

### Booking And Rescheduling

Booking needs public selected-slot state, appointment metadata, and backend
booking handles. Rescheduling must keep the replacement booking and old
cancellation ledger coherent.

Migration must preserve:

- selected slot tracking
- booking confirmation guard
- appointment note payload facts
- replacement-before-old-cancel behavior for reschedules

### Insurance Update

Insurance update needs public insurance meaning plus private AMD IDs.

Migration must preserve:

- `insPlanId`
- `respPartyId`
- coverage-type classification
- routine-vision routing behavior
- preauthorization behavior

## Testing Requirements

Each step should include focused tests before broad cleanup.

Minimum focused suites:

- flow controller tests
- tool exposure tests
- tool interruption tests
- agent session flow tests
- appointment/cancellation tests
- insurance update tests
- transcript eval harness tests where applicable

Add no-regression tests for:

- pre-call single match can proceed without re-verification
- pre-call multiple match can select a loaded candidate
- cancellation can use a preloaded appointment plus explicit confirmation
- booking records the new appointment in `flow`
- booking can use a private booking token without exposing it in turn-state
  context
- insurance update stores public coverage in `flow` and backend refs in
  `private`
- active office routing updates `flow` without leaving stale top-level office
  mirrors
- removed top-level domain fields are not reintroduced

## Done Definition

The migration is done when this is true:

```txt
Call meaning lives in flow.
Backend execution handles live in private.
Harness bookkeeping lives in runtime.
No duplicated writable domain fields remain.
All domain reads go through selectors.
All domain writes go through reducer events.
```

The resulting code should make the answer to "where is the state?" boring:

```txt
state.flow
```

And the answer to "where are backend tokens and IDs?" equally boring:

```txt
state.private
```
