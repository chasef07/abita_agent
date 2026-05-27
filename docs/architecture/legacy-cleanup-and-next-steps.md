# Legacy Cleanup And Next Steps

Status: current cleanup record as of 2026-05-27.

## What Changed

The agent is now harness-only for supported Abita trunks.

- `workspace/RUNBOOK.md` was removed.
- `src/prompt.ts` no longer has a non-harness prompt branch.
- `FLOW_HARNESS_TRUNK_PHONES` no longer controls activation. A supported trunk in the Abita office registry uses the flow harness.
- The legacy disabled-harness booking path was removed from `book_appt`.
- Dynamic tool exposure no longer uses legacy naming for the broad harness tool set.

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
- `record_turn_understanding`: still exists as an internal fallback tool definition, although current prompts and default tool sets do not expose it.
- `add_patient_note`: still exists for explicit note operations and grounding tests, but normal scheduling notes are carried through `book_appt`.
- `src/flow/shadow.ts`: not on the live runtime path, but still useful for historical replay and tests.

## Future Work

Do these only after the harness-only branch is stable:

1. Remove the remaining `flowHarnessEnabled` boolean checks from tool wrappers and tests, or replace them with a narrower test-only fixture override.
2. Decide whether `record_turn_understanding` should remain as a manually callable fallback. If not, remove it from `tools.ts`, `tool-registry.ts`, and related tests.
3. Decide whether `add_patient_note` should remain model-callable for exceptional notes. If not, move note persistence behind booking/update wrappers and remove the standalone tool.
4. Replace the remaining top-level `CallState` mirrors with `flow`-owned patient and scheduling state once all wrappers read from `CallFlowState`.
5. Retire or archive `src/flow/shadow.ts` and replay-only shadow tests if historical shadow validation is no longer needed.
6. Reconcile older architecture docs that still mention `confirm_appt`, `RUNBOOK.md`, `FLOW_HARNESS_TRUNK_PHONES`, or the pre-task-plan controller shape.

## Guardrail

Keep `FLOW_HARNESS_RUNBOOK.md` compact. If a behavior needs more than a short instruction, put it in reducer/planner/tool policy code and cover it with tests.
