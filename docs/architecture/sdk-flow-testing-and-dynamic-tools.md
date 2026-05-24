# SDK Flow Testing and Dynamic Tool Exposure

Status: implemented by default for flow-harness trunks.

## Purpose

The current flow harness has code-owned state and wrapper-level tool guards, but
the model can still see a broad tool set. That makes the prompt carry too much
responsibility and forces the wrappers to catch avoidable bad calls.

This spec covers the next two changes:

1. Add LiveKit SDK-level tests around the actual agent/session/tool loop.
2. Replace the always-broad harness tool set with flow-state-specific dynamic
   tool exposure.

The intended result is a smaller model-facing action space per turn while
keeping the existing TypeScript guards as the final authority.

## Current Runtime Shape

- `AgentSession<CallState>` is created in `src/main.ts`.
- `session.userData.flow` is initialized before `session.start`.
- `Agent.onUserTurnCompleted` injects a turn-state packet and requires
  `record_turn_understanding` before any other guarded tool for the latest user
  transcript.
- `buildToolsForTrunk` exposes the safe fallback tool set for a
  harness-enabled trunk.
- On startup and after each state update, harness-enabled calls refresh to the
  current flow-state-specific tool set.
- `evaluateTurnUnderstandingGate` and `evaluateFlowToolPolicy` block unsafe tool
  calls after the model attempts them.
- `parallelToolCalls` is currently enabled in the Baseten generation options.

That is a useful safety layer, but it is not the cleanest interaction contract:
the model sees tools it should not be considering for the current state.

## Goals

- Exercise the real LiveKit tool loop with `voice/testing` instead of only
  calling tool `execute` functions directly.
- Prove `record_turn_understanding` remains the first state update for
  harness-enabled turns.
- Prove when dynamic tool changes become visible to the LLM in a LiveKit run.
- Reduce the visible tool set by flow step and pending action state.
- Keep all existing policy guards in place. Dynamic tool exposure is a UX and
  latency control, not the security boundary.

## Non-Goals

- Do not migrate providers.
- Do not depend on unreleased `livekit/agents-js` `main`.
- Do not remove `RUNBOOK.md` in this change.
- Do not introduce multi-agent handoffs or `AgentTask` yet. Those can follow
  once the dynamic tool contract is verified.
- Do not globally disable `parallelToolCalls` as the first fix. We should keep
  the setting unless SDK-level tests or call traces prove it is unsafe after
  tool exposure is narrowed.

## LiveKit APIs To Use

These APIs are present in the installed `@livekit/agents@1.4.4` package:

- `voice/testing` exports `FakeLLM`, `RunResult`, and event assertions.
- `voice.Agent.updateTools(tools)` updates an agent's tool context.
- `voice.AgentSession.currentAgent` exposes the current agent.
- Tool `RunContext` exposes `ctx.session`, `ctx.userData`, and the current
  speech handle.

Implementation must keep these API assumptions covered by tests. If the SDK
behavior differs in a future release, tests should fail before production calls
do.

## Phase 1: SDK-Level Flow Tests

### New Test File

Add `src/__tests__/agent-session-flow.test.ts`.

The tests should use LiveKit's `voice/testing` package and should run through a
real `AgentSession` where feasible. The pure reducer/tool tests stay in place;
these new tests cover SDK integration behavior.

### Test Harness

Create small test helpers rather than using production SIP/audio setup:

```ts
interface AgentSessionFlowFixture {
  session: voice.AgentSession<CallState>;
  agent: Agent;
  state: CallState;
}

function createAgentSessionFlowFixture(
  options?: {
    flowHarnessEnabled?: boolean;
    initialStep?: CallFlowState["step"];
    llmResponses?: FakeLLMResponse[];
  },
): AgentSessionFlowFixture;
```

If `Agent.onEnter()` requires real TTS because it calls `session.say`, add a
test-only constructor option such as `suppressGreeting?: boolean` and use it
only in tests. Do not add a separate production agent path.

### Required Tests

