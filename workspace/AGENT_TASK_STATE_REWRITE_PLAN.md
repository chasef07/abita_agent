# Agent Rewrite Plan: State, Context, Tasks, and Tool Ergonomics

## Goal

Rewrite the scheduling agent so it behaves like a reliable front-desk workflow system instead of a single prompt trying to carry every rule at once.

The target outcome is:

- stronger workflow correctness
- fewer invalid tool calls
- fewer availability loops
- less rigidity during conversation
- smaller and more focused active prompts
- better recovery when the caller changes direction or corrects earlier information

## Core Design Shift

Current design:

- one main agent
- one large prompt
- all tools exposed at once
- `session.userData` used mostly as hidden metadata
- workflow correctness carried mostly by prompt instructions

Target design:

- one long-lived `FrontDeskAgent`
- focused `AgentTask`s for structured work
- `beta.TaskGroup` for multi-step scheduling workflows
- `session.userData` as authoritative hidden workflow state
- layered context engineering instead of one monolithic prompt
- more agent-friendly tools that are harder to misuse

## State Of The Art Principles

1. Use workflows for predictable multi-step operations.
2. Use tasks for short-lived structured work.
3. Keep one long-lived agent unless the role, permissions, or reasoning behavior truly changes.
4. Treat tools like an interface for a non-deterministic system: make them easy to choose and hard to misuse.
5. Layer context. Do not dump everything into one prompt.
6. Prompts should define tone and local step behavior, not be the only source of workflow correctness.

## Architecture Recommendation

### Keep One Long-Lived Agent

`FrontDeskAgent`

Responsibilities:

- greet callers
- capture intent
- answer quick office questions
- decide when a transfer is needed
- launch tasks or task groups for structured flows
- resume normal conversational control after task completion

The rewrite should not introduce a large family of specialized workflow agents unless there is a real role boundary.

Use separate agents only if the system later needs genuinely distinct behavior such as:

- billing specialist
- clinical triage specialist
- after-hours escalation agent

For scheduling and registration, tasks are the better fit.

### Phase-Specific Conversation Mechanics

Conversational smoothness should vary by workflow phase.

Do not use one global pacing style for the whole call.

#### Router / FAQ phase

- faster back-and-forth
- more interruptible
- short answers
- quick routing into workflows when needed

#### Identity / Registration phase

- more patient pacing
- fewer interruptions
- less eagerness to jump in while the caller is giving names, dates, addresses, phone numbers, emails, or member IDs
- quieter acknowledgments and clearer field-by-field progress

#### Booking / Confirmation / Cancellation phase

- concise and efficient
- slower and more deliberate when confirming a selected slot, appointment details, or a write action
- higher confidence, lower chatter

## Tasks-First Workflow Design

### `IdentifyPatientTask`

Purpose:

- resolve who the active patient is
- determine whether the call is existing-patient flow, multiple-match flow, true new-patient flow, or switched-patient flow

Tools exposed:

- `verify_patient`

Writes to state:

- identity state
- verification state
- whether registration is allowed

Completes when:

- the patient is identified enough to continue, or
- registration is explicitly allowed

### `RegistrationTask`

Purpose:

- collect new-patient fields
- perform insurance normalization
- create the patient record

Tools exposed:

- `check_insurance`
- `add_patient`

Writes to state:

- registration state
- patient identity
- insurance state

Completes when:

- required fields are collected and confirmed
- `add_patient` succeeds

### `VisitReasonTask`

Purpose:

- capture the reason for visit before availability search

Tools exposed:

- none initially

Writes to state:

- scheduling reason state

Completes when:

- the reason is clear enough to schedule

### `AvailabilityTask`

Purpose:

- search one date at a time
- present options
- move toward one selected slot

Tools exposed:

- `get_availability`

Writes to state:

- last availability query
- last availability summary
- current selected slot candidate

Completes when:

- a slot is selected, or
- the task needs to regress because the caller changed date or constraints

### `BookingTask`

Purpose:

- confirm and book the selected slot

Tools exposed:

- `book_appt`

Writes to state:

- selected slot fingerprint
- booked slots this call
- appointments state

Completes when:

- booking succeeds

### `ExistingAppointmentTask`

Purpose:

- identify which existing appointment the caller means for confirmation, cancellation, or rescheduling

Tools exposed:

