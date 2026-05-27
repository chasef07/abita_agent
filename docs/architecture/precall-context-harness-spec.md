# Pre-Call Context Harness Spec

Status: target implementation spec.

This spec defines how pre-call phone lookup data becomes harness-owned state and
model-visible context. The goal is to stop relying on prompt prose for patient
identity and appointment state.

## Problem

The current pre-call path already fetches useful patient data before the LiveKit
session starts:

```txt
SIP participant
  -> loadPreCallBootstrap(callerPhone, trunkPhone)
  -> lookupByPhone()
  -> POST /api/patient/resolve { phone }
  -> buildPrompt(phoneLookup)
  -> createInitialFlowState(...)
```

This data reaches the model in two different forms:

1. Static prompt context from `buildCallerContext()`.
2. Runtime state in `session.userData.flow`.

That split causes inconsistent behavior. The model may see prompt text such as
"single match, ask for first name, then skip verify_patient", while the latest
injected turn state still says `matched_not_verified`. Multiple matches are even
weaker: they are mostly prompt text, not durable patient candidates in state.

The fix is to make the harness own pre-call identity resolution, patient
candidate narrowing, appointment load status, and the compact context shown to
the model.

## Goals

- Treat pre-call lookup as structured harness state, not workflow instructions in
  prompt prose.
- Make the active patient status deterministic before the planner chooses tools.
- Support single match, multiple matches, no match, and lookup failure.
- Let first-name confirmation promote a preloaded single match to verified
  without calling `verify_patient`.
- Let first-name selection narrow multiple phone matches before asking for last
  name or DOB.
- Preserve loaded appointments and appointment load status across turns.
- Keep patient IDs, cancel tokens, and raw middleware payloads hidden from model
  text unless a tool schema explicitly requires an internal ID.
- Make the latest `<turn_state>` the reliable source of truth for the model.

## Non-Goals

- Do not add a broad patient-router tool.
- Do not expose raw pre-call lookup JSON to the model.
- Do not let prompt text override harness state.
- Do not call `verify_patient` just to refresh appointments when the active
  patient already has fresh pre-call appointments.
- Do not treat a lookup failure as a new patient.

## State Model

Add explicit pre-call identity state under `CallFlowState`.

```ts
type PreCallIdentityStatus =
  | "not_attempted"
  | "single_match_pending_confirmation"
  | "single_match_confirmed"
  | "multiple_matches_pending_selection"
  | "multiple_match_selected_pending_verification"
  | "multiple_match_confirmed"
  | "no_match"
  | "lookup_failed";

interface PreCallContextState {
  status: PreCallIdentityStatus;
  source: "phone_lookup";
  callerPhone: string;
  lookupDurationMs?: number;
  failureReason?: string;
  retryable?: boolean;
  candidates: PreCallPatientCandidate[];
  selectedCandidateRef?: PatientRef;
  appointmentLoadStatus?: AppointmentLoadStatus;
  appointmentMessage?: string;
}

interface PreCallPatientCandidate {
  ref: PatientRef;
  firstName?: string;
  lastName?: string;
  dob?: string;
  patientId?: string;
  relationshipToCaller?: PatientRelationshipToCaller;
  appointments: CallerAppointment[];
  appointmentsStatus?: AppointmentLoadStatus;
}
```

`PatientContext.source` should continue to mark values from phone lookup as
`phone_lookup`, but `preCall` is the workflow authority for whether those values
are confirmed.

For model-visible context, preloaded identity slots are `known` until the
first-name challenge succeeds. After promotion they become `confirmed`. This
avoids a mixed packet that says `matched_not_verified` while also showing
`firstName=confirmed` or `dob=confirmed`.

## Lookup Outcome Contract

### Single Match

Middleware returns one verified patient.

Harness state:

- `preCall.status = "single_match_pending_confirmation"`.
- `flow.patientStatus = "matched"`.
- `flow.activePatientRef = "caller"`.
- `flow.patients.caller` contains patient ID, name slots, DOB, phone,
  appointments, and `appointmentsStatus`.

Model-visible context:

```txt
preCall: single phone match; ask caller for first name only.
patient: caller matched_not_verified; firstName=known; dob=known; relationship=self
appointments: loaded=1
next: ask patient first name before patient-specific side effects
```