1. **Harness requires turn understanding first**
   - Given a harness-enabled call with `latestUserTranscript` set and
     `turnUnderstandingAppliedForTranscript` unset.
   - Fake LLM attempts `lookup_knowledge` or `verify_patient` first.
   - Assert the tool output is `not_allowed` with
     `reason: "turn_understanding_required"`.

2. **State update allows the next tool**
   - Fake LLM calls `record_turn_understanding` for the latest user turn.
   - The flow state advances to the expected step.
   - A subsequent tool call that is valid for that step can execute or reaches
     its next deeper policy gate.

3. **Harness disabled keeps legacy behavior**
   - With `flowHarnessEnabled: false`, a lookup/verification tool should not be
     blocked by `turn_understanding_required`.

4. **Dynamic update spike**
   - During a single `session.run`, call `record_turn_understanding`.
   - From that tool execution, refresh the current agent's tools.
   - Assert and document whether the next model/tool continuation in the same
     user turn sees the new tool set.

   Current SDK finding: `Agent.updateTools` updates the agent's future tool
   context, but the already-running LLM continuation keeps the tool context
   captured at the start of the run. Phase 2 therefore keeps wrapper gates as
   the state-update enforcement point and exposes `record_turn_understanding`
   alongside the current step's safe tool set while a turn update is pending.

5. **Parallel side effects remain guarded**
   - Simulate multiple side-effect tool calls in one model step if the test
     framework supports it.
   - Assert existing in-flight or pending-action guards still prevent duplicate
     transfer, duplicate booking, or duplicate side effects.

### Acceptance Criteria

- `pnpm test` includes the new SDK-level file.
- The new tests fail if `record_turn_understanding` can be skipped.
- The new tests fail if the documented dynamic-tool visibility point changes.
- The old direct tool/reducer tests remain intact.

## Phase 2: Dynamic Tool Exposure

### Design Principle

The model should see only tools that are plausible for the current state. The
wrappers still validate every call because tool visibility can lag state,
parallel tool calls can race, and future SDK behavior can change.

### New Module

Add `src/tooling/tool-registry.ts` or `src/flow/tool-availability.ts`.

Suggested public API:

```ts
export type AgentToolName =
  | "record_turn_understanding"
  | "verify_patient"
  | "add_patient"
  | "update_insurance"
  | "get_availability"
  | "confirm_appt"
  | "cancel_appt"
  | "add_patient_note"
  | "book_appt"
  | "check_insurance"
  | "lookup_knowledge"
  | "route_to_spring_hill"
  | "transfer_call";

export interface ToolExposureInput {
  state: CallState;
  trunkPhone?: string;
}

export interface ToolExposureDecision {
  tools: Partial<Record<AgentToolName, llm.Tool>>;
  visibleToolNames: AgentToolName[];
  hiddenToolNames: AgentToolName[];
  reason: string;
}

export function buildToolsForState(
  input: ToolExposureInput,
): ToolExposureDecision;
```

Keep the current `buildToolsForTrunk` behavior for non-harness calls.

### Runtime Refresh Points

Refresh visible tools at these points:

- After `session.userData` is initialized, before `session.start`.
- At the start of each user turn, after `latestUserTranscript` is recorded.
- Immediately after `record_turn_understanding` mutates flow state.
- After any tool mutates patient, scheduling, availability, pending-action, or
  transfer state.

Suggested helper:

```ts
export async function refreshAgentToolsForState(
  ctxOrSession: RunContext<CallState> | voice.AgentSession<CallState>,
): Promise<void> {
  const session = "session" in ctxOrSession ? ctxOrSession.session : ctxOrSession;
  const decision = buildToolsForState({ state: session.userData });
  await session.currentAgent.updateTools(decision.tools);
}
```

The helper should be defensive: if no current agent exists yet, return without
throwing and let startup apply the initial tool set.

### Pending-Turn Tool Set

When harness is enabled and the latest user transcript has not been recorded:

- Show `record_turn_understanding` first.
- Also show the current flow step's safe tool set.
- Keep wrapper-level `turn_understanding_required` gates on all guarded tools.

