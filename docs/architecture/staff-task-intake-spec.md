# Staff Task Intake Spec

Status: proposal

## Goal

Turn office work the agent cannot complete live into structured staff tasks in
the Acuity portal.

The agent should ask the caller what exactly they need, capture the request in a
staff-ready shape, and send it to the correct practice/location in the portal
immediately. The portal should then bucket and group the work so staff can review
open tasks by category.

## Principle

The agent has three outcomes:

1. Complete the request.
2. Create a staff task.
3. Transfer only when live human help is truly required.

Tasks are not a second transcript log and not a full ticketing system. They are a
compact message-capture queue for office work that cannot be finished by the
agent.

## Non-Goals

- Do not build a full ticketing system in v1.
- Do not add assignment rules, SLA timers, internal comments, or automation
  chains before staff prove the inbox is useful.
- Do not let the agent promise clinical action, prescription approval, billing
  adjustment, or same-day completion.
- Do not route emergencies, urgent symptoms, or caller-insisted live handoffs
  into tasks.
- Do not create tasks for work the agent can already complete safely, such as
  supported scheduling, cancellation, rescheduling, insurance checks, or office
  facts.

## Task vs Transfer

Create a task when the request is real office work, the agent cannot complete it,
and the caller can safely leave a message:

- billing questions or billing callback requests
- optical order status, glasses, contacts, or prescription copy requests
- prescription refill messages or medication questions for staff follow-up
- medical records, paperwork, forms, or document requests
- surgery coordinator messages that are not urgent symptoms
- requests for a named person when a message or callback is acceptable
- general callback requests after the agent has gathered the need
- other non-urgent office work that staff should review

Transfer when:

- the caller reports emergency symptoms or urgent clinical risk
- the caller repeatedly asks for a human now
- the caller is returning a call and office policy requires live routing
- the request cannot be safely captured as a message
- the agent cannot gather enough request context

The boundary is not "task instead of helping." The agent should still complete
supported front-desk work first. Task creation is the fallback for non-live work
the agent cannot finish.

## Human Request Triage

If the caller asks for the office, staff, a representative, or a human without
explaining why, the agent should not transfer immediately unless there are urgent
symptoms, clinical risk, or repeated insistence on a live person now.

First ask one routing question:

```txt
I can help get you to the right team. What are you calling about?
```

If the caller still answers vaguely, ask one follow-up:

```txt
What do you need them to do or check for you?
```

After that, act:

- complete the request if it is supported front-desk work
- create a staff task if it is non-live office work with enough actionable detail
- transfer if the caller still insists on a human now or the request cannot be
  safely captured

Do not create vague tasks like "call me back" or "needs the office." A task must
say what staff need to do, check, send, update, answer, or follow up on.

## Caller Capture Pattern

When the request belongs in a task, the agent should use one short pattern:

```txt
I can send that to the team. What exactly do you need them to know?
```

Then gather:

- what the caller needs
- who the request is for, if patient-specific

Do not ask the caller to confirm the phone number just to create the task. The
runtime attaches the inbound caller phone from `CallState` silently.

If the caller's request is too vague for staff to act on, ask one concise
follow-up question. Otherwise, create the task without a formal readback step.

After the tool succeeds:

```txt
I sent that to the team. They will review it and follow up.
```

The agent must not promise:

- exact callback time
- prescription approval
- billing correction
- clinical advice
- that a named staff member personally received it

## Task Content Shape

Each task has three layers:

1. `summary`: a short staff-facing title.
2. `message`: the long free-form request the caller wants sent to the team.
3. structured fields: category, urgency, patient, practice/location, call, and phone
   metadata.

The `message` is the staff source of truth for what the caller asked. Structured
fields exist so the portal can bucket, filter, and sort the work without forcing
the caller into a rigid form.

The model should not extract patient name, requested staff person, best callback
time, or phone overrides as separate tool parameters. Runtime attaches known
patient and phone facts from state. If the caller says "ask Debbie to call me
after 3" or gives any other specific instruction, keep that detail in `message`.

## Practice And Location Resolution

Tasking must be product-portable across practices and locations. The model does
not choose the portal destination. The agent sends stable routing facts, and
`acuity_site` resolves them through the same practice/location primitives used by
call ingestion and portal access:

- `Practice`
- `PracticeLocation`
- `PracticePhoneNumber`
- portal membership location scopes

Resolution order for `POST /api/livekit/tasks`:

1. If `practiceId` and `locationId` are both supplied, verify the location
   belongs to that practice and use it.