- `confirm_appt`

Writes to state:

- appointments
- target appointment
- appointment intent

Completes when:

- the active appointment is identified

### `CancelAppointmentTask`

Purpose:

- cancel the already-identified appointment

Tools exposed:

- `cancel_appt`

Writes to state:

- appointments
- target appointment

Completes when:

- cancellation succeeds

## Task Groups

### `ScheduleTaskGroup`

Ordered tasks:

1. `IdentifyPatientTask`
2. `RegistrationTask` if needed
3. `VisitReasonTask`
4. `AvailabilityTask`
5. `BookingTask`

Use this when the caller wants to schedule a new or existing appointment.

This group should support regression when the caller:

- changes the patient
- changes the date
- clarifies the visit reason
- corrects earlier information

### `RescheduleTaskGroup`

Ordered tasks:

1. `IdentifyPatientTask`
2. `ExistingAppointmentTask`
3. `VisitReasonTask` if needed
4. `AvailabilityTask`
5. `BookingTask`
6. `CancelAppointmentTask`

Use this when the caller wants to move or change an existing appointment.

This group should support regression when the caller:

- identifies a different appointment
- changes the preferred replacement date
- changes which patient they mean

## Call State Redesign

Replace the mostly flat metadata shape with a layered state model.

### `identity`

- `patientId: string | null`
- `patientName: string | null`
- `dob: string | null`
- `activePatientSource: "phone_lookup" | "verify_patient" | "add_patient" | null`
- `switchedPatientThisCall: boolean`

### `workflow`

- `intent: "unknown" | "faq" | "schedule" | "confirm" | "cancel" | "reschedule" | "transfer"`
- `activeFlow: "none" | "identify" | "register" | "visit_reason" | "availability" | "booking" | "existing_appt" | "cancel"`
- `appointmentIntent: "schedule" | "confirm" | "cancel" | "reschedule" | null`
- `verificationStatus: "not_started" | "single_match" | "multiple_matches" | "verified" | "no_match"`
- `verificationAttempts: number`
- `registrationAllowed: boolean`
- `registrationComplete: boolean`

### `scheduling`

- `reasonForVisit: string | null`
- `lastAvailabilityQuery: { date: string; patientId: string | null; reasonForVisit: string | null; routing: string | null } | null`
- `lastAvailabilitySummary: string | null`
- `lastAvailabilityRaw: unknown | null`
- `selectedSlotToken: string | null`
- `bookedSlotsThisCall: string[]`
- `targetAppointmentToken: string | null`
- `appointments: CallerAppointment[]`

### `conversation`

- `humanRequestCount: number`
- `lastToolCallFingerprint: string | null`
- `transferred: boolean`

## Layered Context Model

Do not inject the full state object into prompts.

Use four layers of context:

### 1. Hidden Control State

Stored in `session.userData`.

This is the source of truth for:

- workflow status
- internal IDs
- loop prevention
- selected resources
- transition validity

The model does not need the raw full object.

### 2. Task-Local Working Summary

A short, human-readable summary generated from state for the active task.

Example:

```text
Current call state:
- office: Spring Hill
- patient status: verified existing patient
- workflow: scheduling
- visit reason: blurry vision follow-up
- already checked: 2026-04-22, no openings
- next step: offer the nearest alternative date and do not re-check 2026-04-22 unless the caller changes the request
```

This should be injected when a task starts and refreshed when the task meaningfully changes state.

### 3. Task Chat Context

Pass the relevant `chatCtx` into tasks and task groups.

Tasks and task groups should not rely on default empty context.

Use:

- shared `chatCtx` where continuity matters
- filtered or truncated copies where the full history is unnecessary
- `summarizeChatCtx` in `TaskGroup` where appropriate

### 4. Tool Return Summaries

Tool responses should return concise, high-signal summaries of what changed.

Do not return raw low-level payloads unless needed.

### 5. Tool Call Preambles

Before any tool call that may create noticeable silence, the active task should say one short preamble.

Examples:

- "let me check that"
- "ok, I'm pulling that up"
- "I'm looking at that now"

Rules:

- use one short line only
- vary the phrasing
- do not over-narrate every internal step
- avoid fake timing promises like "one second" or "this will only take a moment"

## Lifecycle Context And Middleware

The rewrite should treat lifecycle control as a first-class part of the architecture.

