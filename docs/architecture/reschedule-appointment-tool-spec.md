# Reschedule Appointment Tool Spec

## Goal

Make appointment rescheduling deterministic from the model's point of view.

The model should not be responsible for remembering to call `book_appointment` and then
`cancel_appointment`. It should collect the facts, confirm the old appointment and new
slot with the caller, then call one write tool:

```txt
reschedule_appointment
```

The tool owns the two side effects in code:

1. Book the newly confirmed slot.
2. Cancel the selected old appointment only after the new booking succeeds.

## Problem

Today rescheduling is encoded as guidance in tool descriptions and workflow
context:

- `cancel_appointment` says: for reschedules, book the new appointment before cancelling
  the old one.
- `book_appointment` books only one selected availability slot.
- `cancel_appointment` cancels only one loaded appointment.

That is not strong enough. The model can still stop after booking, cancel the
wrong appointment, call the tools in the wrong order, or lose appointment-type
facts between the old and new appointment.

There is also a concrete appointment-type bug:

- A caller can have a chart in AMD but no visit history.
- Their existing appointment may be a New Patient appointment.
- The current booking path derives `patientStatus` from patient state.
- Any verified existing chart is treated as `established`.
- At Crystal River that can turn an old `Crystal River New Patient` appointment
  into a new `Crystal River Established Patient` appointment during a move.

The fix should preserve New Patient status when the old appointment indicates
the patient has no history.

## Non-Goals

- Do not build a separate flow-controller or planner.
- Do not expose booking tokens, raw column IDs, profile IDs, or middleware
  internals to the model.
- Do not make the model choose `patientStatus`.
- Do not make rescheduling atomic across AMD. AMD booking and cancellation are
  separate side effects. The tool can guarantee deterministic sequencing, not
  transactional rollback.

## Design Decision

Add one agent-side `llm.tool()` named `reschedule_appointment`.

This is simpler than a new middleware endpoint because the agent already owns:

- selected availability slots,
- private signed booking tokens,
- loaded appointment state,
- caller identity state,
- office routing state,
- the speech-ready return contract.

The middleware should continue to own:

- appointment type resolution for `/api/appointment/book`,
- appointment ownership validation for `/api/appointment/cancel`,
- AMD write calls.

If future auditing or backend transaction semantics become important, a
middleware `POST /api/appointment/reschedule` endpoint can be added later. The
first implementation should not start there.

## Model-Facing Tool Contract

Tool name:

```txt
reschedule_appointment
```

Purpose:

```txt
Reschedule a loaded appointment by booking the caller-confirmed new slot first,
then cancelling the caller-confirmed old appointment.
```

Description should be short and action-oriented:

```txt
Reschedule a loaded appointment. Call only after the patient is verified, the
caller confirms the exact old appointment to move, get_availability returns
slots, the caller confirms the exact new slot, and the caller provides a
referring doctor or says they have none. This tool books the new appointment
first and cancels the old appointment only after booking succeeds.
```

Parameters:

```ts
parameters: z
  .object({
    appointmentSlotRef: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Slot reference from get_availability for the caller-confirmed new appointment slot.",
      ),
    appointmentReason: z
      .string()
      .trim()
      .min(1)
      .describe("Caller-provided reason for the new appointment."),
    referringDoctor: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Caller-provided referring doctor, or "none" if the caller has no referring doctor.',
      ),
    readBack: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after reading back the selected new appointment date, time, and provider and the caller confirms the new appointment details are correct.",
      ),
    oldAppointmentDate: z
      .string()
      .optional()
      .describe(
        'Date the caller used to identify the old loaded appointment being moved, such as "June 2", "June 2nd", or "2026-06-02". Omit when exactly one old appointment is loaded and confirmed.',
      ),
    oldAppointmentTime: z
      .string()
      .optional()
      .describe(
        'Time the caller used to identify the old loaded appointment being moved, such as "10 AM" or "2:30 PM". Use with oldAppointmentDate when needed.',
      ),
  })
  .strict()
```

## Execution Contract

The tool must run the sequence in code:

1. Disable interruption for the write action.
2. Restore the confirmed pre-call caller if needed.
3. Require active patient ID.
4. Require a selected existing appointment or infer exactly one loaded
   appointment.
5. Select the old appointment using the same selector logic as `cancel_appointment`.
6. Select the new slot from current availability state.
7. Require a fresh private booking token for the new slot.
8. Normalize appointment reason and referring doctor using the same rules as
   `book_appointment`.
9. Build the booking request.
10. Book via `/api/appointment/book`.
11. If booking fails, do not cancel the old appointment.
12. If booking succeeds, record the new appointment in state.
13. Cancel the old appointment via `/api/appointment/cancel`.
14. If cancellation succeeds, remove the old appointment from state.
15. Return speech-ready text describing the final result.

## Appointment Type Preservation

The reschedule tool must derive booking `patientStatus` from the old appointment
before falling back to generic patient state.

Old appointment status mapping:

