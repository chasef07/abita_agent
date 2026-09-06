# New Tampa Eye Institute demo

The 320 trunk represents New Tampa Eye Institute with the canonical
`new-tampa-demo` office key. The shared demo booking account remains stable;
the old behavioral-health content is retired. The 802 Clearbrook demo is unchanged.

Public identity, locations, and provider specialties come from the practice's
[site](https://newtampaeyes.com/), [roster](https://newtampaeyes.com/about-us/),
[Wesley Chapel](https://newtampaeyes.com/contact-location/wesley-chapel/), and
[Dade City](https://newtampaeyes.com/contact-location/dade-city/) pages, checked
September 6, 2026. Hours, direct on-call contact, prices, and actual insurance
contracts remain unverified. Medical and vision insurance are separate demo
fixtures adapted from Clearbrook, with a caller notice on accepted matches.

## Production isolation

The 320 office entry and its tool-registry branch use `new-tampa-demo`.
Retired behavioral-health knowledge aliases are removed.
The production scheduling workflow, availability storage, call-state type,
insurance tool and portal client are unchanged.
New Tampa uses demo-only tool wrappers and a per-call WeakMap for triage. Other real
numbers and the other demo numbers receive the original tools. A companion
Product migration renames the existing Location provisioning key
in place and adds the new office route before this agent is deployed. The old
route remains only for in-flight calls and delayed receipts during rollout.
Deploy Product first, verify both routes resolve to the same Location ID, then
deploy this agent and verify a synthetic interaction, staff task, and handoff.
Do not reconcile an old Product provisioning file after migration: it would
recreate the retired Location key. Retire the legacy route in a later migration
after old agent jobs and receipt retries have drained.

## Runtime behavior

`triage_eye_care` records the stated visit purpose and provider preference for
the current patient. It is service routing, not diagnosis. Ambiguous providers,
mismatched requests, unknown purposes, and urgent concerns block scheduling.
Changing triage invalidates loaded slots; changing patient requires fresh triage.
Availability filters by the approved provider's full name. Booking and rescheduling
recheck both the provider and care lane. Backend dates, tokens, and provider names
are never fabricated or relabeled.

The shared demo calendar must return matching New Tampa provider names to demonstrate
booking with these doctors. Otherwise the agent offers staff help. This checkout
does not configure the backend roster or verify live calendar availability.

`notify_after_hours_physician` is an explicit, network-free simulation. Its result
says no real physician was contacted and identifies the existing demo transfer
number only as a demo callback line. The agent then uses `transfer_call` with the
existing demo destination. Actual physician SMS requires a delivery integration,
an approved destination, delivery receipts, and an actual after-hours contact.

## Call rehearsal

Use synthetic patient details only. These are live-model rehearsal scenarios;
unit tests verify runtime boundaries and configuration, not spontaneous model speech.

| Caller scenario | Expected experience |
| --- | --- |
| “Where is your Wesley Chapel office? What about Dade City?” | Correct public addresses; no fictional Clearbrook locations. |
| “Who handles my glaucoma?” | Gretta Fridman or Hirah Khan, subject to staff/provider availability. |
| “My referral is for macular degeneration.” | Retina service, Scott Friedman; no diagnosis or treatment advice. |
| “I need help with my eyelid.” | Clarify service when needed; Laurie Small for an established eyelid/oculoplastics visit. |
| “I saw Doctor Scott Friedman before. I want him for a routine eye exam.” | Acknowledge caller-stated history; explain retina specialty; offer optometrist Bradley Smur and wait for agreement. No silent substitution. |
| “Doctor Friedman.” | Clarify Gretta Fridman versus Scott Friedman. |
| “No, this is actually my retina follow-up with Scott.” | Retriage as retina, then offer only matching returned slots. |
| Caller starts yelling and cussing at the agent | Brief apology and acknowledgment; immediate demo transfer, no intake gate or reprimand. |
| Calendar offers a distant date; “Three months? I need urgent attention.” | Stop scheduling and transfer for staff assessment. Never say it is safe to wait. |
| “I know it's after hours, but this is an emergency.” | Emergency guidance as appropriate; explicit simulated text result; demo answering-service transfer. No claim of real delivery. |
| “Can I call the doctor myself?” | Offer only the tool's demo callback line, labeled as such; actual physician number is unavailable. |
| Routine exam with VSP; medical visit with Ambetter Premier | Correct coverage lane and check_insurance result; accepted match explicitly described as a demo result. |
| Unknown insurance / provider disagreement / no matching calendar provider | Clarify or offer staff help; no invented coverage, provider fit, or appointment. |

Run `pnpm test` for regression coverage. Run the call rehearsals against the intended
deployment before presenting it; local tests alone do not validate live STT/LLM/TTS,
SIP handoff, portal delivery, or a real physician messaging service.
