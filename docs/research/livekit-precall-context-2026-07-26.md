# LiveKit pre-call patient context

Research date: 2026-07-26. Scope: the Abita inbound-call bootstrap and the
installed `@livekit/agents` 1.5.5 STT-LLM-TTS pipeline. Sources are limited to
LiveKit documentation, the pinned LiveKit source matching the installed
package, and this repository.

## Verdict

Do **not** put pre-call patient candidates in participant metadata or
attributes. Store the complete private lookup result in typed
`AgentSession.userData`. If the model needs to know the lookup outcome before
its first turn, give it only a derived status such as `single_match`,
`multiple_matches`, `no_match`, or `lookup_failed` through the agent's initial
`ChatContext`. Keep names, dates of birth, patient identifiers, appointments,
and opaque provider tokens out of model context until a caller has selected and
confirmed one patient.

The current implementation has the important boundary right:

- It reads caller and trunk identifiers from LiveKit's standard SIP participant
  attributes, performs the lookup, and waits for the result before
  `session.start()` ([`src/main.ts`](../../src/main.ts#L128-L157),
  [`src/runtime/session-startup.ts`](../../src/runtime/session-startup.ts#L30-L67)).
  LiveKit explicitly documents
  `sip.phoneNumber` and `sip.trunkPhoneNumber` as the SIP attributes intended
  for caller lookup and routing. [SIP participant reference][sip-participant]
- It stores the complete pre-call candidates in canonical `CallState`, then
  exposes that state to tools through `session.userData`
  ([`src/main.ts`](../../src/main.ts#L200-L206),
  [`src/main.ts`](../../src/main.ts#L276-L305),
  [`src/state/call-state.ts`](../../src/state/call-state.ts#L147-L159),
  [`src/tools/session.ts`](../../src/tools/session.ts#L1-L7)).
- It sends the model only a coarse lookup-status hint at startup, not the
  candidate records
  ([`src/runtime/precall-model-context.ts`](../../src/runtime/precall-model-context.ts#L1-L21),
  [`src/agent.ts`](../../src/agent.ts#L61-L69)).

That is functionally correct and substantially safer than metadata injection.
The implementation already initializes the completed `CallState` as
`AgentSession.userData` in the constructor and derives a small model-facing
lookup enum before constructing the initial `ChatContext`
([`src/main.ts`](../../src/main.ts#L198-L213),
[`src/main.ts`](../../src/main.ts#L284-L291)). Those are invariants to preserve,
not future improvements. LiveKit recommends typed session state and documents
`ChatContext` as the primitive for user- or task-specific initial model
context. [LiveKit passing state][passing-state] [LiveKit initial
context][initial-context] [installed session source][session-userdata]

## The primitives are different

| Primitive | Who receives it | Correct Abita use | Candidate verdict |
|---|---|---|---|
| Participant metadata / attributes | Stored by the LiveKit server and synchronized to room participants, including participants that join later | Read LiveKit's standard SIP caller/trunk attributes as lookup inputs | **Never store patient candidates here.** This is room-visible synchronized state, not private worker state. [Participant state][participant-state] |
| Job / dispatch metadata | Supplied by the dispatcher and read from `ctx.job.metadata` | Static routing data or an opaque correlation key known before dispatch | Not a destination for a lookup performed inside the job. It is dispatch input, and the current inbound lookup depends on SIP participant attributes that exist after the caller joins. [Agent dispatch metadata][job-metadata] |
| `AgentSession.userData` | The running agent application and its `RunContext` tools | Canonical per-call identity, private candidates, backend references, appointments, and opaque tokens | **Primary storage primitive.** LiveKit recommends typed user data for custom session state, and the installed SDK does not automatically add it to LLM input. [Passing state][passing-state] [installed `RunContext` source][run-context] |
| Agent instructions / `updateInstructions` | The model as system instructions | Stable behavior, identity-confirmation policy, and safety rules | Do not place candidate data here. The SDK installs instructions into model context and records instruction changes in chat history. [installed agent source][agent-updates] [installed activity source][activity-instructions] |
| `ChatContext` / system messages | The model and conversation history | A minimal derived pre-call status; after confirmation, only the selected patient's facts needed for the conversation | Correct model-context primitive, but not private storage. Every included fact is intentionally sent to the model. The SDK also serializes chat context into LLM tracing span attributes when tracing is active. [Chat context docs][chat-context] [installed generation source][generation-trace] |
| Tool context | The model receives tool names, descriptions, and argument schemas; executors receive `RunContext` | Let `resolve_patient` accept caller-provided identity, consult private `userData`, hydrate the chosen candidate, and return a minimal semantic outcome | Correct controlled bridge. Do not put hidden candidates or backend tokens in tool descriptions, arguments, or return values. [Function tools][function-tools] [installed LLM call source][llm-call] |

There is no LiveKit “metadata” field that automatically and privately injects
application state into the model. Participant metadata, job metadata,
`userData`, and `ChatContext` solve different problems.

## Recommended request path

1. Connect and wait for the SIP participant because that is when the inbound
   caller and trunk attributes are available.
2. Start the patient lookup immediately. In parallel, construct independent
   LLM, STT, TTS, observability, and closeout resources.
3. Await the lookup before `session.start()`. Starting the session first would
   create a first-turn race with `onEnter`, audio processing, and tools. LiveKit
   defines `start()` as the point where session I/O and agent activity begin.
   [Agent session lifecycle][session-lifecycle]
4. Build one canonical `CallState` containing the private candidates and pass it
   as `userData` when constructing `AgentSession<CallState>`.
5. Build an initial `ChatContext` containing only the derived lookup status the
   model needs to choose the next conversational step. Keep static policy in
   agent instructions.
6. On caller selection, match against `userData` in application code or the
   existing `resolve_patient` tool. For lightweight candidates, hydrate only
   the selected private candidate through Owned Middleware. The model should
   provide caller-spoken identity, not patient IDs or private candidate
   references.
7. After identity confirmation, project only the selected patient's necessary
   conversational facts into `ChatContext` or a minimal tool result. Keep
   unselected candidates and cancellation/booking tokens in `userData`.

This preserves the current invariant: pre-call lookup must complete before the
first model turn, while lookup time can still overlap independent startup work.
It also preserves one owner for private state instead of copying candidate
records into LiveKit room state, instructions, chat history, and tool payloads.

## Current ChatContext behavior

Abita's transcript-confirmation hook reads private state from
`ctx.session.userData`. After deterministic identity confirmation, every
`onUserTurnCompleted` call derives a fresh selected-patient projection from
canonical `CallState` and adds it only to the temporary `ChatContext` for that
generation ([`src/agent.ts`](../../src/agent.ts#L78-L111),
[`src/identity/promotion.ts`](../../src/identity/promotion.ts#L264-L271)).
LiveKit documents that messages added in this hook affect the current
generation, while persisting them requires a separate `updateChatCtx` call.
[Pipeline hook documentation][turn-hook]

The projection is intentionally not appended to durable history. A patient
switch, insurance update, booking, or cancellation changes canonical
`CallState`; the next caller turn therefore replaces the prior snapshot instead
of leaving conflicting cross-patient facts in model context. Tool results carry
the current mutation result within the tool turn.

Model-visible context still has important consequences:

- It is sent to the configured LLM provider.
- It is request-local here, but would persist if `updateChatCtx` were called.
- In the installed SDK, the serialized chat context is attached to the LLM
  generation span when tracing is enabled. [installed generation
  source][generation-trace]

Therefore, model context should contain the smallest confirmed projection, and
observability/export configuration must be treated as part of the PHI boundary.

## Implementation acceptance checks

- No lookup result is written to participant metadata, participant attributes,
  or room metadata.
- `AgentSession<CallState>` has initialized `userData` before
  `session.start()`.
- The initial model context contains only a closed, derived lookup-status value.
- Multiple-match names, patient IDs, dates of birth, appointments, and private
  candidate references remain absent from initial instructions and
  `ChatContext`.
- `resolve_patient` continues to accept caller-provided identity rather than a
  backend identifier.
- Hydration updates canonical `userData` before selected-patient facts are
  projected into model context.
- Confirmed patient facts are freshly derived for each caller turn and are not
  appended to durable chat history.
- Opaque cancellation and booking tokens never appear in instructions, chat
  messages, tool schemas, tool results, logs, or traces.
- A delayed lookup cannot race the greeting or first user turn because
  `session.start()` still waits for bootstrap completion.

[sip-participant]: https://docs.livekit.io/reference/telephony/sip-participant/#sip-attributes
[participant-state]: https://docs.livekit.io/transport/data/state/participant-attributes/#overview
[job-metadata]: https://docs.livekit.io/agents/server/agent-dispatch/#job-metadata
[passing-state]: https://docs.livekit.io/agents/logic/agents-handoffs/#passing-state
[initial-context]: https://docs.livekit.io/agents/logic/external-data/#initial-context
[chat-context]: https://docs.livekit.io/agents/logic/chat-context/
[function-tools]: https://docs.livekit.io/agents/logic/tools/definition/#runcontext
[turn-hook]: https://docs.livekit.io/agents/logic/nodes/#on-user-turn-completed
[session-lifecycle]: https://docs.livekit.io/agents/logic/sessions/#lifecycle
[session-userdata]: https://github.com/livekit/agents-js/blob/5e53527872b94789d445f2a829cfc43d00e9567a/agents/src/voice/agent_session.ts#L496-L575
[run-context]: https://github.com/livekit/agents-js/blob/5e53527872b94789d445f2a829cfc43d00e9567a/agents/src/voice/run_context.ts#L56-L72
[agent-updates]: https://github.com/livekit/agents-js/blob/5e53527872b94789d445f2a829cfc43d00e9567a/agents/src/voice/agent.ts#L368-L395
[activity-instructions]: https://github.com/livekit/agents-js/blob/5e53527872b94789d445f2a829cfc43d00e9567a/agents/src/voice/agent_activity.ts#L543-L589
[generation-trace]: https://github.com/livekit/agents-js/blob/5e53527872b94789d445f2a829cfc43d00e9567a/agents/src/voice/generation.ts#L542-L582
[llm-call]: https://github.com/livekit/agents-js/blob/5e53527872b94789d445f2a829cfc43d00e9567a/agents/src/voice/agent.ts#L461-L488
