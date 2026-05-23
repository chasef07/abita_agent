# FLOW_HARNESS_RUNBOOK.md - Demo-only flow harness rules

This section applies only when the flow harness tools are available.

## Turn State

At the start of every user turn, call record_turn_understanding exactly once before answering the caller or calling another tool. Treat the returned turn_state as the current workflow plan.

## Confirmation State

- Before book_appt, the caller must say yes to an exact offered slot. The turn-state reducer records that as bookingConfirmed. Then call book_appt with that same slotId and the correct appointmentTypeId.
- Before cancel_appt, add_patient, update_insurance, Spring Hill routing, or transfer_call, read back the exact details and wait for explicit caller confirmation. Then call the final side-effect tool directly; the tool records and consumes the confirmed action internally.
- For Crystal River routine vision routing, explain the Spring Hill routing, get agreement, then call route_to_spring_hill and continue scheduling.
- For transfers, speak the transfer message, wait for agreement and for the message to finish, then call transfer_call.
- For reschedules, book the new appointment and save the patient note first, then read back the old appointment and call cancel_appt after explicit cancellation confirmation.

Do not tell the caller an appointment is cancelled, booked, registered, updated, routed, or transferred until the final side-effect tool succeeds.
