# Agent Flow Controller Spine

## Why this exists

Abita's current agent works, but too much business control lives in prompt prose,
tool descriptions, and model judgment. The reliability problem is not only prompt
wording. The agent needs a code-owned workflow spine that decides the current
flow, allowed actions, sequencing rules, routing decisions, and structured tool
outcomes.

The implementation should not use LiveKit Tasks or TaskGroup for this phase.
Those primitives are useful for bounded collection flows, but the core Abita
business rules need to be explicit TypeScript that can be unit-tested without a
voice session.

## Core architecture

```txt
caller audio
  -> STT and language runtime
  -> intent and slot extraction
  -> flow controller
  -> allowed tool or meta-tool
  -> structured outcome
  -> concise spoken response
```

The LLM owns:

- natural conversation
- bilingual phrasing
- empathy and tone
- extracting caller-provided facts
- asking the next human-friendly question

Code owns:

- active flow and step
- required slots
- allowed and blocked tools
- insurance, routing, and scheduling rules
- duplicate tool prevention
- confirmation gates
- transfer and end-call rules
- state updates after tools

## First implementation slice

Build the smallest useful spine first:

1. Add `CallFlowState` to per-call `session.userData`.
2. Add a shared `ToolOutcome` shape for flow/meta-tool decisions.
3. Add a context compiler that can produce a small state packet for the model.
4. Add `prepareSchedulingPath` as the first meta-tool function.
5. Add controller/guard tests around visit triage, insurance, Crystal River
   routing, and scheduling prerequisites.

Do not rewrite every call path at once. Start with:

```txt
visit type -> insurance -> office routing -> scheduling
```

## Current branch state

Branch: `feature/flow-controller-spine`

Implemented:

- `CallFlowState`, `ToolOutcome`, and flow decision types under `src/flow/`.
- `createInitialFlowState` attached to `session.userData.flow` during session
  startup.
- `compileFlowContextPacket` for state-scoped model context.
- `prepareSchedulingPath` for visit triage, insurance/routing normalization,
  Crystal River to Spring Hill routing, urgent handling, and optical-shop
  transfer decisions.
- Shadow observer wiring in `src/main.ts`: final user transcripts generate
  redacted flow predictions, tool executions are compared against the latest
  prediction, and shadow events are sent in the analytics payload under `flow`.
- Flow state hydration from patient lookup/tool results in `src/tools.ts`.
- Tests covering flow state creation, context packet output, scheduling-path
  decisions, shadow mismatches, Spanish routine vision phrases, bare insurance
  questions, and tool-side flow-state hydration.

Important non-goals for the current branch:

- No hard blocking yet.
- No prompt injection of the flow packet yet.
- No LiveKit Tasks or TaskGroup.
- No middleware contract changes yet.

The current slice is a real shadow-mode spine: it observes and records expected
flow decisions without changing what the live model is allowed to do.

## State packet shape

The model should see a small compiled context packet, not the whole business
runbook every turn.

```xml
<flow_state>
activeFlow: scheduling
step: check_insurance
language: es
patientStatus: new
office: crystal-river
visitType: routine_vision
missingSlots: insurancePlan
allowedActions: ask_insurance_plan, check_insurance, prepareSchedulingPath
blockedActions: add_patient, get_availability, book_appt, cancel_appt
</flow_state>

<current_objective>
Collect the exact vision insurance plan, then check routine vision coverage.
</current_objective>
```

Keep the stable prompt prefix stable for caching. Put dynamic state later in the
context. Do not inject raw caller text or raw tool output into high-priority
instructions.

## Structured outcome shape

Every meta-tool should return the same shape:

```ts
type ToolOutcome = {
  outcome:
    | "success"
    | "needs_clarification"
    | "not_found"
    | "not_allowed"
    | "route_required"
    | "transfer_required"
    | "error";
  nextStep: FlowStep;
  statePatch?: Partial<CallFlowState>;
  speak?: string;
  facts?: Record<string, unknown>;
  retryable?: boolean;
};
```

## First meta-tool

`prepareSchedulingPath` should classify and normalize the fragile business
sequence before the model starts calling patient or scheduling tools.

Inputs:

```ts
{
  officeKey: OfficeKey;
  patientStatus: "unknown" | "matched" | "verified" | "new";
  visitReason?: string;
  insurancePlan?: string;
  coverageType?: "medical" | "routine_vision";
}
```

Responsibilities:

- classify medical vs routine vision vs optical-shop vs urgent
- choose medical or routine vision coverage
- recognize Crystal River routine vision as a Spring Hill routing case
- recognize plans rejected locally but accepted at Spring Hill
- return `needs_clarification` when visit type or plan is not specific enough
- return concise `speak` guidance that the LLM can translate and shorten

## Rollout posture

Ship in phases:

1. Shadow mode: compute expected next action, do not block.
2. Soft guards: return structured `not_allowed` instead of executing bad calls.
3. First enforced path: routine vision and Crystal River to Spring Hill routing.
4. Prompt cleanup: remove duplicated business rules only after tests and evals
   prove the code-owned flow works.

## Next implementation step

The next step is not prompt cleanup. It is **shadow telemetry review + soft
guard preparation**.

Build this next:

1. Add a small `applyToolOutcomeToFlowState` helper so all state patches go
   through one tested path instead of each tool mutating `flow` directly.
2. Add `guardToolCall` in report-only mode. It should compute whether a tool is
   currently allowed and return a structured observation, but it must not block
   the tool yet.
3. Add report-only guard checks for the first risky tools:
   - `check_insurance`
   - `route_to_spring_hill`
   - `add_patient`
   - `get_availability`
   - `book_appt`
