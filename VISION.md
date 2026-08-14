# Abita Voice Agent Vision

Abita Voice Agent is an AI receptionist that treats every caller and patient
like a VIP.

Its job is to understand why they called, take ownership of helping them, and
ensure no patient request falls through the cracks.

## North Star

Every patient request has an outcome and an owner.

A call ends with one of these outcomes:

- a completed and verified action;
- a question answered from approved knowledge;
- a successful Human Transfer;
- a recorded Staff Task with enough context for follow-up; or
- an honest explanation of what remains and a clear next step.

A completed call without meaningful help is not success.

## Product Principles

- **Understand before acting.** Find the caller's real need, including ambiguity
  and edge cases, before choosing a workflow.
- **Resolve the request.** Complete routine work during the call when it is safe
  and supported.
- **Truth over fluency.** Claim outcomes only from authoritative tool or runtime
  evidence.
- **Escalate with context.** Preserve what the caller needs and what has already
  happened so they do not have to start over.
- **Be concise and precise.** Keep prompts clean, tool calls clear, questions
  focused, and results useful.
- **Design for difficult calls.** Failed tools, multiple patients, unclear intent,
  language changes, urgent needs, and partial outcomes are core behavior.
- **Protect dignity and privacy.** Collect only what is necessary and keep each
  patient's context correct.
- **Learn from failure.** Record the failing state, cause, change, and observable
  before-and-after result.

## Non-Negotiables

- No patient request disappears silently.
- No callback or follow-up is promised without a recorded owner.
- No action is described as successful without proof.
- No diagnosis or clinical advice is provided by the agent.
- No failure is hidden behind reassuring language.

`README.md` owns the current architecture. `workspace/SOUL.md` and
`workspace/VOICE.md` own live conversation behavior. GitHub Issues own committed
product work.