This is the layer that manages what happens between:

- user turn completion
- task entry
- model call
- tool call
- tool result
- task completion
- task regression

### Responsibilities

Use lifecycle hooks or middleware-style logic to:

- inject the active task's working-state summary before reply generation
- trim or summarize stale context before it bloats the next model call
- persist important tool results into state
- suppress duplicate or obviously invalid repeated actions
- count failed tool attempts and decide when to regress or escalate
- decide whether a workflow should continue, retry, regress, or stop

### Practical Mapping In This Repo

Use LiveKit lifecycle hooks and context operations for this layer:

- `onUserTurnCompleted` for dynamic context injection and turn-level state shaping
- task completion callbacks for persisting typed results
- `TaskGroup` callbacks for updating workflow state between tasks
- explicit `chatCtx` copies instead of relying on defaults

This layer should own guardrail logic that is broader than any one tool but narrower than the top-level front desk prompt.

## Context Passing Rules

Tasks and task groups must not rely on default empty context.

### Default Rule

When starting a task, pass an explicit `chatCtx` derived from the active agent's current context.

### Passing Strategy

Preferred order:

1. carry the active workflow summary
2. carry the last few relevant user and assistant turns
3. exclude old instructions from prior phases unless they are still relevant
4. exclude stale function call noise when it does not help the next task

### Recommended Patterns

- Use `chatCtx.copy({ excludeInstructions: true })` when passing conversation continuity into a new task
- Use truncation for long calls when only the tail matters
- Use a generated summary plus recent turns when the workflow has become lengthy
- Use shared `TaskGroup` context when regression and correction are expected

### Never Do

- do not pass the entire raw history by default
- do not forward previous workflow instructions blindly
- do not pass stale availability or registration details once the workflow has moved on

## Tool Surface Minimization

Each task should expose the minimum possible tool set.

This is a hard design principle, not just a preference.

### Rules

- `IdentifyPatientTask` sees only identity tools
- `RegistrationTask` sees only registration-related tools
- `AvailabilityTask` sees only availability search tools
- `BookingTask` sees only booking tools
- `CancelAppointmentTask` sees only cancellation tools

### Why

Too many tools or overlapping tool surfaces increase tool-space interference and reduce reliability.

Each task should be able to reason over one narrow action space.

## History Compaction Policy

Long calls should not keep growing without structure.

The rewrite should include an explicit history compaction strategy.

### Always Preserve

- shared persona and voice instructions
- current workflow/task summary
- most recent relevant user and assistant turns
- the currently active scheduling or registration facts

### Compact Or Drop

- stale tool outputs that are no longer actionable
- superseded availability results
- redundant confirmations
- old turns that have already been summarized into state or a task-group summary

### Recommended Trigger Points

- after task completion
- after repeated availability searches
- when the active context exceeds a practical message or token threshold
- before handing control back from a long task group to the front desk agent

### Output Of Compaction

Compaction should produce:

- a concise summary of the finished portion of the workflow
- retention of the latest high-signal turns
- updated hidden state so the next step does not depend on the discarded raw history

## Prompt Refactor

Keep:

- `SOUL.md`
- most of `VOICE.md`

Do not keep one giant workflow runbook.

Do not over-fragment into too many tiny prompt files either.

### Recommended Prompt Structure

#### Shared Base

- persona
- tone
- TTS rules
- basic pacing

#### `ROUTER.md`

- intent capture
- FAQ handling
- transfer rules
- when to launch a workflow task or task group

#### `IDENTIFY_REGISTER.md`

- patient identification rules
- registration collection behavior
- new-patient boundaries

#### `SCHEDULE_RESCHEDULE.md`

- visit reason collection
- availability behavior
- booking and rescheduling flow guidance

Each active task should then receive:

- base prompt
- one local task instruction block
- one working-state summary

## Tool Ergonomics Rewrite

This is a major part of the rewrite.

The current tool contracts are too low-level for optimal agent performance.

### Current Problem

Examples of low-level parameters:

- `book_appt(columnId, profileId, startDatetime, duration, appointmentTypeId)`
- `cancel_appt(appointmentId)`

This forces the model to remember and forward brittle technical details.

### Target Tool Shape

Prefer semantic tool contracts and opaque tokens where possible.

#### `get_availability(...)`

