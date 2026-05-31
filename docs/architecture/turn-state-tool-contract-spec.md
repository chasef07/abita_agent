# Turn State Tool Contract Spec

## Goal

Keep normal LiveKit function calling as the main agent loop, and add one small
tool that selects the workflow context for the caller's current request.

The backend does not maintain a separate active workflow. The model calls
`record_turn_context` only when it is confident enough to commit to the current
workflow. The backend stores that selected turn, returns a workflow context
guide, and the model continues with the normal tool surface.

## Core Principle

Business tools stay normal tools.

`record_turn_context` is a confidence-gated workflow selector, not a planner and
not a business action. It does not replace `confirm_patient_identity`,
`check_insurance`, `get_availability`, `book_appt`, `cancel_appt`,
`lookup_knowledge`, or `transfer_call`.

If the intent is unclear, the model should ask clarifying questions instead of
calling this tool.

If the caller wants scheduling but the medical-versus-routine lane is unclear,
the model should ask clarifying questions instead of calling this tool.

## Tool Contract

Tool name:

```txt
record_turn_context
```

Purpose:

```txt
Select the workflow context for the caller's current request when the intent is clear.
```

It should not:

- Speak to the caller.
- Verify a patient.
- Search availability.
- Book, cancel, or reschedule an appointment.
- Transfer the call.
- Call middleware or any external system.
- Guess when the caller's request is unclear.

It should:

- Be called only when the model is confident about the caller's intent.
- For scheduling, be called only after the appointment lane is known.
- Store the selected workflow context in backend state.
- Return a compact workflow context guide.

## Tool Schema

Keep the argument schema inline in `src/tools/record-turn-context.ts`, like the
other tool definitions:

```ts
parameters: z.object({
  intent: z.enum([
    "schedule",
    "change_appointment",
    "question",
    "transfer",
  ]),
  appointmentLane: z.enum([
    "medical_md",
    "routine_od",
    "not_applicable",
  ]),
  isEmergency: z.boolean(),
  confidence: z.number().min(0).max(1),
})
```

The implementation also validates the lane pairing:

- `intent: "schedule"` requires `appointmentLane: "medical_md"` or
  `appointmentLane: "routine_od"`.
- Non-scheduling intents require `appointmentLane: "not_applicable"`.

There is intentionally no `unknown` value. If the model would choose `unknown`,
it should not call the tool yet.

`confidence` is the model's confidence in the workflow selection. It is not a
permission signal, and low confidence means the model should clarify first.

## Field Meanings

### `intent`

The clear workflow intent for the caller's current request:

- `schedule`: caller wants a new appointment.
- `change_appointment`: caller wants to cancel, reschedule, confirm, or ask
  about an existing appointment.
- `question`: caller asks a general question.
- `transfer`: caller explicitly asks for a person, office, receptionist, or
  human.

### `appointmentLane`

For scheduling, this must classify the appointment lane. It is an operational
scheduling lane, not a diagnosis.

- `medical_md`: ophthalmology or medical eye-care lane.
- `routine_od`: optometry, optical, or routine vision lane.
- `not_applicable`: the intent is not scheduling.

For `intent: "schedule"`, `appointmentLane` must be `medical_md` or
`routine_od`.

For all non-scheduling intents, `appointmentLane` should be `not_applicable`.

### `isEmergency`

True only when the caller describes possible urgent or emergency eye symptoms or
a time-sensitive safety issue.

Emergency handling overrides the normal workflow context.

## Appointment Lane Rubric

Use `medical_md` when the caller needs a medical eye visit or ophthalmology
care:

- Eye pain, severe redness, infection, injury, trauma, chemical exposure.
- Sudden vision loss, sudden vision change, new flashes or floaters.
- Cataracts, glaucoma, retina, diabetic eye care, surgery consults.
- Post-op concerns or surgery follow-up.
- Referral from another clinician for a medical eye issue.
- Symptom-driven blurry vision or worsening vision.

Use `routine_od` when the caller needs routine vision, optical, or optometry
care:

- Routine eye exam, annual eye exam, vision check.
- Glasses prescription, new glasses, refraction.
- Contacts, contact lens fitting, contact lens prescription.
- Routine vision benefits or vision-plan scheduling.

