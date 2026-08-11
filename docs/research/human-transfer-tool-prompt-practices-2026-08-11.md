# Human-transfer tool and prompt practices

Research date: 2026-08-11.

Scope: official OpenAI, LiveKit, Retell, and Vapi documentation. No secondary
sources were used.

## Verdict

The clean split is:

- **Tool description:** one short sentence describing the action.
- **System prompt:** one short section defining when to transfer, when to keep
  helping, and that required transfers call the tool before natural language.
- **Runtime:** the transfer tool performs the side effect and returns explicit
  success or failure evidence.

That split is directly consistent with OpenAI's function-calling guidance:
describe a function's purpose, parameters, and output in its schema, and use
the system prompt to say when and when not to call it. OpenAI also recommends
stating each instruction once and keeping tool descriptions concise and
precise ([function calling](https://developers.openai.com/api/docs/guides/function-calling),
[model guidance](https://developers.openai.com/api/docs/guides/latest-model)).

A suitable description is:

> Transfer the caller to human office staff when the transfer policy requires it.

This is close to LiveKit's own one-sentence example: its transfer tool says it
transfers the call to a human after confirmation. LiveKit keeps the actual SIP
operation and failure result in code
([LiveKit call forwarding](https://docs.livekit.io/telephony/features/transfers/cold/)).
Do not reduce the description to an opaque label such as `human transfer`:
Vapi warns that transfer tools need an explicit description and that vague or
generated descriptions can bias the model against calling them
([Vapi prompting guide](https://docs.vapi.ai/prompting-guide)).

## Recommended prompt section

```md
## Human transfer

- Call `transfer_call` immediately for emergency or urgent clinical concerns,
  medication guidance or reactions, callers returning an office call, direct
  person requests, or a caller who still wants staff after one attempt to help.
- In those cases, natural-language text is not allowed before the tool call.
  Words promising staff alone are incomplete.
- For safe, non-urgent staff follow-up, offer `create_staff_task` first.
  Transfer only if it is unavailable, fails, or the caller declines.
- Describe a transfer only from the `transfer_call` result.
```

Retell explicitly tells builders to place transfer conditions in the prompt,
with the pattern “If [condition], use the transfer tool.” Vapi likewise places
“when the user asks to be transferred” in the system message while configuring
the transfer capability separately
([Retell prompt engineering](https://docs.retellai.com/build/prompt-engineering-guide),
[Retell transfer-call tool](https://docs.retellai.com/build/single-multi-prompt/transfer-call),
[Vapi call forwarding](https://docs.vapi.ai/call-forwarding)).

## Do not claim success before evidence

The transfer invocation is an attempt, not proof of a completed action.
OpenAI's documented flow is: receive the function call, execute application
code, return a success or failure result, then let the model respond using that
result. OpenAI specifically recommends returning an explicit success/failure
string even when a function otherwise has no value
([OpenAI function results](https://developers.openai.com/api/docs/guides/function-calling#formatting-results)).

Therefore:

- In the selected prompt, call the tool before any transfer narration.
- It must not claim completion: “You are connected” or “The transfer succeeded.”
- A success statement must be derived from the tool result.
- A failure or ambiguous result must remain a failure or ambiguity; do not turn
  it into a success claim.

Vapi recommends silently invoking transfers to avoid confusing narration and
using runtime-controlled tool messages when speech must be guaranteed. It also
notes that prompts are probabilistic and server-side mechanisms are required
for values the model must not be able to fake
([Vapi prompting guide](https://docs.vapi.ai/prompting-guide#silent-transfers)).

## Prompt-only selection and runtime alternatives

With automatic tool choice, transfer remains probabilistic: OpenAI documents
that `auto` can call zero, one, or multiple tools. `required` forces at least
one tool, and a forced function selects exactly one named tool
([OpenAI tool choice](https://developers.openai.com/api/docs/guides/function-calling#tool-choice)).

General architectural boundary:

- Use model selection for genuinely semantic policy judgments, backed by
  representative call tests.
- Use application/runtime routing or forced tool choice when a transfer is a
  non-negotiable invariant after an unambiguous condition has already been
  established.
- Do not expect stronger wording alone to create a deterministic guarantee.

Runtime routing and forced tool choice were evaluated as alternatives but were
explicitly rejected for this change. The implementation remains prompt-only
with automatic tool choice.

This is an architectural recommendation inferred from OpenAI's documented tool
choice modes and Vapi's warning that prompts are probabilistic. Retell likewise
distinguishes model-selected tool calls from deterministic Conversation Flow
transitions. OpenAI identifies chained voice pipelines as the better fit when
deterministic logic between stages is important
([Retell prompt engineering](https://docs.retellai.com/build/prompt-engineering-guide),
[OpenAI voice agents](https://developers.openai.com/api/docs/guides/voice-agents)).

## Prompt-only evaluation

The final wording was exercised against the configured
`google/gemma-4-31b-it` model with the complete production prompt, automatic
tool choice, and five mocked tool bodies. No LiveKit room or live telephony was
used.

- Required transfer cases: 26/26 emitted structured `transfer_call` calls.
- Non-transfer controls: 24/24 avoided `transfer_call`.
- Required cases covered direct person and front-desk requests, returned calls,
  urgent symptoms, medication instructions and reactions, clinical advice, and
  repeated staff requests.
- Controls covered office hours, vague help, explicit transfer refusal, missed
  appointments, scheduling, insurance, callback requests, and the ambiguous
  phrase “Can someone explain what your office hours are?”

Two nearby variants were worse: a shorter rule transferred only 18/26 required
cases, while a fully positive rewrite transferred all 26 required cases but
incorrectly transferred 4/24 controls. The selected wording repeated the final
50-turn matrix at 26/26 and 24/24. These are finite stochastic trials, not a
deterministic guarantee.

## Practical acceptance tests

Run the same scenarios before and after the prompt change and require both the
spoken behavior and structured tool evidence:

1. Direct request for a human calls the transfer tool without another help loop.
2. Mandatory urgent/clinical case calls the tool.
3. Safe staff follow-up offers a task once, then transfers after refusal or failure.
4. Successful tool result permits a success statement.
5. Failed or ambiguous result never becomes a success statement or duplicate transfer.
6. Routine requests that the agent can complete do not transfer.

OpenAI recommends simplifying one instruction group at a time and validating
on representative tasks rather than assuming a leaner prompt is automatically
better ([model guidance](https://developers.openai.com/api/docs/guides/latest-model#favor-leaner-prompts)).
