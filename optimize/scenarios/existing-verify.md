# Scenario: Existing Patient — Verify + Schedule/Cancel/Reschedule

Caller is an existing patient. Verify identity then handle their scheduling need.

## Variants

### Phone Lookup: Single Match (pre-verified)
- Context already has patient data (name, DOB, patientId, appointments)
- Agent asks for first name to confirm identity
- Caller says their name → matches the lookup → SKIP verify_patient
- Go straight to handling their request

### Phone Lookup: Multiple Matches
- Context says multiple patients on this phone number
- Agent asks for first name
- Agent calls verify_patient with firstName + usePhone=true
- If verified: proceed
- If not found: ask for last name and DOB, retry

### Phone Lookup: No Match
- Agent asks for first name, last name, DOB
- Agent calls verify_patient with full details
- If found: proceed
- If not found: offer registration (becomes new-patient flow)

### Scheduling
- Caller wants to make an appointment
- Agent calls get_availability with correct appointment type (1007 for adult follow-up)
- Suggests one slot, books if accepted

### Confirming
- Caller wants to check their next appointment
- If appointments are in caller context: read them directly (no tool call needed)
- If not: call confirm_appt

### Cancelling
- Agent calls confirm_appt (if needed) → reads back appointment → confirms cancellation → cancel_appt

### Rescheduling
- Agent calls confirm_appt → identifies which appointment → get_availability → book_appt → THEN cancel_appt (book before cancel)

## Expected Tools by Sub-scenario
- **Schedule (pre-verified)**: get_availability + book_appt (2 tools)
- **Schedule (not pre-verified)**: verify_patient + get_availability + book_appt (3 tools)
- **Confirm (pre-verified with appointments in context)**: 0 tools
- **Cancel**: confirm_appt (maybe) + cancel_appt (1-2 tools)
- **Reschedule**: confirm_appt + get_availability + book_appt + cancel_appt (3-4 tools)

## Expected Turn Count
- Pre-verified schedule: 5-8 turns
- Not pre-verified schedule: 7-10 turns
- Confirm: 2-4 turns
- Cancel: 4-6 turns
- Reschedule: 8-12 turns

## Common Failures
- **Unnecessary verify_patient**: Phone lookup already has a single verified match + caller confirmed name, but agent still calls verify_patient
- **Unnecessary confirm_appt**: Appointments are already in caller context from phone lookup but agent calls confirm_appt anyway
- **Wrong appointment type**: Uses 1006 (new adult) for an existing patient instead of 1007 (follow-up)
- **Same-date double query**: Calls get_availability for the same date twice
- **Cancel before book**: On reschedule, cancels old appointment before booking new one (risky — could leave patient with nothing)
- **Asking DOB for pre-verified**: Patient verified by phone lookup, agent still asks for date of birth
- **Name before intent**: Agent asks for name before understanding why the caller is calling