If the caller only says they need an appointment and does not say why, do not
call `record_turn_context` yet. Ask what they need to be seen for.

If the request could reasonably be either `medical_md` or `routine_od`, do not
guess. Ask clarifying questions before calling `record_turn_context`.

## Workflow Contexts

The backend maps the tool arguments to one small workflow context:

```ts
type WorkflowContextName =
  | "scheduling"
  | "appointment_change"
  | "general_question"
  | "human_transfer"
  | "emergency";
```

Mapping:

- `isEmergency: true` -> `emergency`
- `intent: "schedule"` -> `scheduling`
- `intent: "change_appointment"` -> `appointment_change`
- `intent: "question"` -> `general_question`
- `intent: "transfer"` -> `human_transfer`

The workflow context is response-local. It gives the model a gentle guide for
the current response; it is not a durable workflow state machine.

Example `scheduling` guide:

```txt
current: scheduling
- Typical path: understand the visit reason and appointment lane, identify the
  patient, handle insurance when needed, ask date or time preference, check
  availability, then book only after the caller chooses a slot.
- Use the appointment lane from record_turn_context to decide medical
  ophthalmology versus routine vision context. If the lane is unclear, ask
  concise clarifying questions before calling record_turn_context.
```

Example `appointment_change` guide:

```txt
current: appointment_change
- Typical path: verify or confirm the patient, identify the exact existing
  appointment, then handle confirmation, cancellation, or rescheduling.
- For reschedules, book the new appointment before cancelling the old one. For
  cancellations, call cancel_appt only after the caller confirms the exact
  loaded appointment.
```

## Backend State

The backend stores only the latest selected turn context:

```ts
type TurnContextState = {
  last?: {
    intent: "schedule" | "change_appointment" | "question" | "transfer";
    appointmentLane: "medical_md" | "routine_od" | "not_applicable";
    isEmergency: boolean;
    confidence: number;
  };
};
```

Other durable facts remain where they already belong:

- patient identity in patient state
- insurance and routing in scheduling state
- availability slots in scheduling state
- appointments and cancel tokens in appointment state
- transfer state in runtime state

## Example Tool Result

Caller:

```txt
I need an appointment for blurry vision.
```

Model calls:

```json
{
  "intent": "schedule",
  "appointmentLane": "medical_md",
  "isEmergency": false,
  "confidence": 0.9
}
```

Backend returns:

```json
{
  "recorded": true,
  "workflowContext": {
    "name": "scheduling",
    "guidance": [
      "Typical path: understand the visit reason and appointment lane, identify the patient, handle insurance when needed, ask date or time preference, check availability, then book only after the caller chooses a slot.",
      "Use the appointment lane from record_turn_context to decide medical ophthalmology versus routine vision context. If the lane is unclear, ask concise clarifying questions before calling record_turn_context."
    ]
  }
}
```

Then the model continues normally: ask the next scheduling question or call the
appropriate business tool when prerequisites are known.

Caller:

```txt
I need an appointment.
```

Model should not call `record_turn_context` yet. It should ask what the caller
needs to be seen for.

Caller asks a side question:

```txt
Do you take VSP?
```

Model calls:

```json
{
  "intent": "question",
  "appointmentLane": "not_applicable",
  "isEmergency": false,
  "confidence": 0.86
}
```

Backend returns:

```json
{
  "recorded": true,
  "workflowContext": {
    "name": "general_question",
    "guidance": [
      "Answer the caller's question directly, using lookup_knowledge or check_insurance when needed.",
      "Do not verify the patient unless the answer or action requires private patient data."
    ]
  }
}
```

The model answers the question using the normal tools and conversation history.
No backend workflow needs to be resumed.

## Why This Is The First Cut

This keeps the architecture simple:

- No `response_format` main response path.
- No duplicate `requestedAction` schema.
- No homemade tool-calling protocol.
- No backend planner state for active workflows.
- Existing LiveKit tool definitions remain the model-facing action surface.
- The new tool is low risk because it only records context and returns a guide.

The backend still owns side effects through the existing business tools. The
model owns conversational continuity through the normal chat context.
