# Staff Task Intake Spec

Status: proposal

## Goal

Turn calls that are outside the agent's completion scope into structured staff
tasks instead of defaulting to a live transfer.

The caller should feel heard, staff should receive a usable request, and the
portal should make the unresolved work visible until someone closes it.

## Principle

The agent has three outcomes:

1. Complete the request.
2. Create a staff task.
3. Transfer only when live human help is truly required.

Tasks are not a second transcript log. They are a compact work queue for the
office.

## Non-Goals

- Do not build a full ticketing system in v1.
- Do not add assignment rules, SLA timers, internal comments, or automation
  chains before staff prove the inbox is useful.
- Do not let the agent promise clinical action, prescription approval, billing
  adjustment, or same-day completion.
- Do not route emergencies, urgent symptoms, or caller-insisted live handoffs
  into tasks.

## Task vs Transfer

Create a task when the request is real office work, but does not require a live
person during the call:

- billing questions or billing callback requests
- optical order status, glasses, contacts, or prescription copy requests
- prescription refill messages or medication questions for staff follow-up
- medical records, paperwork, forms, or document requests
- surgery coordinator messages that are not urgent symptoms
- requests for a named person when a callback is acceptable
- general callback requests after the agent has gathered the need

Transfer when:

- the caller reports emergency symptoms or urgent clinical risk
- the caller repeatedly asks for a human now
- the caller is returning a call and the office policy requires live routing
- the request cannot be safely captured as a message
- the agent cannot gather enough callback context

## Model-Facing Tool

Add one model-callable tool:

```txt
create_staff_task
```

Purpose:

```txt
Create a staff follow-up task after gathering and reading back the caller's
request.
```

Parameters:

```ts
parameters: z.object({
  category: z.enum([
    "billing",
    "optical",
    "prescription",
    "records_forms",
    "surgery",
    "callback",
    "other",
  ]),
  priority: z.enum(["routine", "same_day"]),
  summary: z.string().trim().min(1).max(500),
  callerRequest: z.string().trim().min(1).max(1500),
  callbackPhone: z.string().trim().min(7).max(30).optional(),
  requestedPerson: z.string().trim().min(1).max(120).optional(),
  bestCallbackTime: z.string().trim().min(1).max(120).optional(),
})
```

Model contract:

- Try to finish supported front-desk work first.
- Ask what the caller wants the team to know.
- Confirm the summary and callback number before calling the tool.
- Keep `summary` short and staff-ready.
- Put the caller's concrete request in `callerRequest`.
- Use `same_day` only when the caller describes time-sensitive non-emergency
  follow-up. Emergency or urgent clinical symptoms must transfer instead.

Example:

```json
{
  "category": "optical",
  "priority": "routine",
  "summary": "Caller wants a status update on glasses ordered last week.",
  "callerRequest": "Please have optical call me back about whether my glasses are ready.",
  "callbackPhone": "3525550199"
}
```

## Runtime Contract

The tool owns the write path in code:

1. Read `CallState` from `session.userData`.
2. Attach backend-owned facts:
   - `callId`
   - `practiceId` when available
   - active office key
   - caller phone
   - verified patient ID when available
   - verified patient name and DOB when available
   - current appointment context when relevant
3. Generate a task ID or idempotency key.
4. POST the task to the portal immediately.
5. Store the created task receipt in call state.
6. Return speech-ready confirmation.

The task post must not wait for call shutdown analytics. End-of-call ingestion
can later enrich the linked call row, but the task should exist as soon as the
caller is told it was sent.

If the portal post fails, the tool should say it could not send the message and
offer transfer or a callback alternative based on office policy. It should not
pretend the task was created.

## Portal Endpoint

Add one endpoint in `acuity_site`:

```txt
POST /api/livekit/tasks
```

Authentication:

- Reuse the LiveKit forward-sync bearer secret.

Request shape:

