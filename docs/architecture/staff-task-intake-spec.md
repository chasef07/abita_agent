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

## V1 Scope

V1 is Spring Hill inbound only.

The agent exposes `create_staff_task` only when the inbound trunk/office context
is Spring Hill. Tasking is not a replacement for routing other offices into
Spring Hill, and the agent should not move a call to Spring Hill just to create a
task.

Returned calls remain live-transfer work. Routine medication and prescription
follow-up, including refills, status checks, and pharmacy updates, can use the
task inbox. Emergency or urgent symptoms, suspected medication reactions,
dosage or medication instructions, clinical advice, and medical decisions remain
transfer work.

## Non-Goals

- Do not build a full ticketing system in v1.
- Do not add assignment rules, SLA timers, internal comments, or automation
  chains before staff prove the inbox is useful.
- Do not let the agent promise clinical action, prescription approval, billing
  adjustment, or same-day completion.
- Do not route emergencies, urgent symptoms, or caller-insisted live handoffs
  into tasks.
- Do not create tasks for suspected medication reactions, dosage or medication
  instructions, clinical advice, or medical decisions.
- Do not create tasks for returned-call workflows; transfer those.
- Do not create tasks for work the agent can already complete safely, such as
  supported scheduling, cancellation, rescheduling, insurance checks, or office
  facts.

## Task vs Transfer

Create a task when the request is real office work, the agent cannot complete it,
and the caller can safely leave a message:

- billing questions or billing callback requests
- appointment issues the agent cannot complete safely
- medical records, paperwork, forms, or document requests
- optical order status or other safe office follow-up that does not need a
  clinical answer
- requests for a named person when a message or callback is acceptable
- general callback requests after the agent has gathered the need
- routine medication or prescription requests that staff can review
  asynchronously, such as refills, status checks, and pharmacy updates
- other safe non-live office work that staff should review

Transfer when:

- the caller reports emergency symptoms or urgent clinical risk
- the caller reports a suspected medication reaction or asks for dosage,
  medication instructions, clinical advice, or a medical decision
- the caller repeatedly asks for a human now
- the caller is returning a call
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
3. structured fields: category, priority, patient, practice/location, call, and phone
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
not Abita-specific office keys. The Spring Hill inbound runtime sends the phone
that represents the Spring Hill location responsible for the task:

- send the active Spring Hill office phone used by runtime state
- include the original inbound trunk phone when it differs from that office
  phone
- include `officeKey` only as optional agent metadata, not as the portal routing
  source of truth

Do not add agent-side Spring Hill routing to support tasking. If the call is not
in the Spring Hill inbound context, `create_staff_task` should not be available.

## Model-Facing Tool

Add one model-callable tool:

```txt
create_staff_task
```

Purpose:

```txt
Create a Spring Hill staff follow-up task after gathering what the caller needs
the team to do, check, send, update, answer, or review.
```

Parameters:

```ts
parameters: z.object({
  category: z.enum(["billing", "appointments", "documentation", "other"]),
  urgency: z.enum(["high_priority", "normal", "non_urgent"]),
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
  order details, dates, document names, and callback preferences the caller
  gave.
- For medication or prescription work, use category `other` and include the
  medication or prescription name, requested action, and pharmacy name or
  location when known. Never promise approval or completion.
- Do not extract patient, requested-person, callback-time, or alternate-phone
  fields. Put those details in `message` if the caller says them.
- Set `urgency` as a coarse non-clinical office priority:
  - `non_urgent`: routine follow-up
  - `normal`: normal staff review
  - `high_priority`: office follow-up that should be reviewed before normal work
- Never use `high_priority` to represent clinical acuity. Emergency symptoms,
  urgent clinical risk, suspected medication reactions, dosage or medication
  instructions, clinical advice, medical decisions, and returned calls must
  transfer instead of becoming tasks.

Example:

```json
{
  "category": "other",
  "urgency": "normal",
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
6. Return a speech-ready confirmation string.

The task post must not wait for call shutdown analytics. End-of-call ingestion
can later enrich the linked call row, but the task should exist as soon as the
caller is told it was sent.

If the portal post fails, the tool should say it could not send the message and
offer transfer or another office-policy fallback. It should not pretend the task
was created.

The tool response should tell the model exactly what to say next:

```ts
"Task sent to staff. Tell the caller: I wrote that down for the team. They'll review it and follow up."
"Task already sent to staff. Tell the caller: I already sent that to the team. They'll review it and follow up."
"Could not send the staff task. Tell the caller: I couldn't send that message, but I can transfer you to the office."
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
  urgency: TaskPriority;
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
  urgency: TaskPriority;
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
  priority
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
appointments
documentation
other
```

Priority:

```txt
high_priority
normal
non_urgent
```

The model chooses a non-clinical office priority. `high_priority` is not medical
urgency and must not be used for clinical triage.

Useful constraints and indexes:

```txt
unique(idempotencyKey)
index(practiceId, status, category, createdAt)
index(practiceId, locationId, status, createdAt)
index(practiceId, status, priority, createdAt)
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
- highest priority first inside each group, then newest
- filters for status, category, office, and priority

Task row:

- category
- priority
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
- suspected medication reactions, dosage or medication instructions, clinical
  advice, or medical decision requests
- routine medication or prescription requests use `create_staff_task` when it
  is available
- caller insists on a human now
- returned-call workflows
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
- high-priority task backlog

This is the feedback loop for deciding what the agent should automate next.

## Acceptance Tests

Agent:

- `create_staff_task` posts the expected JSON with bearer auth.
- backend-owned fields are attached from `CallState`.
- `officePhone` is sent so the portal can resolve practice without an agent-side
  `practiceId`.
- current task office phone is distinct from original inbound trunk phone when
  the Spring Hill inbound trunk differs from the portal office phone.
- inbound caller phone and patient snapshot are attached silently from state.
- model parameters include only `category`, `urgency`, `summary`, and full
  free-form `message`.
- model parameters allow only four categories and three non-clinical priorities.
- `create_staff_task` is exposed only for Spring Hill inbound runtime context.
- duplicate task creation in one call returns the existing receipt.
- portal failure does not mark the task as created.
- failed portal post produces a failure message, not a success confirmation.
- `transfer_call` remains available for emergency or caller-insisted live
  handoff language.
- prompt and tool tests no longer route ordinary billing, appointment,
  documentation, optical order status, or named-person messages straight to
  transfer when task capture is safe.
- routine medication and prescription examples create tasks; medication
  reactions, dosage or instruction questions, clinical decisions, and returned
  calls still transfer.
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
- tasking page sorts by priority inside each category.
- tasking page filters by status, category, office, and priority.
- task status transitions persist.

## Rollout

1. Build the portal endpoint, table, and `/portal/app/tasking` inbox first.
2. Add the agent poster and expose `create_staff_task` only for Spring Hill
   inbound runtime context.
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
four categories
one non-clinical priority enum
```

Anything beyond that should be justified by real staff usage.
