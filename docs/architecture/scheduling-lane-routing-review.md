# Scheduling Lane And Routing Review

## Goal

Keep scheduling lane selection simple and deterministic:

- New patient: triage the reason for visit before registration, insurance, or availability.
- Existing patient, new appointment: verify identity, ask why they are being seen, then route from the reason.
- Existing patient, reschedule: verify/select the existing appointment, then re-triage the replacement appointment lane.

The model should not choose routing from stale patient routing alone. The system should resolve one lane, then keep availability and booking on that lane.

## Desired Behavior

### Shared Scheduling Rule

Every scheduling path should resolve the scheduling lane before scheduling-side `check_insurance`, `add_patient`, `get_availability`, or `book_appt`.

The lane options stay simple:

- `routine_vision`: routine eye exam, glasses prescription, or contacts
- `medical`: symptoms, referral, follow-up, surgery/post-op, glaucoma, cataract, retina, or other medical eye care
- ambiguous: generic "checkup", "exam", "appointment", "vision", or unclear speech

Ambiguous reasons get one clarifying question: "Is this for a routine eye exam or glasses, or is there a medical eye concern?"

### New Patient

1. Ask what the patient needs to be seen for before checking availability.
2. Resolve one lane:
   - routine eye exam, glasses, or contacts -> `routine_vision`
   - symptoms, referral, follow-up, surgery/post-op, glaucoma, cataract, retina, or medical issue -> `medical`
   - generic "checkup", "exam", "appointment", or "vision" -> ask one clarifying question
3. Continue the lane-specific path:
   - routine vision -> collect vision coverage or self-pay only if needed for booking/registration
   - medical -> check medical insurance/routing before registration/availability
4. Register the new patient only after the lane and required coverage path are known.
5. Search availability and book only after the lane is known.

### Existing Patient, New Appointment

1. Verify the patient first if they are not already verified.
2. Ask why they are being seen / what kind of appointment they need unless the lane is already clearly grounded in the current caller request.
3. Resolve lane from the reason:
   - routine eye exam, glasses, or contacts -> `routine_vision` / `optical_only`
   - symptoms, referral, follow-up, surgery/post-op, glaucoma, cataract, retina, or medical issue -> `medical`
   - generic "checkup", "exam", "appointment", or "vision" -> ask one clarifying question
4. For routine vision:
   - do not run a top-level medical insurance check just to schedule
   - use optical/routine availability
   - book as routine vision
5. For medical:
   - check insurance on file or run the current medical insurance/routing check
   - use that routing to pick the correct doctor/provider set
   - book as medical
6. Stored routing such as `bach_only` or `all_three` may help after the lane is known, but must not decide the lane by itself.

### Existing Patient, Reschedule

Chosen policy for now: re-triage the replacement appointment.

1. Verify the patient first if they are not already verified.
2. Identify which existing appointment they want to move.
3. Ask/confirm what the replacement appointment is for unless the current caller request already makes the lane clear.
4. Resolve lane from that current reason:
   - routine eye exam, glasses, or contacts -> `routine_vision` / `optical_only`
   - symptoms, referral, follow-up, surgery/post-op, glaucoma, cataract, retina, or medical issue -> `medical`
   - generic "checkup", "exam", "appointment", or "vision" -> ask one clarifying question
5. For routine vision:
   - search optical/routine availability
   - book the replacement with the correct optical provider/routing
   - cancel the old appointment only after the replacement is booked
6. For medical:
   - check insurance on file or run the current medical insurance/routing check
   - use the resulting medical routing to pick the correct doctor/provider set
   - book the replacement, then cancel the old appointment

The old appointment does not decide the replacement lane. It is used to know what to cancel after replacement booking succeeds.

The tradeoff is that this can change the lane from the original appointment. That is acceptable for now because it gives existing-patient booking and reschedule one shared lane decision and avoids relying on weak appointment text labels.

## What Works Well Now

