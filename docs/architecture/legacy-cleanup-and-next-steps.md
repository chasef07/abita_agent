# Legacy Cleanup And Next Steps

Status: current cleanup record as of 2026-05-27.

## What Changed

The agent is now harness-only for supported Abita trunks.

- `workspace/RUNBOOK.md` was removed.
- `src/prompt.ts` no longer has a non-harness prompt branch.
- `FLOW_HARNESS_TRUNK_PHONES` no longer controls activation. A supported trunk in the Abita office registry uses the flow harness.
- The legacy disabled-harness booking path was removed from `book_appt`.
- Dynamic tool exposure no longer uses legacy naming for the broad harness tool set.
- `record_turn_understanding` and `add_patient_note` were removed from the tool registry and model-facing tool implementation.

The runtime prompt is now:

1. `SOUL.md`
2. `VOICE.md`
3. generated harness operating contract
4. `FLOW_HARNESS_RUNBOOK.md`
5. dynamic caller context
6. state memory contract

Per-turn control remains in TypeScript through `session.userData.flow`, turn-state injection, planner commands, wrapper policy, pending actions, and tool-result state updates.

## What Stayed

These are still active migration surfaces and should not be deleted as simple legacy cleanup:

- `schedulingGoal`: still used by scheduling, booking metadata, and appointment-management plans.
- Top-level `CallState` patient, insurance, appointment, and availability fields: still bridge tool wrappers and middleware payloads.
- `src/flow/shadow.ts`: not on the live runtime path, but still useful for historical replay and tests.

## Future Work

Do these only after the harness-only branch is stable:

1. Remove the remaining `flowHarnessEnabled` boolean checks from tool wrappers and tests, or replace them with a narrower test-only fixture override.
2. Replace the remaining top-level `CallState` mirrors with `flow`-owned patient and scheduling state once all wrappers read from `CallFlowState`.
3. Retire or archive `src/flow/shadow.ts` and replay-only shadow tests if historical shadow validation is no longer needed.
4. Reconcile older architecture docs that still mention `confirm_appt`, `RUNBOOK.md`, `FLOW_HARNESS_TRUNK_PHONES`, `record_turn_understanding`, `add_patient_note`, or the pre-task-plan controller shape.

## Guardrail

Keep `FLOW_HARNESS_RUNBOOK.md` compact. If a behavior needs more than a short instruction, put it in reducer/planner/tool policy code and cover it with tests.