This is required because the LiveKit SDK captures tool context for the current
LLM run before `record_turn_understanding` executes. If every other tool were
hidden, the post-record continuation in that same run would still be unable to
use newly exposed tools. The state-update gate remains the authority: if the
model attempts another guarded tool before recording the turn, the wrapper
returns `turn_understanding_required`.

### Post-Understanding Tool Map

Start with a conservative map derived from `directivesForFlowState`, translated
from model actions into real tool names.

| Flow step | Visible tools after turn understanding |
| --- | --- |
| `understand_intent` | `lookup_knowledge` |
| `triage_visit_type` | `lookup_knowledge` |
| `check_insurance` | `check_insurance`, `lookup_knowledge` |
| `route_office` | `route_to_spring_hill`, `lookup_knowledge` |
| `verify_patient` | `verify_patient`, `confirm_appt`, `lookup_knowledge` |
| `collect_registration` | `add_patient`, `check_insurance`, `lookup_knowledge` |
| `get_availability` | `get_availability`, `lookup_knowledge` |
| `confirm_booking` | `book_appt`, `get_availability`, `lookup_knowledge` |
| `confirm_cancel` | `cancel_appt`, `confirm_appt`, `lookup_knowledge` |
| `handoff` | `transfer_call`, `lookup_knowledge` |
| post-booking note state | `add_patient_note`, `lookup_knowledge` |

Rules layered on top of the table:

- `record_turn_understanding` is visible only when a latest user transcript is
  pending, or in tests that explicitly need it.
- `route_to_spring_hill` is visible only when the active office feature allows
  it and the flow state needs that routing path.
- `transfer_call` is visible only from `handoff` or an explicit confirmed
  transfer pending action.
- `book_appt` is visible only when there is current availability state and the
  flow is in booking confirmation.
- `add_patient_note` is visible only after a successful booking and only when
  the required note fields are grounded.
- Unknown/default states expose only `lookup_knowledge` after turn
  understanding.

### Logging and Telemetry

Each refresh should log a compact line:

```txt
[flow-tools] visible=["record_turn_understanding"] reason="turn_update_pending"
```

Do not log patient IDs, appointment IDs, DOB, member IDs, or raw transcripts.

Add the latest exposure decision to `session.userData` only if it helps debug
tests or production calls. If added, keep it redacted:

```ts
latestToolExposure?: {
  visibleToolNames: AgentToolName[];
  reason: string;
  step: CallFlowState["step"];
  activeIntent: CallFlowState["activeIntent"];
};
```

### Error Handling

If dynamic tool building throws, do not crash the call. Fall back to the current
legacy harness tool set and log:

```txt
[flow-tools] fallback reason="tool_exposure_error"
```

The wrappers still enforce policy, so fallback is safer than ending a live call.

## Rollout Plan

1. Add SDK-level tests without changing runtime behavior.
2. Add pure `buildToolsForState` tests.
3. Add the dynamic update spike test.
4. Wire startup and post-`record_turn_understanding` refresh for every
   flow-harness call.
5. Run synthetic tests and one manual SIP call on the dev trunk.
6. If stable, broaden `FLOW_HARNESS_TRUNK_PHONES` to the next controlled trunk.
7. Keep wrapper policy guards as the fallback authority if SDK tool refresh
   fails.

## Open Questions

- `Agent.updateTools` currently affects future generations/runs, not the
  already-running LLM continuation.
- Should `lookup_knowledge` be visible before turn understanding for pure FAQs,
  or should every caller turn still pass through the state reducer first?
- Should `confirm_appt` remain visible in `verify_patient`, or should it require
  verified/matched patient state plus appointment-management intent?
- Do we need a small "state-update prepass" if same-turn dynamic updates do not
  work reliably?

## Done Definition

- SDK-level tests cover first-tool gating and current SDK dynamic refresh
  behavior.
- The model-visible tool set changes based on flow state for every
  flow-harness call.
- Wrapper-level policy behavior is unchanged and still tested.
- Call logs show visible tool names and refresh reasons without PII.
- No provider migration, runbook deletion, or handoff/task refactor is bundled
  into this change.