Promotion rule:

When the caller says the expected first name, the harness immediately promotes:

- `preCall.status = "single_match_confirmed"`.
- `flow.patientStatus = "verified"`.
- `flow.patients.caller.status = "verified"`.
- first name, last name, and DOB slots become confirmed.

No `verify_patient` call is needed.

### Multiple Matches

Middleware returns multiple patients on the phone number.

Harness state:

- `preCall.status = "multiple_matches_pending_selection"`.
- `flow.patientStatus = "unknown"` until a candidate is selected.
- `preCall.candidates` contains one safe candidate per returned match.
- Candidate state should include only fields that middleware safely returns for
  narrowing. If only first names are available, store only first names.

Model-visible context:

```txt
preCall: multiple phone matches; ask patient first name only.
candidateFirstNames: 3 available; do not read names aloud.
next: ask "can I get the patient's first name?"
blockedSideEffects: add_patient, get_availability, book_appt, cancel_appt
```

Selection rule:

When the caller gives a first name:

- If it uniquely matches one candidate with enough identity data, set that
  candidate active and either verify locally or call `verify_patient` with the
  selected first name. The wrapper loads caller phone from session state.
- If it matches multiple candidates, ask for last name or DOB.
- If it matches none, ask for last name and DOB, then use `verify_patient`.
- After `verify_patient` succeeds for the selected candidate, set
  `preCall.status = "multiple_match_confirmed"` so the planner stops asking for
  another verification step.

### No Match

Middleware returns no patient for the phone.

Harness state:

- `preCall.status = "no_match"`.
- `flow.patientStatus = "unknown"`.
- No candidate is created.

Model-visible context:

```txt
preCall: no phone match.
next: ask whether caller has been seen here before.
```

If the caller says they are new, proceed through new-patient triage. If they say
they are existing, collect first name, last name, and DOB before
`verify_patient`.

### Lookup Failed

Middleware, network, auth, or invalid response failure.

Harness state:

- `preCall.status = "lookup_failed"`.
- `preCall.failureReason` is stored for telemetry.
- `flow.patientStatus = "unknown"`.

Model-visible context:

```txt
preCall: lookup unavailable; do not assume new patient.
next: ask what they need; verify normally if they are existing.
```

## Turn Processing Order

Every caller turn must run in this order:

1. Store latest transcript.
2. Apply deterministic pre-call identity reducer.
3. Apply obvious intent reducer or require `record_turn_understanding`.
4. Recompute planner command.
5. Inject `<turn_state>` and `<context_capsules>`.
6. Refresh visible tools from planner-owned `allowedTools`.

The deterministic pre-call reducer must run even when intent inference is
unclear. A plain answer like "Maria" can be enough to confirm or select a
pre-call patient even if it does not express scheduling intent.

## Context Injection Contract

The model should not need to reconcile static prompt prose with hidden state.
After startup and every caller turn, the injected state packet must include a
compact pre-call capsule when relevant:

```txt
<turn_state>
task: ...
patient: caller verified
preCall: single_match_confirmed
known: patient first name confirmed; DOB confirmed; appointments loaded=1
missing: visit reason
next: ask visit reason
suggestedTool: none
blockedSideEffects: book_appt until availability and confirmation
</turn_state>

<context_capsules>
patient: caller verified; firstName=confirmed; dob=confirmed; relationship=self
preCall: confirmed from phone lookup first-name challenge
appointments: loaded=1; next appointment Tue Apr 8 9:30 AM Dr. Noel Spring Hill
</context_capsules>
```

For multiple matches:

```txt
preCall: multiple_matches_pending_selection; ask first name only; do not read candidate names.
```

After selected-candidate verification:

```txt
preCall: multiple_match_confirmed
```

For lookup failure:

```txt
preCall: lookup_failed; identity not preloaded; do not assume new patient.
```

## Appointment State Rules

Pre-call appointments are loaded state when all of these are true:

- They belong to the active patient ref.
- They are upcoming after date filtering.
- `appointmentsStatus = "found"` or appointments length is greater than zero.

The planner must treat that as satisfying appointment lookup for confirm,
cancel, and reschedule tasks. It should not ask the model to call
`verify_patient` only to load appointments again.

