# LiveKit end-to-end latency and endpointing

Research date: 2026-07-23. Scope: the installed `@livekit/agents` 1.5.3
STT-LLM-TTS pipeline. The pinned upstream source links below were compared with
the installed package; the metric and endpointing code paths described here
match.

## Verdict

LiveKit's `ChatMessage.metrics.e2eLatency` is correctly described as:

```text
assistant playback-start timestamp - estimated user speech-stop timestamp
```

It is measured in **seconds**. For Abita's normal room audio output, however,
"playback start" means that the agent worker has begun pushing the first audio
frame into LiveKit's RTC audio source. It is **not proof that the SIP caller has
heard the frame**. WebRTC/SIP delivery, client jitter buffering, carrier transit,
and handset playback after that push are outside this metric. LiveKit's official
docs call it the time from user speech stop until the agent begins responding;
the source gives the more exact boundary. [LiveKit latency docs][latency-docs]
[E2E calculation][agent-metrics] [room output playback event][room-output]

Therefore, Acuity should label this value **agent response latency** or
**LiveKit E2E latency**, not caller-heard latency. Store and transmit the raw
value as seconds; convert to milliseconds only as `seconds * 1000` for display.

## Exact metric lifecycle

| Metric | Unit | Start | End | Important qualification |
|---|---:|---|---|---|
| `endOfTurnDelay` | seconds | LiveKit's estimated `stoppedSpeakingAt` | the instant the user turn is committed | Includes the chosen endpointing delay and any preceding wait for transcript/prediction. It is not LLM latency. |
| `llmNodeTtft` | seconds | entry into the LLM node, immediately before invoking the node/provider stream | first item yielded by that stream | The implementation marks the first stream chunk, which need not be caller-visible text; it may be an empty, tool-call, or metadata-bearing chunk. |
| `ttsNodeTtfb` | seconds | first text sent to the TTS provider for the segment | first `AudioFrame` returned by the TTS node | This is provider-node TTFB, not time from user stop and not socket-level first byte. The provider plugin can supply the exact send timestamp. |
| `playbackLatency` | seconds | first audio frame received from TTS and offered to `AudioOutput` | `AudioOutput`'s playback-start event | Near zero for the normal room output; meaningful for an avatar that reports actual remote start. It excludes TTS generation. |
| `e2eLatency` | seconds | user `stoppedSpeakingAt` | first playback-start event for the assistant response | Includes endpointing plus all pipeline work on the critical path, but excludes downstream network/caller playout for the normal room output. |

Source details:

- The user stop, final-transcript, and turn-commit timestamps are wall-clock
  millisecond values. `endOfTurnDelay` is `commitNow - lastSpeakingTime`, then
  divided by 1000 before it is attached to the user message.
  [metric calculation][eot-metrics] [seconds conversion][user-metrics]
- LLM TTFT starts before `node(...)` and stops on the first yielded chunk, before
  the chunk's content is inspected. [LLM node timing][llm-timing]
- TTS timing is anchored when text is sent to the provider and stops on the
  first audio frame. [TTS provider anchor][tts-anchor] [TTS first frame][tts-timing]
- Audio forwarding records its own first-frame timestamp, then resolves
  playback start from `AudioOutput.EVENT_PLAYBACK_STARTED`.
  [audio forwarding][audio-forwarding] [playback event][playback-event]
- The complete assistant `ChatMessage`, including metrics, is added only after
  playout completes (or an interruption commits partial playout). The metric's
  endpoint is still the earlier first-playback timestamp; event delivery time
  must not be substituted for it. [assistant message commit][message-commit]

These fields are **not additive**. Streaming overlaps LLM, TTS, and forwarding;
preemptive generation can overlap LLM work with endpointing; and framework
callbacks/queueing are not separate fields. In particular, do not calculate
E2E as `endOfTurnDelay + llmNodeTtft + ttsNodeTtfb + playbackLatency`. Use the
reported `e2eLatency` directly.

## Why `endOfTurnDelay = 2.501s` occurred

Abita constructs the audio `inference.TurnDetector` and does not override
endpointing. The installed SDK therefore selects its streaming-detector defaults:
fixed `minDelay: 300ms` and `maxDelay: 2500ms`. [LiveKit endpointing defaults][turn-defaults]
[upstream defaults][endpointing-source]

The implementation begins at `minDelay`. When the detector returns an
end-of-turn probability below its calibrated "unlikely" threshold, it switches
the delay to `maxDelay`. It then sleeps only until
`lastSpeakingTime + endpointingDelay`, and finally computes the metric from that
same `lastSpeakingTime`. [detector decision][detector-decision]
[absolute deadline][endpoint-deadline]

Consequently, **2.501 seconds strongly indicates the intended 2500ms max-delay
branch plus about 1ms of timer/scheduling overhead**. A detector timeout would
not explain that value: on timeout, the source commits without a prediction and
leaves the delay at the 300ms minimum. The causal proof for an individual turn
is its `eou_detection` trace attributes: `lk.eou_probability`,
`lk.eou_unlikely_threshold`, `lk.eou_delay`, `lk.eou_source`, and
`lk.eou_from_cache`.

This value is independent of Inkling or Rime. Model/TTS behavior begins after or
overlaps the turn decision; Rime `segment=never` can increase TTS/E2E latency but
cannot create a 2.501s `endOfTurnDelay`.

