# Middleware scheduling ownership

Deploy [middleware #190](https://github.com/Data-Buddies-Solutions/amd_middleware/pull/190)
**before this TypeScript change**. The parallel Python implementation is
[abita_s2s #33](https://github.com/chasef07/abita_s2s/pull/33). No runtime environment
variables, storage, workers, or insurance policy changes are required.

Middleware owns appointment office identity, visit type, action authorization,
provider eligibility, and both provider writes of a reschedule. TypeScript retains
caller office/visit preferences, exact confirmation, private references, patient
context, availability expiry, and call-local mutation receipts. Unknown visit type
stays unknown; missing action tokens require reloading appointments. Original
appointment type and office are authorized by the middleware token, never inferred
from provider type IDs or facility text.

`POST /api/appointment/reschedule` sends `patientId`, `bookingToken`,
`rescheduleToken`, and booking intent once. Completed responses require a confirmed
replacement for the captured patient and cancellation receipt for the selected
original. Partial responses preserve the replacement without claiming cancellation.
Lost, malformed, or uncertain responses stop further patient writes, as do partial
reschedules. Definite failures invalidate availability so another attempt needs a
fresh search and explicit confirmation. Standalone booking and cancellation also
stop on ambiguous responses rather than offering a write retry.

Confirmed receipts reconcile stale appointment reads and survive patient switches
within the call. All scheduling writes are serialized within the call, including
separate tool instances. This is **not durable, restart, cross-call, or cross-instance
idempotency**. Staff must reconcile partial/uncertain outcomes; a patient reload
alone does not release the write block. AdvancedMD's two writes are not atomic.

Unsupported office/visit combinations remain `no_eligible_providers`, distinct from
`no_availability`. Middleware decides eligibility; the tool asks for an office/visit
correction or staff help instead of suggesting more dates.

## Patient resolution audit

Middleware #188 and Python #31 are already merged. The TypeScript first-name/DOB
path already accepts a hydrated `verified` result, leaves `multiple_matches`
unselected, treats `not_found` separately, and refuses to promote `unresolved`
results. It performs no selection from a returned search candidate list. Existing
phone-candidate privacy and caller verification remain unchanged. Patient replies
reconcile confirmed scheduling receipts before describing upcoming appointments. Receipt reconciliation and new
booking/reschedule receipts preserve a failed inventory-read status: a proven
appointment does not prove the rest of the calendar loaded. Patient replies still
report the failed read and reload it, while confirmed receipts remain in call state.
Missing cancellation authority also marks the inventory for reload before another
attempt. Regression tests reproduce both failures before checking recovery.
Real handler fixtures exercise unique selection with a missing-DOB neighbor, only missing-DOB
records, ambiguity, incomplete search, and provider failure.

## Before and after evidence

Baseline: agent `00791f2` and middleware `9dd501d7fd3ba81940b1f01ccc839697bb7dcb9b`.
The baseline drops `officeId`, `office`, `visitType`, and booking cancellation tokens;
classifies visit type from provider IDs; falls back to appointment ID cancellation;
reschedules using separate book/cancel requests; and merges unsupported visits with
empty calendars. Running the same cross-repository contract driver against that
baseline fails at the first authoritative `officeId` assertion (received undefined).
The updated implementation passes completed, partial, failed, and uncertain
reschedules through authenticated Go handlers with only AdvancedMD mocked.

`src/__tests__/fixtures/scheduling` contains actual handler envelopes from that
middleware commit, including signed tokens issued with the **fixture-only** secret.
The regular TypeScript suite consumes those envelopes at the HTTP boundary and
checks confirmation, expiry, unknown metadata, wrong-patient receipts, concurrent
and repeated calls, definite-failure recovery, patient switches, stale reloads,
privacy, and unsupported visits. Older two-request reschedule tests are replaced
by these endpoint tests, while inventory, cancellation, and demo guards remain.

To reproduce the cross-repository check without changing the middleware worktree,
run from this repository with its dependencies installed:

```sh
agent_root="$PWD"
middleware_fixture=$(mktemp -d)
git -C /path/to/abita_middleware archive 9dd501d7fd3ba81940b1f01ccc839697bb7dcb9b | tar -x -C "$middleware_fixture"
cp scripts/contracts/typescript_contract_test.go "$middleware_fixture/internal/scheduling/"
TYPESCRIPT_SCHEDULING_WORKTREE="$agent_root" go -C "$middleware_fixture" test -count=1 ./internal/scheduling -run 'TestTypeScript(Patient|Scheduling)Contract' -v
```

The environment variable above is only a local test-runner path. The harness calls
the real TypeScript workflow, checks provider write counts, and regenerates fixtures.
It uses an ephemeral loopback server and makes no live provider writes. Local tests
and CI do not establish deployment, audio, SIP, or live voice behavior.
