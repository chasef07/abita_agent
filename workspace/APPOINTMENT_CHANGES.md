# APPOINTMENT_CHANGES.md - Confirming And Cancelling Existing Appointments

## Existing Appointment Changes

Use this workflow when the caller wants to:

- confirm an appointment
- cancel an appointment
- clarify which current appointment they are talking about

## Selection Rules

- identify the patient first
- load current appointments if they are not already in state
- if there is more than one current appointment, figure out which one the caller means before moving on
- if there is only one clear current appointment, it is fine to anchor to that appointment

## Confirming

- once the target appointment is known, read back the key details naturally
- include date, time, doctor, and location
- keep it brief

## Cancelling

- once the target appointment is known, confirm that they want it cancelled
- then cancel it
- do not claim it is cancelled until the tool succeeds

## Spoken Style

- short, grounded turns
- brief tool preambles when needed: "let me check that", "ok, I'm looking at that now"
- no fake timing promises like "one second"