The production aggregate supplied for this review independently matches that
source explanation. Over the last 14 days, 27,728 user turns had p50 `303ms`,
p75 `421ms`, p90 `2500ms`, and p95 `2501ms`; 5,215 turns (18.8%) landed in the
2450-2550ms backstop band. Restricting to SDK 1.5.3 gives 9,493 samples, p50
`301ms`, p90 `2500ms`, and an 18.6% backstop rate. This is a stable two-path
distribution around the SDK's 300ms/2500ms choices, not an isolated timer spike.

## Current Abita settings

- Audio turn detector: `new inference.TurnDetector()` in `src/main.ts`.
- Endpointing: fixed `300-600ms` for normal conversation. Insurance, member ID,
  intake/DOB/address, and email prompts temporarily use fixed `500-2500ms`,
  beginning as the prompt enters TTS and ending when LiveKit commits the
  caller's message.
- VAD: no explicit VAD is supplied, so LiveKit auto-provisions its bundled
  Silero VAD. Installed defaults are `minSpeechDuration: 50ms`,
  `minSilenceDuration: 250ms`, activation `0.5`, deactivation `0.35`.
  [default VAD creation][vad-creation] [default VAD settings][vad-defaults]
- Preemptive generation: enabled for the LLM, with preemptive TTS off,
  `maxSpeechDuration: 4000ms`, and one retry in `src/session-options.ts`.
- STT: AssemblyAI Universal-3.5 Pro, with a base `275-2000ms` provider turn
  silence window and longer prompt-specific profiles in `src/stt-config.ts`.

The production aggregate above predates the explicit endpointing experiments
and is the baseline the normal-conversation profile is intended to improve.

Preemptive generation can hide some LLM work behind the endpointing wait, but it
does not reduce `endOfTurnDelay`. With `preemptiveTts: false`, TTS still waits for
the confirmed turn. This matches LiveKit's safe default; enabling preemptive TTS
can lower latency at the cost of synthesis that is discarded when the
speculative response changes. [preemptive generation docs][preemptive-docs]
[preemptive source][preemptive-source]

## Safest low-latency recommendation

Keep the audio turn detector, default VAD, adaptive interruption handling, and
LLM-only preemptive generation. Do not lower the VAD silence below 250ms: the
audio turn detector requires at least that much audio silence, and Abita is
already at the minimum supported/default value. Do not switch directly to
VAD-only unless accepting more mid-thought cutoffs is an explicit product
tradeoff; LiveKit recommends the turn detector for most agents and identifies
VAD-only as the minimal-latency option. [turn detection guidance][turns-docs]

The selected latency configuration preserves the semantic detector while using
fixed endpointing for normal conversation:

```ts
endpointing: {
  mode: "fixed",
  minDelay: 300,
  maxDelay: 600,
}
```

This leaves confident turns on the 300ms path and caps turns the detector thinks
may continue at 600ms without learning delay from session history. Structured
dictation prompts temporarily use fixed `500-2500ms`, then return to the normal
profile after the caller's message is committed. These are Abita-specific
settings, not LiveKit defaults. Validate the tighter normal ceiling against
false cutoffs, immediate caller resumptions, and the EOU
probability/threshold traces before lowering it further.

There is also a provider-aligned alternative: LiveKit's official AssemblyAI
Universal-3.5 Pro example uses `turnDetection: "stt"` with `minDelay: 0`, because
that STT already owns phrase endpointing; its low-latency example sets provider
silence to `100/1000ms`. [AssemblyAI integration guidance][assemblyai-docs] This
reconciles the docs: the audio detector is LiveKit's general recommendation,
while STT mode is its provider-specific recommendation when Universal-3.5 Pro
owns the turn signal. Switching owners is a broader lifecycle change than
capping `maxDelay`, and Abita's current base is `275/2000ms` with prompt-specific
maxima reaching 3-4 seconds. Test STT ownership and its provider timings
separately rather than combining both changes.

[latency-docs]: https://docs.livekit.io/agents/ops/logging/#per-turn-latency
[turn-defaults]: https://docs.livekit.io/agents/logic/turns/turn-detector/#endpointing-defaults
[turns-docs]: https://docs.livekit.io/agents/logic/turns/#turn-detection
[preemptive-docs]: https://docs.livekit.io/agents/multimodality/audio/#preemptive-speech-generation
[assemblyai-docs]: https://docs.livekit.io/agents/models/stt/assemblyai/#turn-detection
[agent-metrics]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/agent_activity.ts#L3086-L3108
[room-output]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/room_io/_output.ts#L425-L450
[eot-metrics]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/audio_recognition.ts#L104-L130
[user-metrics]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/agent_activity.ts#L2405-L2418
[llm-timing]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/generation.ts#L575-L605
[tts-anchor]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/tts/tts.ts#L355-L370
[tts-timing]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/generation.ts#L715-L804
[audio-forwarding]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/generation.ts#L908-L918
[playback-event]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/generation.ts#L1068-L1089
[message-commit]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/agent_activity.ts#L3185-L3203
[endpointing-source]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/turn_config/endpointing.ts#L38-L55
[detector-decision]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/audio_recognition.ts#L1392-L1484
[endpoint-deadline]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/audio_recognition.ts#L1591-L1598
[vad-creation]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/agent_session.ts#L523-L535
[vad-defaults]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/inference/vad.ts#L22-L47
[preemptive-source]: https://github.com/livekit/agents-js/blob/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f/agents/src/voice/turn_config/preemptive_generation.ts#L8-L42
