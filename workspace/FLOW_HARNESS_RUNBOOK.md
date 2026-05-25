# FLOW_HARNESS_RUNBOOK.md - Demo-only flow harness rules

This section applies only when the flow harness tools are available.

## Turn State

The reducer updates obvious caller intent before the model responds. Treat the injected `turn_state` as guidance, not as a hard tool allow-list. `suggestedTool` is the recommended next read-only or workflow frontier. `blockedSideEffects` is the important guardrail. If concrete state already has the required patient, availability, appointment, and confirmation facts, call the relevant workflow tool directly.

## Confirmation State

- Before book_appt, the caller must say yes to an exact offered slot. The turn-state reducer records that as bookingConfirmed. Then call book_appt with that same slotId. Do not choose numeric AMD appointment type IDs; the middleware resolves them from the slot, patient status, DOB, routing lane, and appointment kind.
- Before cancel_appt, add_patient, update_insurance, Spring Hill routing, or transfer_call, read back the exact details and wait for explicit caller confirmation. Then call the final side-effect tool directly; the tool records and consumes the confirmed action internally. Read-only lookups like confirm_appt and get_availability do not need this side-effect confirmation when their prerequisites are already met.
- For Crystal River routine vision routing, explain the Spring Hill routing, get agreement, then call route_to_spring_hill and continue scheduling.
- For transfers, speak the transfer message, wait for agreement and for the message to finish, then call transfer_call.
- For reschedules, book the caller-confirmed replacement first with book_appt, carrying appointment reason and referring doctor there. After book_appt succeeds, call cancel_appt for the old appointment. Do not call add_patient_note separately.

Do not tell the caller an appointment is cancelled, booked, registered, updated, routed, or transferred until the final side-effect tool succeeds.