- New scheduling already has a triage frontier. If no visit type is classified, `prepareSchedulingPath` returns `triage_visit_type` and asks for the visit reason before insurance or scheduling. See `src/flow/scheduling.ts:176` and `src/flow/plans/scheduling.ts:173`.
- New-patient intent starts in `triage_visit_type` when no visit context is known. See `src/flow/intent.ts:78`.
- Routine vision is normalized to `coverageType: routine_vision` and `routing: optical_only` in the scheduling path. See `src/flow/scheduling.ts:198`.
- Existing patient scheduling can use insurance on file only when the stored coverage type matches the derived visit coverage. This helps avoid using medical insurance as routine vision coverage. See `src/flow/plans/scheduling.ts:51` and `src/flow/plans/scheduling.ts:877`.
- `check_insurance` already supports separate `medical` and `routine_vision` coverage checks and stores the checked coverage type. See `src/tools.ts:2253`.
- `get_availability` has a narrow model-facing contract: the model supplies the date, while routing and patient context come from session state. See `src/tools.ts:1756` and `src/tools.ts:967`.
- Availability slots store internal booking metadata, including `bookingToken`, `columnId`, `profileId`, `duration`, and routing. See `src/tooling/availability-slots.ts:132`.
- `book_appt` sends the booking token, patient ID, appointment reason, referring doctor, inferred appointment intent, and routing if present. Middleware resolves numeric appointment types. See `src/tools.ts:2001` and `src/tools.ts:2133`.
- Reschedule already has a real task plan: verify/load appointments, select old appointment, collect replacement window, search availability, confirm, book replacement, then cancel the old appointment. See `src/flow/plans/appointment/reschedule.ts:44`.
- Existing-patient booking and reschedule are currently separate planner paths. New booking goes through `planScheduling`; reschedule short-circuits to `planReschedule`. See `src/flow/plans/task-planner.ts:22`.

## What Happens Today In The Bad Example

The example completed successfully, but the sequence was inefficient and fragile:

1. Caller said this was a first visit.
2. The agent collected full registration demographics.
3. The agent collected insurance and called `check_insurance` without coverage type, which defaulted to medical.
4. The agent attempted `add_patient`; the guard blocked once because insurance was not checked in the expected state.
5. The agent checked Aetna as medical, then created the patient with medical routing (`bach_only`).
6. Only after registration did the agent ask the visit reason.
7. Caller clarified routine/eye exam.
8. The agent rechecked Aetna as routine vision, got EyeMed, searched `optical_only`, and booked a routine vision appointment.

The issue is not the final booking. The issue is that registration and medical insurance/routing happened before the scheduling lane was known.

Why it happened:

- The runbook says triage happens before availability, not before registration or insurance. See `workspace/FLOW_HARNESS_RUNBOOK.md:19`.
- The no-match prompt says if the caller needs a new chart, continue registration. It does not force visit reason first. See `src/prompt.ts:234`.
- `check_insurance` says unknown coverage defaults to medical. See `src/tools.ts:2256`.
- The guard allows `check_insurance` before visit type or coverage type is known. See `src/__tests__/flow-guards.test.ts:307`.
- `add_patient` is blocked only until some insurance has been checked, not until lane has been resolved. See `src/flow/guards.ts:150`.
- `add_patient` guidance emphasizes "Run check_insurance first," which can override the weaker triage guidance. See `src/tools.ts:1554`.

## What Needs To Change

### 1. Make Lane Resolution The First Scheduling Gate

Create one internal lane resolver used by availability and booking.

For any scheduling task, the first gate is:

- do we know `routine_vision` vs `medical`?
- if not, ask the clarifying question

Once the lane is resolved:

- `routine_vision` always forces `optical_only`
- `medical` never reuses optical routing
- no scheduling-side `check_insurance`, `add_patient`, `get_availability`, or `book_appt` should proceed while lane is unknown

### 2. Do Not Trust Model-Supplied Visit Type For Ambiguous Reasons

Today `prepareSchedulingPath` uses `input.visitType ?? classifyVisitType(input.visitReason)`. If the model labels "general checkup" as `medical`, the deterministic classifier never keeps it ambiguous. See `src/flow/scheduling.ts:179`.

