# Conversational appointment inventory

## Contract

- `list_available_appointments` accepts an optional `startDate` in YYYY-MM-DD
  format. Omission or null starts tomorrow in Eastern time. A supplied date
  searches there directly, without reading intervening dates. The existing
  Visit Type and office selectors remain; the same tool supports new bookings
  and rescheduling. The old `range` options are removed.
- Every window contains exactly 14 calendar dates. Middleware applies the
  existing preauthorization minimum start date and rejects same-day, past, and
  invalid dates. Provider calendars are read only on configured working days;
  skipped days do not extend the window.
- Middleware `POST /api/scheduler/slots` takes `startDate`, office, DOB, routing,
  and preauthorization. `rangeDays` may be omitted or 14; all other lengths,
  including 30 and 90, are rejected before provider access. It returns every
  eligible slot in chronological order, coverage dates, and private signed
  booking authorizations. A supplied start date does not trigger top-two ranking.
- For dates after the loaded window, use the day after `searchedThrough` as the
  next `startDate`. For a specific future month or date, start there directly.
  Day-of-week and time preferences within the loaded window use existing results.
  Offer at most two choices; do not automatically scan successive windows.
- Repeated and concurrent requests for the same window reuse/join the existing
  read. Completed positive and empty results remain reusable for at most 60
  seconds, bounded by token expiry. Default and explicit tomorrow share a key.
  Cache keys include the requested date, patient, office, policy, and clinic date.
  There is no retained widest range. Omission always selects the default window.
- Changing windows replaces the active inventory; matching slots preserve their
  references. Late responses for a different requested window cannot replace it.
  Patient, office, or policy changes invalidate incompatible inventory and cache.
- Incomplete reads remain unknown rather than empty. Existing booking and
  rescheduling confirmation, signed tokens, fresh provider revalidation, and
  durable success receipts remain required. No shared cache, rate limiter, or
  new retry mechanism is introduced by this change.

## Delivery

The new agent requires middleware that accepts `startDate`. Deploy middleware
support before activating the agent, with the transition coordinated: old agent
14-day default calls remain accepted, but old 30/90-day calls will be rejected.
The older two-slot `/availability` route keeps its existing behavior and is not
used as a fallback for this inventory tool.

## Verification

Test all-slot 14-day coverage across month/DST boundaries, future windows and
adjacent windows without intervening reads, working-day filtering, preauthorization,
invalid dates and removed ranges, same-window caching, late responses, cache expiry,
context resets, and booking/rescheduling contracts. Use synthetic provider data;
local tests do not establish live request reductions or patient outcomes.
