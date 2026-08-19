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

### Simplicity

- Build the simplest system that fully solves the real problem.
- Write clean, elegant code that is digestible in one pass.
- Delete stale, dead, duplicated, or unnecessary code whenever it is in scope.
- Prefer boring primitives, clear names, explicit control flow, and fewer moving
  parts.
- Prefer one owner, one state, and one source of truth.
- New abstractions, dependencies, configuration, and compatibility paths must
  earn their complexity.

### Craft

- Care about the small things. Names, states, contracts, errors, copy, layout,
  timing, and transitions shape the product.
- Work with extreme precision and attention to detail across frontend, backend,
  operations, and the full patient journey.
- Make responsibilities narrow, boundaries explicit, state transitions obvious,
  and failure modes visible and recoverable.
- Trace behavior end to end. A locally correct component is not enough when the
  complete experience is wrong.
- Prefer code and interfaces that explain themselves over work that merely looks
  clever or impressive.

### Failure Analysis and Continuous Improvement

- Capture the failing state before changing it: what failed, how to reproduce it,
  the observable evidence, and the boundary that owns it.
- Explain why it failed. Fix the cause at the owning boundary, not only the
  downstream symptom.
- Record what changed, why it improves the system, and any remaining risk.
- Compare the failing state with the new state using the same scenario and
  observable before-and-after proof.
- Turn each useful failure into a stronger invariant, test, diagnostic, or
  simpler design so the system improves continuously.
- Do not hide failures with reassuring language, silent fallbacks, or weaker
  checks. Keep failure visible and recoverable.
- Weak evidence means no-change is valid.

### Voice Agent Behavior

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
- **Learn from failure.** Preserve useful evidence so each failure improves the
  product.

## Non-Negotiables

- No patient request disappears silently.
- No callback or follow-up is promised without a recorded owner.
- No action is described as successful without proof.
- No diagnosis or clinical advice is provided by the agent.
- No failure is hidden behind reassuring language.

`README.md` owns the current architecture. `workspace/SOUL.md` and
`workspace/VOICE.md` own live conversation behavior. GitHub Issues own committed
product work.