Should return:

- concise slot summaries
- a `slotToken` for each option
- a short natural-language summary for the model

#### `book_appt(slotToken)`

Should accept:

- only the selected `slotToken`

This removes the need for the model to pass multiple raw scheduling parameters.

#### `confirm_appt()`

Should return:

- concise appointment candidates
- an `appointmentToken` for each active appointment

#### `cancel_appt(appointmentToken)`

Should accept:

- only the chosen `appointmentToken`

This makes the tool surface more semantic and less error-prone.

## Tool Guard Plan

### `verify_patient`

On success:

- set verification status to verified
- reset verification attempts
- disable registration
- update identity state

On failure:

- increment verification attempts
- update status to no match or multiple matches
- only allow registration when retry conditions are met or the caller clearly says they are new

### `add_patient`

Reject unless:

- registration is allowed
- no active verified patient is already in flow unless the caller clearly switched patients
- required fields are complete
- insurance has been normalized through `check_insurance`

### `get_availability`

Reject unless:

- patient is identified
- reason for visit is present
- the exact same search has not already been run without new caller input

Persist:

- last availability query
- summary
- raw result

### `confirm_appt`

Persist:

- current appointments into state
- active appointment token if resolved

### `book_appt`

Reject unless:

- patient is identified
- the selected slot came from current availability state
- that slot was not already booked this call
- there is no conflicting appointment unless the workflow is explicit reschedule

Persist:

- booked slot token
- appointments state if available

### `cancel_appt`

Reject unless:

- target appointment has already been identified in state

## Conversational Smoothness Guidance

The rewrite should improve smoothness primarily through architecture, not just warmer wording.

### Prompt Style

Use:

- bullets over paragraphs
- short phase instructions
- varied sample phrases
- explicit variety guidance
- explicit tool-call preambles

Avoid:

- large prose blocks
- overlapping workflow rules repeated in multiple places
- long lists of negative instructions
- fake-time filler like "one second" when actual latency is unpredictable
- verbosity as a substitute for naturalness
- repetitive acknowledgments or repeated sentence patterns

### Smoothness Definition

Smoothness does not mean talking more.

The target is:

- short, grounded spoken turns
- visible progress through the workflow
- natural variation in phrasing
- patient listening during structured info capture
- confident, brief updates before tool calls

The target is not:

- extra explanation
- unnecessary apologies
- long transitional filler
- repeated reassurance on every turn

### Examples

Each prompt module should include short, varied examples for:

- greeting
- clarification
- no availability
- switching patient
- asking for missing registration info
- offering a slot
- moving to a fallback date

## Task Prompt Template

Each task prompt should follow a consistent structure.

### Recommended Template

1. Role

- what the task is currently responsible for

2. Current call state

- compact working-state summary only

3. Goal

- one narrow objective

4. Rules

- local step rules only

5. Sample phrases

- three to five short varied examples

6. Tool preambles

- one to three short varied preambles if the task makes tool calls

7. Exit condition

- when the task should complete or regress

### Example Shape

```text
You are currently handling appointment scheduling.

Current call state:
- patient: verified existing patient
- office: Spring Hill
- visit reason: blurry vision follow-up
- already checked: 2026-04-22, no openings
- next step: offer the nearest alternative and continue toward selecting one slot

Goal:
- move the caller toward one booked appointment

Rules:
- search one date at a time
- do not re-run the same search unless the caller changed the request
- book only after explicit agreement

Sample phrases:
- "nothing open that day, but I've got Thursday morning"
- "ok, the next thing I have is Friday at ten"
- "that day is full, but I can get you in the day after"

Tool preambles:
- "let me check that"
- "ok, I'm looking at that now"
- "pulling that up"

Exit when:
- the caller selects a slot, or
- the caller changes the date or patient and the workflow needs to regress
```

## Start Simple Rule

The rewrite should not overbuild tasks or workflow objects on day one.

Start with the tasks already defined in this plan.

Only add more tasks if:

- a current task stays too broad after implementation
- a repeated failure pattern appears in evaluations or transcripts
- the role or permission boundary truly changes

## File-Level Rewrite Plan

### Keep

- `workspace/SOUL.md`
- `workspace/VOICE.md`

### Add

- `workspace/ROUTER.md`
- `workspace/IDENTIFY_REGISTER.md`
- `workspace/SCHEDULE_RESCHEDULE.md`

