# AssemblyAI transcription and LiveKit turn completion

The runtime uses LiveKit Inference with `assemblyai/universal-3-5-pro`.
LiveKit credentials cover STT; no separate AssemblyAI key is required for voice
calls. The direct AssemblyAI plugin remains a development dependency for
optional comparison replays only.

## Turn handling

Keep `inference.TurnDetector()` and its calibrated language thresholds. VAD
remains Silero at activation 0.3 / deactivation 0.15, with the SDK's 250 ms
silence window. Adaptive interruption handling is unchanged.

| Recognition profile | Fixed LiveKit min/max delay | STT min/max silence |
|---|---:|---:|
| Ordinary conversation | 300/600 ms | 100/100 ms |
| Insurance, member ID, intake/names/DOB, email | 500/2500 ms | 1500/1500 ms |

Dynamic endpointing is off. Both `preemptiveGeneration.enabled` and
`preemptiveTts` are false. The controller switches fixed endpointing bounds when
moving between ordinary and entity recognition. A finalized STT chunk does not
reset either profile; the committed conversational user turn resets both.
Assistant context-only updates do not replace the endpointing strategy.

AssemblyAI finalizes transcript chunks; LiveKit's audio model and endpointing
policy decide when they become a conversational turn. A positive audio
completion prediction selects the minimum; an uncertain prediction selects the
maximum. These are alternative paths, with elapsed silence deducted, not two
sequential waits. Short STT windows do not promise equally short transcription
latency because recognition and transport still take time.

Equal 1500 ms STT limits preserve the tested within-entity pauses without the
old 3–4 second finalization maximum. They do not protect arbitrarily long
pauses, and they add delay to complete short names. Model false positives can
still split unfinished scheduling phrases. This remains a draft configuration
requiring a representative conversational pilot.

## Context and vocabulary

Supply the most recent SDK-committed assistant message as `agent_context`,
capped at 1500 characters. Generated TTS input may arm recognition early; only
committed output updates context and the remembered profile for follow-up
questions. This avoids using an unspoken question when the SDK supplies the
interrupted committed text. SDK text alignment is not guaranteed to be exactly
what the caller heard in every playback configuration.

Keep the conservative office vocabulary for ordinary speech and the payer/plan
list for insurance. Intake, member IDs, and email use empty keyterm lists.
These improve recognition, not patient matching or insurance verification.
The runtime and middleware still own those decisions.

Language detection remains enabled, provider VAD threshold stays at 0.3, and
inactivity timeout remains 30 seconds. No domain prompt, context-history count,
legacy EOT-confidence override, or turn-formatting override is configured.

## Inference versus the direct plugin

Both transports expose the settings this agent uses: Universal-3.5 Pro,
keyterms, agent context, and silence limits. The inference SDK sends live
`modelOptions` changes using `session.update`; AssemblyAI supports applying
these changes without reconnecting.
[LiveKit AssemblyAI documentation](https://docs.livekit.io/agents/models/stt/assemblyai/)

For the pinned SDK and currently observed gateway behavior, use
`min_end_of_turn_silence_when_confident` for the tested minimum-silence behavior.
The application maps its minimum to that field. In controlled paired replays,
using the newer direct-API name `min_turn_silence` through inference allowed a
paused-name prefix to finalize before the requested 1500 ms; the SDK field
preserved the pause. This is an observed gateway compatibility constraint,
not a claim that the public direct API rejects its newer field. Recheck the
contract before changing SDK/gateway versions or switching parameter names.

The direct plugin adds a `SpeechStream.forceEndpoint()` operation and provider
session details, and uses separate AssemblyAI authentication, billing, and rate
limits. The current runtime needs none of those extras. The plugin does not
provide a different recognition model or an established accuracy advantage.

A local early-prediction bridge was tested in 12 executions. It accelerated
complete name/DOB answers but reduced whole-answer acceptance from 5/6 to 3/6
by splitting paused names and insurance. The runtime does not force endpoints;
the diagnostic prototype was not integrated into the application.

## Evidence and limits

The [initial evaluation](assemblyai-plugin-evaluation.md) and
[controlled follow-up](assemblyai-endpointing-followup.md) document historical
plugin/dynamic experiments. Their latency figures do not describe this revised
inference/fixed configuration. The [developer documentation audit](assemblyai-docs-audit.md)
records the context-lifecycle findings from the plugin trial.

Unit and SDK integration tests cover inference option serialization, committed
assistant context, interrupted follow-up history, profile retention through
transcript chunks, and actual fixed endpointing transitions. Existing
preemptive-generation tests exercise a disabled capability and do not mean it is
enabled in production. Audio replay evidence excludes live LLM/TTS, SIP,
backend effects, and complete adaptive interruption behavior.

### Revised configuration validation

After restoring inference and fixed profiles, eight exported-configuration
replays preserved 7/8 exact whole answers. The known unfinished scheduling
fixture still split. The short negative reply committed in 717 ms; complete
name/DOB took 1988/1863 ms. All executions were valid with no warnings or
transcription timeouts and 38 ms maximum pacing drift. This is a small smoke
suite, not a production acceptance rate or a matched provider-speed ranking.

The minimum-field investigation used nine separate paired executions: two
runs of the same paused-name waveform and one complete DOB per transport/field.
The plugin and inference using the SDK field each preserved 3/3; inference
using the newer field preserved 2/3, with early prefix finals in both name
runs. Maximum pacing drift was 18 ms. An earlier broader inference run was
stopped to investigate that failure and is not represented as a completed suite.

An open inference stream then exercised actual controller context/profile
updates for insurance, a paused name, and an ordinary closing reply. All three
exact values were retained, with no transport/profile errors and 10 ms maximum
pacing drift. Final-transcript delays were 1891/1973/495 ms. Entity settings
survived final transcripts and reset on commit; fixed bounds transitioned
500/2500 to 300/600 twice. This proves live update acceptance and observed
recognition behavior, not the causal accuracy benefit of agent context or full
conversational playback.