```ts
{
  taskId?: string;
  idempotencyKey: string;
  callId: string;
  practiceId?: string;
  officeKey?: string;
  category: TaskCategory;
  priority: TaskPriority;
  summary: string;
  callerRequest: string;
  callerPhone?: string;
  callbackPhone?: string;
  requestedPerson?: string;
  bestCallbackTime?: string;
  patient?: {
    id?: string;
    firstName?: string;
    lastName?: string;
    dob?: string;
  };
  source: "agent";
}
```

Response shape:

```ts
{
  status: "created" | "duplicate";
  taskId: string;
  category: TaskCategory;
  priority: TaskPriority;
}
```

The portal should resolve practice the same way call ingestion does: explicit
`practiceId` first, then office phone or call context when available.

## Data Model

V1 table:

```txt
AgentTask
  id
  practiceId
  callId
  status
  category
  priority
  officeKey
  summary
  callerRequest
  callerPhone
  callbackPhone
  requestedPerson
  bestCallbackTime
  patientId
  patientName
  patientDob
  source
  createdAt
  updatedAt
  completedAt
```

Statuses:

```txt
open
in_progress
done
closed_no_action
```

Categories:

```txt
billing
optical
prescription
records_forms
surgery
callback
other
```

Priorities:

```txt
routine
same_day
```

Do not add owner, comments, SLA due dates, or notifications in v1 unless staff
cannot use the inbox without them.

## Portal UI

Add a portal page:

```txt
/portal/tasks
```

Default view:

- open tasks first
- grouped by category
- filters for status, category, office, and priority
- newest first inside each group

Task row:

- category
- priority
- patient or caller
- office
- one-line summary
- created time
- status control

Task detail:

- full caller request
- callback phone
- best callback time
- requested person
- linked call detail page
- patient snapshot
- transcript excerpt or call link when available

The call detail page should also show linked tasks so staff reviewing a call can
see whether follow-up was created.

## Prompt Behavior

The prompt should teach a simple pattern:

```txt
If the request is outside what you can complete, offer to send a message to the
team. Ask what the caller wants the team to know, confirm the message and
callback number, then create a staff task.
```

Caller-facing wording:

```txt
I can send that to the team. What would you like them to know?
```

Readback:

```txt
I will send the team this message: [summary]. The callback number I have is
[phone]. Is that right?
```

Confirmation:

```txt
I sent that to the team. They will review it and follow up.
```

Avoid promising:

- exact callback time
- prescription approval
- billing correction
- clinical advice
- that a named staff member personally received it

## Observability

Agent call observability should classify `create_staff_task` results:

```txt
staff_task_created
staff_task_duplicate
staff_task_failed
```

Portal analytics should show:

- task count by category
- tasks created per call count
- transfer count before and after launch
- task completion time
- same-day task backlog

This is the feedback loop for deciding what the agent should automate next.

## Acceptance Tests

Agent:

- `create_staff_task` posts the expected JSON with bearer auth.
- backend-owned fields are attached from `CallState`.
- duplicate task creation in one call returns the existing receipt.
- portal failure does not mark the task as created.
- emergency or caller-insisted live handoff language remains covered by
  `transfer_call`.

Portal:

- unauthenticated task POST is rejected.
- authenticated task POST creates an `AgentTask`.
- repeated idempotency key returns the existing task.
- task links to an existing `AgentCall` by `callId` when present.
- tasks page filters by status, category, office, and priority.
- task status transitions persist.

## Rollout

1. Build the portal endpoint, table, and inbox first.
2. Add the agent poster and `create_staff_task` tool behind a feature flag.
3. Update `transfer_call` wording so task-worthy work no longer routes straight
   to live handoff.
4. Review real calls for one week:
   - tasks staff trusted
   - tasks staff had to reopen or ignore
   - categories that should be split or removed
5. Only then add owner assignment, notifications, due dates, or category-specific
   workflow.

## Clean V1

The smallest useful version is:

```txt
one tool
one endpoint
one table
one inbox
one call link
four statuses
seven categories
two priorities
```

Anything beyond that should be justified by real staff usage.