2. If `practiceId` and `officePhone` are supplied, resolve `officePhone` through
   `PracticePhoneNumber` for that practice and use the mapped `locationId`.
3. If only `officePhone` is supplied, resolve both `practiceId` and `locationId`
   through `PracticePhoneNumber`.
4. If a matching `AgentCall.callId` already exists, use its `practiceId`,
   `locationId`, and `officePhone` as a fallback.

If practice cannot be resolved, reject the task. If a multi-location practice
cannot resolve location, reject the task unless the endpoint explicitly supports
a practice-wide task. V1 should prefer a failed tool result over putting work in
the wrong location.

For the current `abita_agent`, the portal source of truth is the phone mapping,
not Abita-specific office keys. The agent should send the phone that represents
the location responsible for the task:

- default to the inbound office/trunk phone
- if runtime deliberately moved the active office for the work, send that active
  office phone instead
- include `officeKey` only as optional agent metadata, not as the portal routing
  source of truth

## Model-Facing Tool

Add one model-callable tool:

```txt
create_staff_task
```

Purpose:

```txt
Create a staff follow-up task after gathering what the caller needs the team to
know.
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
  urgency: z.number().min(0).max(1),
  summary: z.string().trim().min(1).max(240),
  message: z.string().trim().min(1).max(2500),
})
```

Model contract:

- Try to finish supported front-desk work first.
- Use tasks only for work the agent cannot complete and that does not require a
  live handoff.
- Ask what exactly the caller needs the team to know.
- Keep `summary` short and staff-ready; use it as the task title.
- Put the caller's full concrete request in `message`. Preserve specific names,
  order details, dates, medication names, document names, and callback
  preferences the caller gave.
- Do not extract patient, requested-person, callback-time, or alternate-phone
  fields. Put those details in `message` if the caller says them.
- Set `urgency` as a 0-1 non-emergency score:
  - `0.0` to `0.25`: routine, no timing pressure
  - `0.25` to `0.5`: normal follow-up
  - `0.5` to `0.75`: time-sensitive but not urgent clinical risk
  - `0.75` to `1.0`: highest non-emergency staff attention
- Emergency or urgent clinical symptoms must transfer instead of becoming a
  high-urgency task.

Example:

```json
{
  "category": "optical",
  "urgency": 0.25,
  "summary": "Caller wants a status update on glasses ordered last week.",
  "message": "The caller said they ordered glasses last week and wants optical to check whether the glasses are ready for pickup."
}
```

## Runtime Contract

The tool owns the write path in code:

1. Read `CallState` from `session.userData`.
2. Attach backend-owned facts:
   - `callId`
   - active office key
   - office phone used for portal practice/location resolution
   - original inbound trunk phone when different from the task office phone
   - caller phone as the default callback phone
   - verified patient ID when available
   - verified patient name and DOB when available
   - current appointment context when relevant
3. Generate an idempotency key for this call and message.
4. POST the task to the portal immediately.
5. Store the created task receipt in call state.
6. Return a structured tool result plus speech-ready confirmation.

The task post must not wait for call shutdown analytics. End-of-call ingestion
can later enrich the linked call row, but the task should exist as soon as the
caller is told it was sent.

If the portal post fails, the tool should say it could not send the message and
offer transfer or another office-policy fallback. It should not pretend the task
was created.

The tool result should be machine-readable:

```ts
{
  status: "created" | "duplicate" | "failed";
  taskId?: string;
  category?: TaskCategory;
  urgency?: number;
  message: string;
}
```

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
  locationId?: string;
  officePhone: string;
  inboundOfficePhone?: string;
  officeKey?: string;
  category: TaskCategory;
  urgency: number;
  summary: string;
  message: string;
  callerPhone: string;
  patient?: {
    id?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
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
  urgency: number;
}
```

The portal should resolve practice/location the same way call ingestion and
call-center attribution do:

1. explicit verified `practiceId` and `locationId` when present
2. `officePhone` through `PracticePhoneNumber`
3. existing `AgentCall.callId` when present

If no practice can be resolved, or a multi-location task cannot be scoped to a
location, the endpoint should reject the task instead of creating unscoped work.

## Data Model

V1 table:

```txt
AgentTask
  id
  practiceId
  locationId
  agentCallId
  callId
  idempotencyKey
  status
  category
  urgency
  officeKey
  officePhone
  inboundOfficePhone
  summary
  message
  callerPhone
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

Urgency:

```txt
0.0 to 1.0
```

