# Voice Front Desk

The domain language for the automated phone experience and the work it performs
for callers.

## Language

**Voice Agent**

The AI phone operator that owns one caller conversation from greeting through
completion, staff follow-up, or human transfer.

_Avoid_: specialist agent, sub-agent, orchestrator.

**Call State**

The authoritative typed state for one live caller conversation, stored in
`session.userData`. It includes runtime, office, identity, scheduling, insurance,
appointment, and observation facts.

_Avoid_: memory, context store, conversation state when referring to the runtime
object.

**Office Profile**

The customer-owned policy selected from the inbound trunk. It defines office
identity, supported care, prompts, speech, middleware routing, staff-task
availability, and human-transfer behavior.

_Avoid_: office config when referring to the complete policy.

**Office Knowledge Search**

Read-only access to the current approved office facts for the active Office Profile.
Its evidence supports office answers but does not establish patient state,
insurance participation, availability, or completed actions.

_Avoid_: Office Knowledge Hook, keyword enrichment, full-context injection.

**Owned Middleware**

The backend interface for patient lookup, patient creation, insurance updates,
availability, booking, and cancellation. It returns semantic outcomes; the Voice
Agent does not interpret raw provider responses.

_Avoid_: AdvancedMD client, transport client.

**Identity Promotion**

The transition that makes a verified, preloaded, switched, or new patient the
active patient in Call State. Promotion clears work belonging to the previous
patient before new writes are allowed.

_Avoid_: hydration when the patient becomes active.

**Scheduling Workflow**

The Voice Agent-owned sequence for availability, booking, cancellation, and
rescheduling. It owns private booking-token use, appointment selection, write
ordering, replay protection, state transitions, and speech-ready outcomes.

**Visit Type**

The model-facing purpose of a new appointment: `medical` when the patient needs
medical eye care from an ophthalmologist for an eye problem or evaluation, and
`routine_vision` when the patient needs routine vision care from an optometrist
for glasses, contacts, or prescription care and has no active eye problem. The
Voice Agent chooses it after understanding why the patient is coming in. The
Scheduling Workflow translates it to the existing internal appointment lane.

**Appointment Outcome**

A committed booking, cancellation, or rescheduling result derived from executed
middleware operations. Caller or model claims are not appointment outcomes.

**Staff Task**

Safe non-live office work captured for staff review when the Voice Agent cannot
complete the request during the call. A Staff Task is not a transcript, a
clinical decision, or a promise of completion.

**Human Transfer**

Moving the live caller to office staff when the request requires synchronous
human help or software cannot continue safely.

_Avoid_: handoff in product-facing language; handoff is an internal transport
term.

**Call Closeout**

The terminal runtime process that captures sanitized call evidence, delivers it
to the portal, and releases LiveKit resources. Closeout does not redefine tool
or appointment outcomes.