Change the flow so generic reasons like "checkup", "general checkup", "exam", "appointment", and bare "vision" require clarification unless paired with routine vision terms or medical terms.

### 3. Move New-Patient Registration Behind Triage

New-patient registration should not start just because the caller says they are new.

The correct sequence is:

1. New caller wants scheduling.
2. Ask visit reason / resolve lane.
3. Routine vision -> optical path.
4. Medical -> medical insurance/routing path.
5. Collect registration fields.
6. Create patient.
7. Availability and booking.

This prevents collecting medical insurance details for routine vision and avoids creating a patient with stale `bach_only` routing that gets corrected later.

### 4. Make Insurance Lane-Specific

`check_insurance` should not default to medical during scheduling.

Simple rule:

- routine vision scheduling: no top-level medical insurance check; use vision coverage/self-pay as needed
- medical scheduling: run medical `check_insurance` before registration/availability
- standalone insurance questions: first clarify medical vs routine vision if the answer can differ

### 5. Harden Guards

Add guard reasons for:

- `check_insurance` during scheduling before lane is known
- `add_patient` before lane is known
- `get_availability` before lane is known

The current guard only blocks `add_patient` if insurance has not been checked. See `src/flow/guards.ts:150`.

`update_insurance` does not need to change just because it updates insurance. Keep standalone insurance updates as their own workflow. The only scheduling rule is that routine-vision scheduling should not use `update_insurance` as a shortcut for medical routing.

### 6. Share Lane Resolver Between Existing-Patient Booking And Reschedule

Existing-patient booking and existing-patient reschedule should share the same lane resolver, but the workflow steps stay separate:

- new appointment: verify -> resolve lane -> availability -> book
- reschedule: verify -> select old appointment -> resolve replacement lane -> availability -> book replacement -> cancel old appointment

This avoids maintaining separate medical-vs-optical logic in two planners.

`planReschedule` should stop deriving replacement lane from appointment text and should instead reuse the same lane facts used by `planScheduling`.

### 7. Fix Or Simplify Reschedule Routing State

The reschedule planner sets `visitType` and `coverageType` from the old appointment, but availability routing currently comes from `state.checkedInsuranceCoverageType` or `state.routing`. See:

- `src/flow/plans/appointment/reschedule.ts:285`
- `src/tools.ts:960`
- `src/tools.ts:982`

This can produce a routine-vision reschedule with null or stale routing, causing middleware errors like "appointment type 3364 is not valid for routing all_three."

Required change: when reschedule re-triages the replacement as routine/optical, availability and booking must use `routing: optical_only`. When it re-triages the replacement as medical, availability and booking must use the medical routing from the insurance/routing check.

### 8. Stop Inferring Reschedule Lane From Appointment Text

Reschedule currently decides routine vision from appointment `type`/`facility` text such as "vision", "glasses", or "contact". See `src/flow/plans/appointment/reschedule.ts:486`.

The target behavior for this first pass is to re-triage from the current caller request. Appointment labels are useful for display, but should not be the source of truth for the replacement lane.

Because we are re-triaging reschedules, this becomes a cleanup rather than a first-pass blocker.

### 9. Preserve Existing Appointment Lane Metadata

Current public appointment context is too thin for reliable reschedule routing. The reschedule planner needs internal metadata such as one of:

- `lane`
- `routing`
- `columnId`
- `profileId`
- `appointmentTypeId`
- `visitKind`

This does not need to be shown to the model. It just needs to survive from middleware appointment lookup into internal flow state so the reschedule planner can route correctly.

Because we are re-triaging reschedules, this is not a first-pass requirement. It becomes useful later if we decide the old appointment lane should win.

### 10. Validate Cached Availability Before Reuse

Reschedule can reuse the latest cached availability without proving it belongs to the active replacement lane. See `src/flow/plans/appointment/reschedule.ts:427`.

Availability reuse should match the active patient, office, replacement lane, routing, and selected old appointment target. If not, invalidate and search again.