The model chooses the non-emergency urgency score. The portal can display simple
bands, but the stored value should remain numeric so staff can sort and tune
thresholds over time.

Useful constraints and indexes:

```txt
unique(idempotencyKey)
index(practiceId, status, category, createdAt)
index(practiceId, locationId, status, createdAt)
index(practiceId, status, urgency, createdAt)
index(agentCallId)
index(callId)
```

`agentCallId` should link to the portal call row when the call already exists.
`callId` should stay on the task because tasks may be created before shutdown
call ingestion finishes.

Do not add owner, comments, SLA due dates, or notifications in v1 unless staff
cannot use the inbox without them.

## Portal UI

Use the existing portal app route:

```txt
/portal/app/tasking
```

Default view:

- open tasks first
- scoped to the current portal user's allowed practice locations
- location filter when the practice has multiple locations
- grouped by category
- highest urgency first inside each group, then newest
- filters for status, category, office, and urgency band

Task row:

- category
- urgency
- patient or caller
- office
- one-line summary
- created time
- status control

Task detail:

- full message
- caller phone from state
- linked call detail page
- patient snapshot
- transcript excerpt or call link when available

The call detail page should also show linked tasks so staff reviewing a call can
see whether follow-up was created.

The page should use the same portal access model as calls, bookings, SMS, and
call center: users with all-location access can see all practice tasks, while
location-scoped users only see tasks for their allowed `locationId`s.

## Prompt And Tool Boundary

The base prompt and `transfer_call` description must change together.

Prompt behavior:

```txt
If the request is outside what you can complete, but it can safely be captured as
a message, offer to send it to the team. Ask what exactly the caller needs the
team to know, ask one follow-up only if the request is too vague, then create a
staff task.

If the caller asks for the office, staff, a representative, or a human without
explaining why, ask what they are calling about before transferring. If they stay
vague, ask what they need the team to do or check. Transfer after that only when
they still insist on a live human now or the request cannot be safely captured.
```

`transfer_call` should remain scoped to true live-human needs:

- emergency symptoms or urgent clinical risk
- caller insists on a human now
- returned-call workflows that office policy says must be live
- unsafe or incomplete message capture
- failed task creation when office policy requires live handoff

The prompt should not say "do not offer callbacks" once tasking is live. It
should instead say not to promise a callback time or outcome.

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
- high-urgency task backlog

This is the feedback loop for deciding what the agent should automate next.

## Acceptance Tests

Agent:

- `create_staff_task` posts the expected JSON with bearer auth.
- backend-owned fields are attached from `CallState`.
- `officePhone` is sent so the portal can resolve practice without an agent-side
  `practiceId`.
- current task office phone is distinct from original inbound trunk phone when
  runtime routing moves the task to another office.
- inbound caller phone and patient snapshot are attached silently from state.
- model parameters include only `category`, `urgency`, `summary`, and full
  free-form `message`.
- duplicate task creation in one call returns the existing receipt.
- portal failure does not mark the task as created.
- failed portal post produces a failure message, not a success confirmation.
- `transfer_call` remains available for emergency or caller-insisted live
  handoff language.
- prompt and tool tests no longer route ordinary billing, optical,
  prescription, records/forms, surgery, or named-person callback messages
  straight to transfer when task capture is safe.
- caller asks for the office or a human with no reason; prompt asks what they are
  calling about before transfer.
- caller gives only a vague callback request; prompt asks what the team needs to
  do or check before creating a task.
- caller insists on a live human after the routing question; `transfer_call`
  remains allowed.

Portal:

- unauthenticated task POST is rejected.
- authenticated task POST creates an `AgentTask`.
- repeated idempotency key returns the existing task.
- task links to an existing `AgentCall` by `callId` when present.
- task can be created before the final `AgentCall` shutdown payload arrives.
- task resolves `practiceId` and `locationId` through `PracticePhoneNumber` when
  only `officePhone` is supplied.
- task POST rejects unknown `officePhone` instead of creating unscoped work.
- portal task queries respect membership location scope.
- tasking page groups open tasks by category.
- tasking page sorts by urgency inside each category.
- tasking page filters by status, category, office, and urgency band.
- task status transitions persist.

## Rollout

1. Build the portal endpoint, table, and `/portal/app/tasking` inbox first.
2. Add the agent poster and `create_staff_task` tool behind a feature flag.
3. Update the base prompt and `transfer_call` wording so task-worthy work no
   longer routes straight to live handoff.
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
one tasking inbox
one call link
four statuses
seven categories
one urgency score
```

Anything beyond that should be justified by real staff usage.
