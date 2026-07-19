# Simplest LiveKit SIP transfer tool

## Conclusion

`RunContext.waitForPlayout()` is not required by
`SipClient.transferSipParticipant()`. It only orders assistant audio before the
tool side effect. The smallest supported transfer path is:

```ts
execute: async (_, { ctx }) => {
  ctx.disallowInterruptions(); // optional transfer policy; not a SIP requirement

  try {
    await sipClient.transferSipParticipant(
      roomName,
      participantIdentity,
      transferTo,
    );
    return "Transfer started.";
  } catch {
    return "Could not transfer the call.";
  }
},
```

If the product wants the transfer to happen immediately, removing
`waitForPlayout()` is safe for the SIP operation and removes a separate media
wait. The tradeoff is caller experience: if the model speaks a transfer notice
and calls the tool in the same assistant step, the cold transfer can end the
LiveKit session before that notice finishes. Keep the wait only when fully
playing that notice is a hard requirement.

## What each operation means

### `ctx.waitForPlayout()`

- Installed `@livekit/agents` is `1.5.2`
  (`node_modules/@livekit/agents/package.json:3`).
- Its implementation waits for the spoken response associated with the tool's
  function-call step. It does not inspect or prepare SIP state
  (`node_modules/@livekit/agents/src/voice/run_context.ts:73-83`).
- The official cold-transfer example creates a transfer notice and then waits
  for its playout before calling the SIP API. That is an audio-ordering choice,
  not an API prerequisite.
- `transferSipParticipant()` accepts only room name, participant identity,
  destination, and transfer options; it has no `RunContext` or playout
  dependency
  (`node_modules/livekit-server-sdk/src/SipClient.ts:837-875`).

Therefore, an agent that does not require a fully played transfer notice can
call the SIP API directly. A prompt does not guarantee that a same-step notice
finishes playing; only the wait provides that guarantee.

### `ctx.disallowInterruptions()`

- In installed Agents `1.5.2`, this sets the owning speech handle's
  `allowInterruptions` flag to `false`
  (`node_modules/@livekit/agents/src/voice/run_context.ts:89-91`).
- A non-interruptible speech handle rejects normal interruption requests
  (`node_modules/@livekit/agents/src/voice/speech_handle.ts:163-203`).
- The tool executor also refuses LLM/user-initiated cancellation of a
  cancellable tool while interruptions are disallowed
  (`node_modules/@livekit/agents/src/voice/tool_executor.ts:295-307`).
- LiveKit recommends disabling interruptions at the start of mutating tools so
  user speech cannot leave a side effect half-done.

This call does not wait for speech and is not required by SIP. It is an optional
policy for making the transfer side effect non-interruptible once started. One
edge case is visible in the installed setter: disabling interruptions after the
speech handle has already been interrupted throws
(`node_modules/@livekit/agents/src/voice/speech_handle.ts:163-179`).

### What `transferSipParticipant()` resolution proves

- Installed `livekit-server-sdk` is `2.17.0`
  (`node_modules/livekit-server-sdk/package.json:3`).
- The method returns `Promise<void>` and resolves only after the
  `TransferSIPParticipant` RPC returns without an error; errors are converted to
  `SipCallError`/`ServerError`
  (`node_modules/livekit-server-sdk/src/SipClient.ts:837-875`;
  `node_modules/livekit-server-sdk/src/TwirpRPC.ts:73-95`).
- The public SIP API returns an empty response, not a transferred participant,
  bridge, or callee status object.
- Current official SIP service source sends REFER, treats 100-199 NOTIFY status
  as still trying, 200 as success, and other final statuses as failure. It also
  has a path that returns success when REFER was accepted but the original call
  ends before a final transfer result arrives.

So a resolved promise proves a successful, error-free LiveKit transfer RPC
under the server's contract. It does **not** independently prove that a human
answered or that a usable conversation began at the destination. That stronger
claim requires downstream provider/session evidence.

## Primary sources

- [LiveKit call forwarding guide](https://docs.livekit.io/telephony/features/transfers/cold/)
- [LiveKit SIP API: `TransferSIPParticipant`](https://docs.livekit.io/reference/telephony/sip-api/#TransferSIPParticipant)
- [LiveKit Agents JS `RunContext`](https://docs.livekit.io/reference/agents-js/classes/agents.voice.RunContext.html)
- [LiveKit tool design: disable interruptions on writes](https://docs.livekit.io/agents/logic/tools/design/#disable-interruptions-on-writes)
- [LiveKit SIP REFER request handling](https://github.com/livekit/sip/blob/32ea43c5a7e1c52a76dd541fe00a5aef49973429/pkg/sip/protocol.go#L312-L335)
- [LiveKit SIP REFER NOTIFY result handling](https://github.com/livekit/sip/blob/32ea43c5a7e1c52a76dd541fe00a5aef49973429/pkg/sip/protocol.go#L392-L425)
- [LiveKit SIP early-call-end result path](https://github.com/livekit/sip/blob/32ea43c5a7e1c52a76dd541fe00a5aef49973429/pkg/sip/inbound.go#L2204-L2229)
- [LiveKit SIP transfer RPC completion](https://github.com/livekit/sip/blob/32ea43c5a7e1c52a76dd541fe00a5aef49973429/pkg/sip/service.go#L343-L400)
