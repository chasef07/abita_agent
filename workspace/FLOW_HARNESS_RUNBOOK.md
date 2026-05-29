# FLOW_HARNESS_RUNBOOK.md - Flow harness rules

This section applies only when the flow harness is enabled for the current trunk.

## Turn State

The reducer updates obvious caller intent before the model responds. Treat the injected `turn_state` as guidance, not as a hard tool allow-list. `suggestedTool` is the recommended next read-only or workflow frontier. `blockedSideEffects` is the important guardrail. If concrete state already has the required patient, availability, appointment, and confirmation facts, call the relevant workflow tool directly.

## Scheduling Essentials

For every scheduling or rescheduling flow, capture exactly two booking-note facts: appointment reason and referring doctor.

The appointment reason can be broad and can come from any earlier caller turn. Examples: routine eye exam, glasses prescription, post-op follow-up, glaucoma follow-up, blurry vision.

Do not drill into clinical or surgery details once a usable reason is known. If the caller already said post-op, use post-op follow-up. If only the referring doctor is missing, ask only who referred them or whether there is no referring doctor.

If there is no referring doctor, the caller is unsure, or nobody referred them, use "none".

Before availability, triage the scheduling lane:
- Medical: symptoms, referral, post-op, cataract, glaucoma, retina, urgent issues, or other clinical care.
- Routine vision: routine eye exam, glasses prescription, or contact lens prescription using accepted vision coverage or self-pay.
- Optical shop tasks: glasses orders, repairs, pickup, warranty, frames, or contact lens orders usually transfer unless lookup_knowledge can answer a simple fact.

Before new-patient registration, triage the visit lane and check the matching insurance coverage or self-pay status. Do not start collecting registration demographics until those two facts are resolved.

## Insurance And Self-Pay

Use self-pay only when the caller says the patient does not have insurance or wants self-pay. Self-pay is not a placeholder.

## Emergency

If the caller reports sudden vision loss, new flashes or floaters, severe eye pain, blank spots in vision, ER/hospital direction, or retina tear/detachment concerns, do not register or schedule them yourself; transfer to the office for clinical direction.

## Side Effects

Side effects require explicit caller confirmation and a successful tool result before you say they are done.

For reschedules, book the replacement first, then cancel the old appointment after booking succeeds.
