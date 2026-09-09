# Preemptive generation

Preemptive generation is disabled in `src/session-options.ts`. The following
describes the existing capability and tests for a future controlled pilot.
LiveKit can begin a model request before turn detection finishes. It still owns
turn confirmation, speech scheduling, cancellation, and tool execution;
`preemptiveTts: false` defers speech synthesis until the turn is confirmed.

`src/agent.ts` projects clinic time and patient/availability context inside
`llmNode`. Adding the timestamp in the completed-turn hook would invalidate
every speculative request, preventing reuse even on otherwise stable turns.

The completed-turn hook compares current model input
with the request snapshot. Changed patient state, availability, office, or clinic
time forces a fresh request. An intervening model request with different state
also invalidates speculation, so recovery cannot hide an older stale request.
Office Knowledge additions retain LiveKit's normal context invalidation.
Snapshots whose user message has already committed are replaced on the next
model request, so prior-turn state does not invalidate fresh speculation.

The regression suite in `src/__tests__/preemptive-generation.test.ts` exercises
the installed LiveKit turn pipeline with a fake model: stable and consecutive-turn reuse,
unresolved name mentions, resolver promotion after turn commitment, availability
changes, midnight rollover, overlapping recovery, and deferred or discarded
tool execution. Identity resolution runs through the tool, outside the completed-turn hook. It makes no live
provider calls and does not establish production latency.

Before deployment, compare controlled calls for response latency and model
requests per committed turn. Discarded speculation can increase token usage.
Check interruptions, corrected utterances, identity changes, and booking/transfer
outcomes. The current speech guard, tokenizer, and Rime transport are unchanged.