If `appointmentsStatus = "none"`, appointment-management tasks should respond
with no upcoming appointments unless the caller changes patient or explicitly
asks to retry.

If `appointmentsStatus = "error"`, appointment-management tasks should treat
lookup as unavailable for the current branch and offer scheduling or transfer,
not loop verification.

## Planner Rules

The planner owns the next safe action:

- `single_match_pending_confirmation` blocks patient-specific side effects until
  first-name confirmation.
- `single_match_confirmed` satisfies patient identity.
- `multiple_matches_pending_selection` allows only asking for first name or
  `verify_patient` with the selected first name when the caller provided a
  unique candidate first name. The wrapper loads caller phone from state.
- `multiple_match_confirmed` satisfies patient identity after the selected
  candidate verifies.
- `no_match` should not open `add_patient` until the caller says they are new or
  verification fails with full identity.
- `lookup_failed` should use normal verification paths and never infer new
  patient status.

Keep the broad workflow tool set visible. `WorkflowCommand.allowedTools` is
planner guidance and telemetry, not a hard tool-exposure boundary. Wrapper
guards remain the final authority for concrete prerequisites and side-effect
safety.

## Static Prompt Role

The static prompt may still mention pre-call behavior at a high level, but it
must not be the authority. It should say:

```txt
Use the latest turn_state for pre-call identity status. Do not infer whether a
preloaded patient is verified from the static caller context alone.
```

Detailed instructions such as "ask first name only" belong in the injected state
packet and planner command.

## Telemetry

Log these fields without raw PHI:

- `preCall.status`
- `preCall.candidateCount`
- `preCall.appointmentsStatus`
- `preCall.identityPromotion`: `none | first_name_confirmed | candidate_selected | verify_patient_required`
- `planner.taskKind`
- `planner.phase`
- `planner.allowedTools`
- guard reason when a model tries a blocked patient-specific side effect

Do not log patient ID, DOB, cancel token, raw transcript, or raw appointment
payload.

## Test Matrix

Minimum tests for implementation:

1. Single pre-call match starts as `matched_not_verified`.
2. Caller says expected first name; harness promotes to verified without
   `verify_patient`.
3. Caller says nonmatching first name; harness switches to normal verification
   for a different patient.
4. Multiple matches ask for first name only.
5. Multiple matches with unique first name call/select the matching patient path.
6. Multiple matches with duplicate first name ask for DOB or last name.
7. No-match caller who says new proceeds to registration triage.
8. No-match caller who says existing collects full identity before
   `verify_patient`.
9. Lookup failure does not become new-patient state.
10. Pre-call appointments satisfy confirm appointment lookup.
11. Pre-call appointments satisfy cancel/reschedule lookup but still require
    explicit side-effect confirmation.
12. `appointmentsStatus = "none"` returns no upcoming appointments without a
    retry loop.
13. `appointmentsStatus = "error"` returns lookup-unavailable guidance without a
    retry loop.
14. Patient switch invalidates active appointment, availability, and pending
    side-effect state for the previous patient.
15. Injected `<turn_state>` includes the active pre-call status and does not rely
    on static prompt-only instructions.

## Implementation Slices

### Slice 1: Single Match Hardening

- Add `preCall` state for single match, no match, and lookup failed.
- Run deterministic first-name confirmation before intent inference.
- Add pre-call capsule to `compileTurnStatePacket`.
- Add tests for single match, no match, lookup failed, and appointment loaded
  status.

### Slice 2: Multiple Match State

- Store multiple-match candidates in harness state.
- Add first-name selection and ambiguous-name handling.
- Add injected context that asks first name only without reading names aloud.
- Add tests for unique, duplicate, and no candidate matches.

### Slice 3: Planner Guidance And Telemetry

- Keep broad harness tool exposure.
- Emit `WorkflowCommand.allowedTools` in planner context and telemetry.
- Keep wrapper guards as final authority.
- Add telemetry for allowed-tools mismatch and blocked side effects.

### Slice 4: Prompt Cleanup

- Remove detailed pre-call workflow rules from static caller context.
- Keep only data summaries and a reminder that `<turn_state>` is authoritative.