4. Add analytics fields:
   - `flow.currentState`
   - `flow.shadowEvents`
   - `flow.guardObservations`
   - `flow.mismatchCount`
5. Add tests proving valid paths are allowed and invalid paths are only reported,
   not blocked.

Only after this is visible in real call traces should we turn any guard into a
soft `not_allowed` response.

The first guard to enforce later should be narrow: **do not call
`get_availability` for routine vision on Crystal River until
`route_to_spring_hill` has switched the active office**.

## Path to completion

1. **Shadow spine** — current branch.
   - Flow state, context compiler, `prepareSchedulingPath`, shadow predictions,
     tool observations, analytics payload fields, and tests.

2. **Report-only guards** — next branch/slice.
   - Add `guardToolCall` without blocking.
   - Record tool name, allowed/blocked status, reason, expected step, actual
     step, and flow state.
   - Start with `check_insurance`, `route_to_spring_hill`, `add_patient`,
     `get_availability`, `book_appt`, and `cancel_appt`.

3. **Real call review**.
   - Review analytics for shadow mismatches, guard violations, repeated tool
     calls, skipped insurance checks, bad Crystal River routing, premature
     registration, and booking before confirmation.

4. **First enforced guard**.
   - Enforce only one narrow rule first: Crystal River routine vision cannot
     call `get_availability` until `route_to_spring_hill` switches the active
     office.
   - Return a structured `not_allowed` outcome, not an exception.

5. **Insurance and registration sequencing guards**.
   - New patient scheduling cannot call `add_patient` before `check_insurance`.
   - Routine vision must use `coverageType: "routine_vision"`.
   - Bare insurance questions must triage medical vs routine vision first.
   - Unclear insurance plans must not proceed to registration.

6. **Scheduling sequencing guards**.
   - No `get_availability` before visit reason.
   - No `book_appt` before patient verification or creation.
   - No `book_appt` without recent availability and caller confirmation.
   - No duplicate same tool/same args unless caller changed the request.
   - No `cancel_appt` before appointment lookup and explicit cancellation
     confirmation.

7. **Context packet injection**.
   - Inject the compiled flow packet into model-visible context after guard
     observations look sane.
   - Keep the base prompt stable and put dynamic state later in context.

8. **Prompt cleanup**.
   - Remove duplicated business sequencing from `RUNBOOK.md` and tool
     descriptions once code owns those rules.
   - Keep prompt content focused on voice, tone, language switching, and current
     objective.

9. **Structured tool outcomes everywhere**.
   - Gradually normalize real tool responses into `ToolOutcome`.
   - Suggested order: `check_insurance`, `route_to_spring_hill`,
     `get_availability`, `add_patient`, `book_appt`, `cancel_appt`,
     `verify_patient`, `lookup_knowledge`, `transfer_call`.

10. **Additional meta-tools**.
    - Keep `prepareSchedulingPath` as the first meta-tool.
    - Add only if repeated traces justify them: `prepareNewPatientRegistration`,
      `prepareAppointmentBooking`, `prepareCancellation`, `prepareTransfer`.

11. **Decision-point evals**.
    - Build 20 focused cases first:
      - 5 insurance/routine vision
      - 5 Crystal River routing
      - 5 new patient registration
      - 3 booking confirmation
      - 2 cancellation/transfer
    - Assert flow step, allowed tool, blocked tool, state patch, and spoken
      response category.

12. **Gradual enforcement**.
    - Enforce guards in this order:
      - Crystal River routine vision route before availability.
      - No `add_patient` before insurance check.
      - No `book_appt` before verified/created patient.
      - No `book_appt` before confirmation.
      - No duplicate same tool/same args.
      - No `cancel_appt` before cancellation confirmation.

13. **Analytics visibility**.
    - Each call should show current flow state, shadow predictions, actual tool
      calls, guard observations, blocked actions, and final outcome.

14. **Completion criteria**.
    - Prompt is smaller and no longer owns business sequencing.
    - Tool results are structured.
    - Controller owns routing and scheduling gates.
    - Evals cover risky flows.
    - Live traces show fewer skipped insurance/routing/booking mistakes.
    - Transfers and unresolved calls do not increase.
    - No meaningful latency regression.

## Plan review verdict

Reviewed against the research/source material, this plan is still the right
direction. The important choice is to make code-owned state, report-only guards,
and structured outcomes the control plane before changing the prompt.

Keep these constraints:

- Do not make prompt text the source of truth for business sequencing.
- Do not inject raw caller transcript text or raw tool output into high-priority
  instructions.
- Do not assume dynamic LiveKit tool filtering is available until verified
  against the installed SDK and current docs; use report-only guards first.
- Do not build speculative meta-tools. Add meta-tools only when traces show a
  repeated tool sequence worth collapsing.
- Do not use LiveKit `TaskGroup` as the top-level flow owner. It can be
  revisited later for bounded collection flows, but not for routing, insurance,
  booking, cancellation, or transfer policy.

## Source context

- State-driven workflow grounding: https://arxiv.org/abs/2403.11322
- Meta-tools for repeated agent workflows: https://arxiv.org/abs/2601.22037
- Context engineering for agents: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- OpenAI context management split between local context and model-visible
  context: https://openai.github.io/openai-agents-js/guides/context/
- OpenAI agent safety guidance on prompt injection, structured outputs, and
  evals: https://platform.openai.com/docs/guides/agent-builder-safety
- LangChain context engineering patterns for state-aware prompts and tools:
  https://docs.langchain.com/oss/python/langchain/context-engineering
- LiveKit Tasks/TaskGroup docs reviewed but intentionally not used in this
  phase: https://docs.livekit.io/agents/logic/tasks.md
