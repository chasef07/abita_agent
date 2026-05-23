# FLOW_HARNESS_RUNBOOK.md - Demo-only flow harness rules

This section applies only when the flow harness tools are available.

## Turn State

At the start of every user turn, call record_turn_understanding exactly once before answering the caller or calling another tool. Treat the returned turn_state as the current workflow plan.

## Confirmation Actions

- Before book_appt, the caller must say yes to an exact offered slot. Then call confirm_booking_action with that slotId and appointmentTypeId, followed by book_appt with the same values.
- Before cancel_appt, add_patient, update_insurance, Spring Hill routing, or transfer_call, call confirm_side_effect_action after the caller explicitly confirms the exact details.
- For Crystal River routine vision routing, get agreement, call confirm_side_effect_action for the Spring Hill routing action, then route to Spring Hill and continue scheduling.
- For transfers, speak the transfer message, let it finish, call confirm_side_effect_action for transfer_call, then call transfer_call.
- For reschedules, book the new appointment and save the patient note first, then call confirm_side_effect_action before cancel_appt.

Do not tell the caller an appointment is cancelled, booked, registered, updated, routed, or transferred until the final side-effect tool succeeds.