### Update

`src/tools.ts`

- redesign `CallState`
- redesign tool contracts where feasible
- add tool guards
- add state write-backs
- add helpers for task summaries and token generation

`src/agent.ts`

- replace single-agent workflow logic with a `FrontDeskAgent` that launches tasks and task groups

`src/prompt.ts`

- stop building one monolithic scheduling runbook
- add helpers for:
  - shared base prompt
  - task instruction block
  - task-local working-state summary

`src/main.ts`

- initialize the expanded state shape
- keep existing session bootstrap

## Rollout Plan

### Phase 1

- redesign `CallState`
- add tool guards
- add state write-backs
- keep the single-agent flow temporarily

### Phase 2

- implement `IdentifyPatientTask`
- implement `RegistrationTask`
- wire them into `FrontDeskAgent`

### Phase 3

- implement `ScheduleTaskGroup`
- move visit reason, availability, and booking into tasks

### Phase 4

- implement `RescheduleTaskGroup`
- move existing appointment changes into tasks

### Phase 5

- simplify remaining prompt files
- remove workflow rules now enforced by code
- add targeted multi-turn tests for each workflow

## Success Criteria

- invalid new-patient registration during existing-patient flow is blocked
- repeated same-date availability loops are blocked
- duplicate slot booking in the same call is blocked
- tasks receive the context they need without inheriting stale or bloated prompts
- the active prompt at each step is substantially smaller than the current monolithic runbook
- scheduling and registration feel more natural because the model is carrying fewer simultaneous rules

## Source Alignment

This rewrite plan is aligned with:

- LiveKit guidance to use tasks and task groups for focused structured work
- LiveKit guidance to explicitly manage `chatCtx` during tasks and handoffs
- Anthropic guidance to prefer workflows for predictable tasks and to design tools ergonomically
- OpenAI guidance to engineer context in layers and avoid giant instruction blobs
- modern voice prompting guidance emphasizing bullets, examples, preambles, and variety

## Sources

### LiveKit

- Tasks and task groups: https://docs.livekit.io/agents/logic/tasks/
- Workflows: https://docs.livekit.io/agents/logic/workflows/
- Agents and handoffs: https://docs.livekit.io/agents/logic/agents-handoffs/
- Chat context: https://docs.livekit.io/agents/logic/chat-context/
- Pipeline nodes and hooks: https://docs.livekit.io/agents/logic/nodes/
- Tool definition and use: https://docs.livekit.io/agents/logic-structure/tools/
- Turns overview: https://docs.livekit.io/agents/build/turns/
- Turn detector plugin: https://docs.livekit.io/agents/logic-structure/turns/turn-detector/
- Testing and evaluation: https://docs.livekit.io/agents/build/testing/

### Anthropic

- Building effective agents: https://www.anthropic.com/research/building-effective-agents
- Writing effective tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents

### OpenAI

- Using realtime models and prompting: https://platform.openai.com/docs/guides/realtime-models-prompting
- Prompting guide: https://platform.openai.com/docs/guides/prompting
- Inside OpenAI’s in-house data agent: https://openai.com/index/inside-our-in-house-data-agent/
- Harness engineering: context management lessons: https://openai.com/index/harness-engineering
- From model to agent: context compaction in long-running tasks: https://openai.com/index/equip-responses-api-computer-environment

### Google ADK

- Context: https://google.github.io/adk-docs/context/
- Sessions, state, and memory: https://google.github.io/adk-docs/sessions/
- State: https://google.github.io/adk-docs/sessions/state/
- Agents: https://google.github.io/adk-docs/agents/

### LangChain

- Context engineering in agents: https://docs.langchain.com/oss/javascript/langchain/context-engineering
- Middleware overview: https://docs.langchain.com/oss/javascript/langchain/middleware/overview
- Deep agents context engineering: https://docs.langchain.com/oss/javascript/deepagents/context-engineering

### Microsoft Research

- Efficient AI applications: context engineering and agents: https://www.microsoft.com/en-us/research/project/efficient-ai-applications-context-engineering-and-agents/
- Tool-space interference: an emerging problem for LLM agents: https://www.microsoft.com/en-us/research/video/tool-space-interference-an-emerging-problem-for-llm-agents/