### 11. Treat Routing-Type Booking Errors As Lane Errors

If booking fails because an appointment type is invalid for a routing lane, do not retry random later slots. That is not a slot availability problem. The system should either correct the lane/routing once and retry with a consistent request, or transfer.

## Simplest Implementation Shape

1. Update runbook/prompt wording:
   - "For scheduling, always resolve routine vision vs medical before registration, insurance, availability, or booking."
2. Update no-match/new-patient context:
   - "If scheduling and they are new, ask what the visit is for before registration."
3. Update planner:
   - new patient scheduling cannot enter `collect_registration` until lane is resolved
   - registration collection no longer asks for generic "insurance details"; it follows the lane-specific path
4. Update tool descriptions:
   - `add_patient`: do not say only "Run check_insurance first"; say "Resolve scheduling lane first. For medical, check medical insurance. For routine vision, use vision coverage/self-pay path."
   - `check_insurance`: do not default scheduling checks to medical when lane is unknown
   - `update_insurance`: leave standalone insurance updates alone; do not use it as a scheduling shortcut for routine vision
5. Update guards:
   - block scheduling `check_insurance` unless lane is known
   - block `add_patient` unless lane is known
   - block `get_availability` unless lane is known
6. Reschedule policy:
   - re-triage the replacement appointment lane
   - use the old appointment only as the cancellation target after replacement booking succeeds
7. Add focused tests:
   - new patient says first visit -> agent asks visit reason before demographics/insurance
   - new patient routine vision does not run medical Aetna check or create `bach_only` routing first
   - ambiguous "general checkup" asks clarification
   - ambiguous reasons still ask clarification even if the model supplied `visitType: medical`
   - verified patient with stale `bach_only` plus routine reason searches `optical_only`
   - medical scheduling checks medical insurance before availability
   - routine vision scheduling does not use `update_insurance` as a routing shortcut
   - standalone verified insurance update can still use `update_insurance` without a scheduling lane
   - reschedule re-triages the replacement lane before availability
   - routine-vision reschedule searches `optical_only` and books an optical/routine provider
   - medical reschedule checks medical insurance/routing and books the right doctor/provider set
   - old medical appointment rescheduled as routine vision uses the routine replacement lane
   - old routine appointment rescheduled as medical uses the medical replacement lane
   - unclear reschedule replacement reason asks routine-vs-medical clarification
   - cached availability is rejected when patient, office, replacement lane, routing, or selected old appointment target do not match
   - replacement booking succeeds before old appointment cancellation
   - routing-type booking error does not trigger unrelated slot retry

## Specs From Current Decisions

1. Existing patient asks for a routine vision appointment:
   - verify patient
   - classify routine vision
   - do not run top-level medical insurance check
   - search `optical_only`
   - book routine vision
2. Existing patient asks for a medical appointment:
   - verify patient
   - classify medical
   - check insurance on file/current medical insurance for routing
   - use that routing to pick the correct doctor/provider set
   - book medical
3. Existing patient reschedules:
   - verify patient
   - select old appointment
   - re-triage replacement lane from the current request
   - routine replacement -> optical routing/provider
   - medical replacement -> medical insurance/routing/provider
   - book replacement before canceling old appointment
4. New patient scheduling:
   - ask visit reason before demographics, insurance, or registration
   - routine vision -> optical/vision path, no top-level medical insurance check
   - medical -> medical insurance/routing before registration/availability

## Questions To Review

1. For routine vision, should we skip all insurance checks, or only skip medical/top-level insurance while still checking vision coverage when the caller gives a plan?
2. For optical self-pay, can we create the patient with self-pay/minimal coverage, or does middleware require an insurance-like field?
3. If a reschedule re-triages into a different lane than the old appointment, should we mention that the replacement will be a different appointment type/provider path?
4. For medical existing-patient booking, when is insurance on file fresh enough versus needing a new `check_insurance` call?
5. Should standalone insurance questions always ask "medical or routine vision?" before `check_insurance`, since answers can differ?
