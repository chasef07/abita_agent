# AssemblyAI transcription and LiveKit turn completion

The runtime uses `@livekit/agents-plugin-assemblyai` 1.8.0 directly with
`universal-3-5-pro`. Set `ASSEMBLYAI_API_KEY` in the worker environment before
starting or deploying the agent. The key belongs in local environment files or
LiveKit secrets, never source control. LiveKit credentials remain required for
LLM inference, the audio turn detector, and adaptive interruptions.

## One conversational turn owner

`inference.TurnDetector()` remains the conversational turn detector with its
server-calibrated language thresholds. The tested 0.9 override is not enabled. AssemblyAI
finalizes transcript chunks; those chunks do not independently end a LiveKit
turn. Multiple finalized chunks can form one committed user message.

Normal STT uses matching `minTurnSilence` and `maxTurnSilence` of 100 ms,
explicitly matching the plugin's low-latency chunking defaults. This removes the
previous independent 2-second STT silence ceiling. It does not promise a 100 ms
transcription latency: model processing, transport, and audio conditions remain.

The session uses dynamic endpointing with a 300 ms floor, 2,500 ms ceiling, and
alpha 0.9. A low end-of-turn probability selects the ceiling; otherwise the
SDK uses its learned minimum. Bounds stay constant for the call because
`session.updateOptions` replaces the endpointing state and loses learned pauses.
The longer ceiling protects unfinished answers and is not a mandatory wait for
every answer. This is an experimental starting configuration, not a universal optimum.
The wider maximum also delayed a complete short negative answer in the local
holdout. The evaluation records that regression; this is a draft, not a rollout
recommendation.

LLM-only preemptive generation is enabled; TTS waits for turn confirmation.
LiveKit owns speculative cancellation and tool authorization. Regression tests
cover corrected input, changing patient context, and deferred/discarded tools.
See [preemptive generation](preemptive-generation.md).

## Intake recognition

Prompt-sensitive profiles retain vocabulary and additional chunk context:

| Profile | Minimum / maximum silence (ms) | Vocabulary |
|---|---:|---|
| Default | 100 / 100 | Conservative office terms |
| Insurance | 1500 / 1500 | Payer and plan terms |
| Member ID | 1500 / 1500 | No payer bias |
| Intake / names / spelling | 1500 / 1500 | No payer bias |
| Email | 1500 / 1500 | No payer bias |

These values control transcript segmentation, not the conversational deadline.
Names also use the intake window: the attempted faster semantic profile split
first/last-name fixtures when a later transcript arrived after LiveKit committed.
This protection adds delay to an uninterrupted short name.
The latest SDK-committed assistant message is passed as `agentContext`, capped
at 1500 characters. TTS input arms recognition early but does not update agent
context or remembered follow-up history. Interrupted committed text replaces
the generated question when the SDK provides it. A profile stays
active across partial and final STT segments and resets only after LiveKit
commits the user message. A request to repeat or spell a detail retains its
previous prompted profile. Endpointing learning is unaffected by these updates.

The existing Silero sensitivity (activation 0.3, deactivation 0.15) and 250 ms
silence window remain. Krisp telephony filtering remains ahead of recognition;
no second AssemblyAI Voice Focus filter is enabled. English/Spanish evidence
continues to consume the plugin's nested language-confidence metadata.

## ForceEndpoint

The plugin exposes `SpeechStream.forceEndpoint()`, which sends AssemblyAI's
`ForceEndpoint` message. That method is not automatically called by LiveKit's
audio turn detector. The SDK's public EOT event is emitted along the transcript-
gated commit path, so attaching a force request there does not resolve the first
missing final transcript.

This integration uses the plugin's short transcript windows with the standard
LiveKit turn pipeline. It does not add a second detector, monkey-patch SDK
internals, or force transcription at every VAD pause. An explicit force test
establishes the provider API separately from the application architecture.

## Verification

The audio comparison and its limitations are recorded in
[assemblyai-plugin-evaluation.md](assemblyai-plugin-evaluation.md).
Unit and SDK integration tests cover direct option names, profile lifetime,
dynamic state preservation, and preemptive tool gating. Recorded replays do not
prove production SIP routing or complete interactive interruption behavior.

Before deploying, provision `ASSEMBLYAI_API_KEY` on the target LiveKit agent.
This PR changes source configuration; it does not deploy or rotate hosted secrets.

Sources: [LiveKit AssemblyAI integration](https://docs.livekit.io/agents/models/stt/assemblyai/),
[AssemblyAI turn detection](https://www.assemblyai.com/docs/streaming/turn-detection),
and the installed plugin/Agents 1.8.0 source.

A parameter-by-parameter review, context lifecycle correction, and plugin gaps
are recorded in [the developer-docs audit](assemblyai-docs-audit.md).
