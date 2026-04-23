# Agent SOTA Next Steps

## Purpose

This document tracks the work that would move the current agent architecture from launch-safe and materially improved into a stronger state-of-the-art direction for context engineering and tool-calling reliability.

It is intentionally post-launch in scope.

The current branch already has:

- modular router and task prompts
- structured hidden call state
- scoped task and task-group orchestration
- workflow transition modules
- launch hardening for routed office context, registration gating, and appointment-selection state

What remains is mostly controller architecture, failure handling, and evaluation discipline.

## Current Assessment

The codebase is no longer the old monolithic prompt-driven agent.

It is now a strong workflow-oriented architecture with:

- explicit state
- narrower tool surfaces
- code-level guards
- task-local prompts
- transition definitions for schedule, reschedule, confirm, and cancel

The main remaining gap is that the transition engine still describes the workflow more than it controls it.

## Priority 1: Make the Transition Engine Drive Execution

### Goal

Replace callback-driven `TaskGroup` orchestration with an explicit workflow runner loop.

### Why This Matters

Right now:

- transition functions return `nextStep`
- workflow runners still pre-register tasks and rely on task completion callbacks

That means the controller is cleaner than before, but it is not yet the single execution authority.

### Target Direction

For each workflow:

1. start from one workflow kind
2. ask the controller for the next step
3. instantiate only that step's task
4. map the task result into an event
5. apply the event through the transition engine
6. repeat until complete or stopped

### Success Criteria

- workflow execution order is derived from `nextStep`, not pre-wired task registration
- task-group callback logic becomes minimal or disappears
- invalid transitions fail loudly and are easy to audit

## Priority 2: Derive the Tool Allowlist from Step State

### Goal

Let the workflow controller determine which tools are available for each active step.

### Why This Matters

Tasks are already much narrower than the old top-level agent, but each task still exposes a hand-built bundle of tools.

The stronger pattern is:

- current state determines current step
- current step determines allowed tools
- disallowed actions are impossible rather than merely discouraged by prompt text

### Target Direction

Examples:

- identity step exposes only identity tools and safe routing actions
- existing-appointment step exposes only refresh/select actions
- booking step exposes only the booking action for the already selected slot
- cancellation step exposes only the cancellation action for the already selected appointment

### Success Criteria

- task tool surfaces are generated from canonical state/step rules
- fewer ad hoc task-specific allowlists exist
- wrong-step tool calls become structurally impossible

## Priority 3: Add Explicit Unhappy-Path States and Events

### Goal

Make failure and recovery paths first-class parts of the workflow model.

### Why This Matters

Happy-path state is much better than before, but reliability depends on what happens when the world is messy.

The next level requires explicit handling for:

- stale or rejected slot booking
- API timeout or tool failure
- verification retries exhausted
- patient switch mid-flow
- caller changing intent mid-workflow
- transfer escalation when recovery fails

### Target Direction

Add events and state branches for:

- recoverable retry
- stop-and-ask-clarification
- stop-and-transfer
- restart-from-earlier-step
- abandon-current-selection

### Success Criteria

- major failure modes have named transitions
- fallback behavior is visible in code and tests
- fewer recoveries rely on prompt improvisation

## Priority 4: Build Replay and Eval Coverage from Real Calls

### Goal

Turn the architecture into something measurable, not just cleaner.

### Why This Matters

State-of-the-art reliability is not only about code structure. It also requires repeatable evaluation against realistic failure cases.

### Target Direction

Create replay or scripted eval suites that measure:

- wrong-tool calls
- skipped prerequisites
- duplicate booking attempts
- booking-before-selection
- cancel-before-replacement in reschedule
- incorrect office routing
- invalid transition attempts
- transfer overuse or underuse

### Success Criteria

- predeploy evals run on known difficult transcripts
- failures are tied to explicit architecture regressions
- tool reliability is measured over time, not inferred

## Priority 5: Separate Control State from Summary State More Strictly

### Goal

Make the transition engine depend only on canonical control state.

### Why This Matters

The rewrite already improved state structure, but some fields still exist partly for summaries, prompt context, or observability.

The controller should primarily depend on fields such as:

- resolved patient identity
- allowed registration status
- active workflow step
- selected slot
- selected appointment
- effective office

Derived fields should remain available for prompts and debugging, but they should not quietly become control dependencies.

### Success Criteria

- transition logic depends only on canonical control fields
- summary/debug fields are clearly labeled as derived
- prompt summaries can evolve without destabilizing control logic

## Recommended Sequence

1. Controller-driven workflow runner
2. Step-derived tool allowlists
3. Explicit unhappy-path transitions
4. Replay/eval coverage from real calls
5. Deeper control-vs-derived state cleanup

## Non-Blocking Ideas

These are useful, but they are behind the priorities above:

- opaque slot or appointment handles instead of raw scheduling parameters
- more aggressive context compaction between steps
- provider-specific eval packs
- voice-turn retuning tied to workflow phase

## Launch Recommendation

Do not block the current launch on this document.

The current code is already materially better than the status quo.

Use this as the next roadmap after the launch-safe hardening now in the branch.