- New Patient type -> `patientStatus: "new"`
- Established Patient type -> `patientStatus: "established"`
- New Adult Medical -> `patientStatus: "new"`
- New Pediatric Medical -> `patientStatus: "new"`
- New Adult Vision -> `patientStatus: "new"`
- New Pediatric Vision -> `patientStatus: "new"`
- Established Adult Medical -> `patientStatus: "established"`
- Established Pediatric Medical -> `patientStatus: "established"`
- Established Adult Vision -> `patientStatus: "established"`
- Established Pediatric Vision -> `patientStatus: "established"`

For Crystal River specifically:

- `Crystal River New Patient` must stay `patientStatus: "new"`.
- `Crystal River Established Patient` must stay `patientStatus: "established"`.

The old appointment type should win over `state.patient.status`. A verified AMD
chart does not prove the caller has visit history.

### Preferred State Addition

Loaded appointments should carry a backend-owned appointment type identifier
when middleware can provide it:

```ts
interface CallerAppointment {
  id: number;
  date: string;
  time: string;
  provider: string;
  type: string;
  appointmentTypeId?: number;
  facility: string;
  confirmed: boolean;
}
```

The preferred implementation order is:

1. Add `appointmentTypeId` to middleware `PatientApptDetail`.
2. Preserve it through agent patient resolve normalization.
3. Use `appointmentTypeId` for new-versus-established classification.
4. Fall back to `type` string classification when the ID is absent.

This keeps the Christy Howie case deterministic even if display names change
slightly.

## Helper Extraction

Avoid duplicating booking internals.

Extract shared helpers from `book-appt.ts` into a backend-only module, likely
`src/tools/booking-state.ts` or `src/tools/booking-request.ts`:

- normalize appointment reason,
- normalize referring doctor,
- build appointment intent,
- infer appointment kind,
- classify booking success,
- read appointment ID from booking result,
- build speech-ready booked slot text.

`book_appointment` and `reschedule_appointment` should call the same helper for booking. The
only difference is patient-status override:

- `book_appointment`: use normal patient-state fallback.
- `reschedule_appointment`: use old appointment type first, then patient-state
  fallback.

## Failure Handling

### Booking Fails

Do not cancel the old appointment.

Return the same style of message as `book_appointment`, for example:

```txt
That time is no longer available. I can offer June 4 at 10:00 AM instead.
```

or:

```txt
The new appointment was not booked, so I did not cancel the existing appointment.
```

### Booking Succeeds, Cancellation Fails

Do not hide the partial failure.

Keep both appointments in state and return:

```txt
I booked the new appointment for June 4 at 10:00 AM, but I could not cancel the
old appointment. I need to transfer you so the office can finish the cancellation.
```

The tool should not claim the reschedule is complete unless both side effects
succeed.

### Ambiguous Old Appointment

Do not book anything.

Return the same clarification style as `cancel_appointment`:

```txt
I found more than one matching appointment. Loaded appointments: ...
```

### Missing Fresh Booking Token

Do not cancel anything.

Throw or return the same actionable message as `book_appointment`:

```txt
Search availability again before booking because the selected slot expired.
```

## Registry And Prompt Changes

Add `reschedule_appointment` to the active tool registry.

Keep `cancel_appointment` focused on pure cancellation. Remove or soften the
reschedule sequencing sentence from `cancel_appointment` after `reschedule_appointment` is
available, because rescheduling should no longer be a model-orchestrated
two-tool sequence.

Update appointment-change guidance:

```txt
For reschedules, use reschedule_appointment after the caller confirms the old
appointment and new slot. For cancellations, call cancel_appointment only after the
caller confirms the exact loaded appointment.
```

Do not add broad prompt prose. Correctness belongs in the tool preconditions and
the tool implementation.

## Acceptance Criteria

- The model has one reschedule write tool.
- `reschedule_appointment` books before cancelling in code.
- `reschedule_appointment` never cancels when the new booking fails.
- `reschedule_appointment` never books when the old appointment is ambiguous.
- `reschedule_appointment` preserves New Patient status from the old loaded
  appointment.
- Crystal River New Patient reschedule sends booking intent that resolves to
  `Crystal River New Patient`, not `Crystal River Established Patient`.
- Cancellation still sends `patientId` plus `appointmentId`; no cancel token is
  reintroduced.
- Booking tokens remain private and are never exposed to the model.
- Tool output is speech-ready and honest about partial failures.

## Required Tests

Agent tests:

- Registers `reschedule_appointment` in the active tool set.
- Requires patient identity before rescheduling.
- Requires old appointment selection before booking.
- Requires fresh private booking token before booking.
- Calls `/api/appointment/book` before `/api/appointment/cancel`.
- Does not call cancel when booking returns `slot_unavailable`.
- Does not call book when old appointment selection is ambiguous.
- Removes the old appointment and records the new appointment after success.
- Keeps both appointments in state when booking succeeds but cancellation fails.
- For a loaded `Crystal River New Patient` old appointment, sends
  `patientStatus: "new"` even when `state.patient.status` is verified.

Middleware tests, if `appointmentTypeId` is added:

- `PatientApptDetail` includes appointment type ID from AMD appointment type
  IDs.
- Patient resolve responses include the type ID for loaded appointments.
- Crystal River appointment type IDs are preserved through patient resolve.

Validation commands:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm exec prettier --check docs/architecture/reschedule-appointment-tool-spec.md src
git diff --check
```
