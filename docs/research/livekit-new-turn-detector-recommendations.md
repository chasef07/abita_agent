# LiveKit audio turn detector recommendations

Research date: 2026-07-23. Scope: LiveKit's current audio
`inference.TurnDetector`, not the older transcript-based `MultilingualModel`.

## Official recommendation

LiveKit recommends the audio turn detector for most agents and enables it by
default. It combines semantic and acoustic evidence on top of VAD. The
audio-detector-specific endpointing defaults are fixed `300ms` minimum and
`2500ms` maximum, versus the general fixed `500ms`/`3000ms` defaults. The audio
detector requires at least `250ms` of VAD silence.

Sources:

- [Turns overview](https://docs.livekit.io/agents/logic/turns/)
- [Audio turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector/)
- [Node streaming endpointing defaults](https://docs.livekit.io/reference/agents-js/variables/agents.voice.streamingEndpointingOptions.html)

## Fixed versus dynamic

Fixed endpointing is the documented default. The current turn-taking tuning
guide also uses fixed endpointing in its recommended starting configuration.
Dynamic endpointing is optional: LiveKit says it adapts within the configured
bounds using session pause statistics and "suits most conversations," but it is
not the audio detector's default.

The two statements are compatible but easy to overread: LiveKit recommends the
audio model itself, while presenting fixed endpointing as the default and
dynamic endpointing as an optional personalization mode.

Sources:

- [Turn-taking tuning](https://docs.livekit.io/agents/logic/turns/tuning/)
- [Turn handling options](https://docs.livekit.io/reference/agents/turn-handling-options/)

## Separate AssemblyAI alternative

LiveKit's AssemblyAI Universal-3.5 Pro guide documents a different ownership
model: set `turnDetection: "stt"`, let AssemblyAI own the end-of-turn signal,
and set LiveKit `endpointing.minDelay` to `0` so LiveKit does not add another
delay. Its example uses `minTurnSilence: 100`, `maxTurnSilence: 1000`, and
aligned VAD activation threshold `0.3`.

This is an alternative to the LiveKit audio turn detector. When
`inference.TurnDetector()` is configured, it takes precedence; AssemblyAI's
end-of-turn signal is used only with `turnDetection: "stt"`.

Source:

- [AssemblyAI STT turn detection](https://docs.livekit.io/agents/models/stt/assemblyai/)

## Abita implication

LiveKit does not recommend `0-400ms` as the standard configuration for its new
audio detector. The closest official starting point is the fixed
audio-detector default of `300-2500ms`. Lower fixed bounds are an
application-specific latency tradeoff and require validation against premature
turn commits.

For Abita, production evidence that dynamic history drifts upward supports
returning to fixed endpointing while retaining the audio detector. A separate
test of AssemblyAI-owned endpointing should switch ownership explicitly rather
than combining both detectors.
