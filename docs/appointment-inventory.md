# Conversational appointment inventory

This replaces the agent's date-phrase search with the user-approved LiveKit-style
flow. It supersedes the agent-facing temporal interpretation and two-result-only
parts of issue #370; patient eligibility and booking policy stay authoritative.

## Contract

- `list_available_appointments` accepts `range`: `default` or `+2week` (14 days),
  `+1month` (30 days), or `+3month` (90 days). Omission defaults to 14. The existing
  Visit Type and office selectors remain. The same list supports both new and replacement appointments.
- After identity, office, and scheduling eligibility are established, the agent
  loads one complete eligible window. The window starts at the earliest
  policy-permitted date (tomorrow, adjusted for preauthorization), counts exactly
  14/30/90 clinic-local calendar dates, and excludes same-day appointments.
- Middleware `POST /api/scheduler/slots` takes `rangeDays`, office, DOB, routing,
  and preauthorization. It returns every eligible slot in chronological order,
  coverage dates, and private signed booking authorizations. No top-two cutoff.
- The tool returns readable dates, times, providers and opaque `S...` references.
  The LLM matches preferences, offers at most two choices, and uses the same
  result for later/earlier/day-of-week refinements. It expands the horizon only
  when needed. Private tokens and provider resource IDs stay out of model input.
- The call retains the widest requested range. Identical concurrent reads join;
  completed positive and empty results are reusable for at most 60 seconds,
  bounded by authorization expiry. This is a conservative initial freshness
  setting, not a measured optimum. Inventory is isolated by patient, office,
  scheduling context, policy inputs, and clinic date.
- Expanding or refreshing inventory preserves IDs for identical slots and
  replaces the authoritative active list. A late smaller-window response cannot
  replace a newer expanded request. Context changes clear incompatible state.
- The full list enters conversation history once per tool result. Per-turn
  system context carries only the current inventory revision and scope marker,
  or a stale-inventory instruction, avoiding a second full calendar injection.
- `book_appointment` and `reschedule_appointment` still use the confirmed opaque
  reference. Existing read-back, eligibility, token expiry, provider slot recheck,
  success receipt, reschedule ordering, and conflict handling remain. An expired
  authorization requires refreshing; a replacement requires confirmation.
- No pre-call inventory fetch, shared cross-call cache, speculative booking,
  automatic replacement, or change to clinical/intake policy is introduced.

## Middleware delivery

Deploy the middleware `/slots` endpoint before activating this agent. The agent
has no fallback to the old two-slot endpoint, so old middleware cannot silently
serve a partial calendar as complete inventory. Middleware retains `/availability`
for the currently deployed agent during rollout and rollback; it shares the
same slot calculation and booking policy with the new inventory path.

The inventory reader uses the existing verified daily appointments/block-holds
adapter, bounded to four concurrent days. It does not assume monthly appointment
reads also prove block-hold completeness. Incomplete coverage returns an explicit
incomplete result without misleading partial offers. This trades more initial
reads for fewer conversational re-queries; 30/90-day latency and payload sizes
must be measured before production activation. The existing HTTP read timeout
remains in force. No production performance or booking-conversion gain is claimed.

## Verification

Exercise default/14/30/90 coverage, month and DST boundaries, all-slot listing,
private-token isolation, stable selection after expansion, cache expiry including
empty results, out-of-order completion, patient/office changes, and provider
booking conflicts. Test the actual tools and HTTP contracts; retain existing
booking/cancellation/rescheduling regression suites. Observe final appointment
identity and count, not only conversational claims.

## Rescheduling uses the same inventory

`list_available_appointments` accepts medical or routine_vision for both new
bookings and rescheduling. It has no existing-appointment parameter or selection
step. Once a new slot is confirmed, call `reschedule_appointment` with the
`oldAppointmentRef` from the loaded patient appointments and `appointmentSlotRef`
from the inventory. The workflow validates both references and matching visit
category before any write, preserves the old appointment type, books the new
appointment first, then cancels the old one. A cancellation failure remains an
explicit partial outcome and blocks duplicate booking.

Successful receipt replay is scoped to the original and replacement appointment
references. Moving another appointment in the same call cannot be redirected to
the latest booking or mistaken for a replay, even at the same date/time.
