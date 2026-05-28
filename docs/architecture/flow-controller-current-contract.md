# Flow Controller Current Contract

This is the short current-state contract for the merged flow controller spine.
The longer architecture notes remain historical design context.

## Activation

- Every call gets `session.userData.flow`.
- Every call records `session.userData.preCallLookup` with explicit
  `verified`, `multiple_matches`, `no_match`, or `lookup_failed` status.
- The live enforcement harness is enabled for every supported Abita trunk: dev,
  Spring Hill, Crystal River, Hollywood, and Sweetwater.
- `FLOW_HARNESS_TRUNK_PHONES` is no longer an activation switch. The supported
  trunk registry is the activation boundary.

## Turn State

- On each user turn, the agent injects a compact `<turn_state>` packet.
- The packet also includes `<context_capsules>` for the current objective,
  active patient facts, loaded appointments, scheduling facts, pending
  confirmations, cached availability, and blocked actions.
- The deterministic reducer records obvious caller intent before the model
  responds. There is no model-facing turn-understanding tool in the active
  tool registry.
- The model proposes structured semantic state; TypeScript owns whether that
  update changes patient, task, scheduling, insurance, routing, or pending
  action state.

## Tool Policy

- Guarded tools refuse stale turns until turn understanding is recorded.
- Code blocks unsafe sequencing for visit-type triage, Crystal River routine
  vision routing, duplicate availability searches, booking prerequisites,
  cancellation prerequisites, insurance updates, and side-effect confirmation.
- Side-effect tools create confirmed pending actions only after the current
  speech is successfully made uninterruptible.
- Booking success is recorded in flow state so post-booking note operations can
  be grounded to an actual booking.
- Transfer has an in-flight guard so parallel tool calls cannot launch multiple
  SIP transfers.

## Documentation Boundary

- `workspace/RUNBOOK.md` has been removed. The prompt no longer has a
  non-harness runbook path.
- Supported trunks load `SOUL.md`, `VOICE.md`, a compact harness operating
  contract, and
  `workspace/FLOW_HARNESS_RUNBOOK.md`.
- This file is the operator/developer summary of what the current code enforces.

## Portability Boundary

- `src/flow/*` is the reusable harness and should not know about Abita office
  names, phone numbers, greetings, or transfer targets.
- Active customer wiring is isolated behind `src/customer/profile.ts`; the
  Abita implementation lives in `src/customers/abita/profile.ts`.
- `src/tooling/*` holds generic adapter helpers around middleware calls, call
  state, handoff, and knowledge lookup so `src/tools.ts` can stay focused on
  LLM tool behavior and flow-policy integration.
