# Staff Task groups and records intake — local testing

Implements agent issue [#444](https://github.com/chasef07/abita_agent/issues/444).
Portal grouping and durable integration belong to
[acuity_product #298](https://github.com/chasef07/acuity_product/issues/298).

## Local checks

Use Node 22 and pnpm 10.34.3. No provider credentials are needed:

```sh
corepack pnpm@10.34.3 install --frozen-lockfile
corepack pnpm@10.34.3 exec vitest run src/__tests__/staff-task-tool.test.ts src/__tests__/staff-task-conversation.test.ts src/__tests__/office-routing.test.ts src/__tests__/office-knowledge-routing-regression.test.ts src/__tests__/patient-identity.test.ts src/__tests__/simulation.test.ts
corepack pnpm@10.34.3 typecheck
```

The conversation suite uses scripted model decisions with the real Agent,
registered tool, Call State, Office Knowledge Hook, task payload builder and
receipts. Only the external HTTP transport is inert. It checks retained intake,
category payloads, multiple distinct needs, scoped guidance and knowledge
availability. It does **not** prove that a configured model selects the right
category, asks each intake question or follows the policy spontaneously.

Hosted simulations continue to exclude Staff Task creation and Human Transfer.
The controlled test harness restores only the real task tool with an inert
transport that cannot call global fetch. No live transfers run.

For an optional check of the configured primary and fallback models, export only
the required LiveKit inference credentials through your usual secure mechanism:

```sh
corepack pnpm@10.34.3 exec tsx src/__tests__/staff-task-model-check.ts
# Or select scenario IDs:
corepack pnpm@10.34.3 exec tsx src/__tests__/staff-task-model-check.ts ambiguous_prescription pharmacy_pa test_authorization patient_email_full_notes eye_emergency
```

This check incurs inference usage, uses fictional callers and an inert task
transport, observes transfer selection without executing it, and blocks every
other tool execution. It creates no room, calls, messages or production Tasks.
It checks category selection, clarification and supplied answers; it is not a
complete semantic audit of every generated staff note. Missing credentials or
model-check failures are separate from offline runtime test results.

## Portal contract evidence

`evals/fixtures/staff-task-payloads.json` contains 27 payloads captured from real
registered `create_staff_task` execution. Regenerate without network access:

```sh
corepack pnpm@10.34.3 exec tsx src/__tests__/staff-task-contract-export.ts
```

The output covers all nine wire categories: `appointments`, `documentation`,
`medication`, `optical`, `referrals`, `other`, `insurance`, `pre_op`, `post_op`.
It retains the existing summary (240 characters), message (2500 characters),
source call, normalized caller phone, called-office routing and optional patient
contract. `patient.id` comes from the active chart; failed/incomplete identity
intake carries only caller-provided name/DOB, without a chart ID. Anonymous
intake omits `patient`. Essential intake is never truncated by the tool; invalid
input is rejected before HTTP delivery and may be revised and retried.

Use the payloads unchanged in the portal's authenticated HTTP/PostgreSQL check.
Register the synthetic source call through the normal portal test setup if its
contract requires it. Verify the stored message and source/location/identity,
then the authorized staff query. The first two Optical requests have distinct
idempotency keys and share phone, office and source call: preserve both Tasks,
group them in the portal, then move only one to another bucket. The agent has no
prior-Task lookup, grouping, merge, staff assignment or resolution path.

The fixture proves tool emissions, not portal persistence. Portal integration
results must be supplied by the companion implementation.

## Review and rollout boundary

Existing receipt replies remain submission-for-review language. Local duplicates
and successful portal receipts never establish records delivery, valid release
authorization, medication approval or completed clinical work. Failed delivery
keeps the supported retry/transfer fallback. Existing urgent/clinical transfer
policy takes precedence over intake.

The Abita Office Profile's `SOUL.md` supplies Maria's records intake and patient
email restriction; unrelated demo role files do not inherit that policy. No
self-pay price source or staff-suggested knowledge is added. The existing scoped
Office Knowledge source remains authoritative for supported answers.

**Before any production rollout**, deploy and verify portal support for the new
categories and legacy replay compatibility. Then use the existing reviewed
agent/prompt release process. This local implementation does not publish a
prompt, release, deploy, send calls/messages, or alter production data.

## Implementation evidence

Validated locally with Node 22.23.2 and pnpm 10.34.3:

- Required format, lint and typecheck commands passed.
- Full suite: 53 files, 1,148 tests passed; Office Knowledge benchmark 49.26 ms
  against its 250 ms budget for 500 resolutions.
- After the final identity review fix, all six affected suites passed (193
  tests), followed by fresh typecheck and lint. New regression cases were
  observed failing before each fix.
- Standards review: three accepted identity findings fixed (repeated preloaded
  verification, stale asynchronous completion replacing newer task context,
  and reconfirmation failing to supersede an older lookup). No rejected or
  remaining findings. Spec review: its overlapping identity finding fixed;
  no remaining findings.
- Companion portal task reports all 27 payloads passed authenticated HTTP →
  PostgreSQL → authorized grouped My groups query. Both same-bucket requests
  remain independent; category moves and knowledge feedback survive original
  payload retries. This is companion-reported local integration evidence.
- The opt-in model check was attempted but stopped before inference because
  `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` were unavailable. Unscripted model
  behavior and deployed call behavior remain unverified.

Copay/copayment questions use Insurance, including questions about a copay charge
or a copay tied to glasses or medication. Office Knowledge prioritizes this
intent over general billing routing; unresolved questions use an Insurance Task
with caller agreement. Ordinary balance/billing questions retain their existing
billing-contact path. Local scripted tests cover routing and transport, not
unscripted model behavior or a deployed release.

Copay follow-up verification (Node 22.23.2, pnpm 10.34.3):
`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.
All 53 files / 1,156 tests pass; the Office Knowledge benchmark is 85.85 ms
against the 250 ms budget. Routing regressions were observed failing before the
fix. Standards review's duplicate-alias finding was fixed; its recheck has no
remaining findings. No live model inference or production deployment was run.
