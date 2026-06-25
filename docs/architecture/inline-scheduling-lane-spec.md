# Inline Scheduling Lane Spec

## Goal

Remove the standalone `record_turn_context` model-callable tool and make the
medical-versus-routine scheduling lane part of the tools that actually need it.

The backend still records a small internal scheduling context, but the model no
longer spends a separate tool call just to mutate state.

## Principles

- Business tools own their own prerequisites.
- New appointment availability requires an explicit scheduling lane.
- Reschedule availability derives the lane from the loaded appointment whenever
  possible.
- Booking consumes a private cached slot and booking token returned by
  `get_availability`; it requires that availability came from a new-scheduling
  lane, but does not require a second lane-recording step.
- Chart creation requires the same explicit scheduling lane because the office
  route can change before creating a new patient. The lane must match the
  accepted `check_insurance` coverage type.
- Routing details like `bach_only` stay backend-owned and out of the prompt.

## Model-Facing Contract

### `get_availability`

For a new appointment, call:

```json
{
  "date": "2026-07-23",
  "appointmentLane": "medical_md"
}
```

Use:

- `medical_md` for medical ophthalmology or symptom-driven eye care.
- `routine_od` for routine vision, glasses, contacts, optical, or optometry.

If the caller only says they need an appointment and the lane is unclear, ask a
short clarifying question before checking availability.

For reschedules, omit `appointmentLane` only after the existing appointment to
move is identified. Backend state derives the lane from the loaded appointment
provider, type, routing, or AMD appointment type ID.

### `book_appointment`

`book_appointment` does not accept `appointmentLane`. It books only a caller-confirmed
slot returned by `get_availability`, using the cached private booking token and
stored slot routing.

This avoids duplicate lane entry and prevents the model from changing the lane
between availability and booking. If backend state says the caller is changing
an existing appointment, `book_appointment` must refuse and the model must use
`reschedule_appointment` so the old appointment is cancelled only after the new booking
succeeds.

### `reschedule_appointment`

`reschedule_appointment` keeps owning the book-then-cancel sequence. For existing
appointments, it preserves appointment type/status when appropriate and cancels
the old appointment only after the new booking succeeds.

### `add_patient`

`add_patient` accepts `appointmentLane` directly:

```json
{
  "firstName": "Jane",
  "lastName": "Doe",
  "dob": "01/01/1980",
  "appointmentLane": "routine_od"
}
```

The tool still requires accepted `check_insurance` state, readback
confirmation, and explicit inbound-phone confirmation or an explicit callback
phone. `medical_md` requires accepted `medical` coverage; `routine_od` requires
accepted `routine_vision` coverage.

## Backend State

The internal workflow state is limited to facts used by scheduler routing:

```ts
{
  intent: "schedule" | "change_appointment";
  appointmentLane: "medical_md" | "routine_od" | "not_applicable";
}
```

When the scheduling lane or workflow intent changes, cached availability slots
and private booking tokens are cleared so a slot from one lane or workflow
cannot be reused by another.

## Removed Surface

`record_turn_context` is not exposed to the model and has no exported tool
definition.

The old workflow guide API is also removed. The live runtime uses direct
LiveKit function calling plus typed `session.userData` state; there is no
separate workflow planner.
