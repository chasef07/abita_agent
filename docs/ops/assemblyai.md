# AssemblyAI transcription and LiveKit turn completion

The runtime uses `@livekit/agents-plugin-assemblyai` 1.8.0 directly with
`universal-3-5-pro`. Set `ASSEMBLYAI_API_KEY` in the worker environment.
LiveKit credentials remain necessary for the audio turn detector, adaptive
interruptions, and other inference services.

## Recognition settings

Ordinary conversation uses `mode: "balanced"`. Entity recognition preserves
the configured STT values from main `764049b`:

| Recognition profile | STT minimum silence | STT maximum silence | Fixed LiveKit min/max delay |
|---|---:|---:|---:|
| Ordinary conversation (balanced) | 128 ms | 1280 ms | 300/600 ms |
| Insurance | 400 ms | 3000 ms | 500/2500 ms |
| Member ID | 450 ms | 3000 ms | 500/2500 ms |
| Intake, name, DOB | 450 ms | 3500 ms | 500/2500 ms |
| Email | 500 ms | 4000 ms | 500/2500 ms |

The minimum allows AssemblyAI to finalize when speech appears complete. The
maximum bounds its wait when speech appears incomplete. Equal limits would
remove that additional waiting interval; the migration does not adopt the
experimental 100/100 or 1500/1500 ms windows.

Preserve vocabulary lists, profile-selection cues, language detection, provider
VAD threshold 0.3, and the 30-second inactivity timeout. Both transports send
16 kHz mono audio in 50 ms buffers. No domain prompt, context-history count,
legacy EOT-confidence override, or turn-formatting override is added.

At initial construction, set `mode: "balanced"` without explicit silence overrides.
Plugin 1.8.0 cannot serialize a live `mode` update, so returning from an entity
profile explicitly restores balanced's documented 128/1280 ms silence defaults.
Only silence and vocabulary are changed for entity capture; the preset and
existing VAD sensitivity remain in effect. Reconnects retain the active profile.
Recheck these reset values when
upgrading the provider or plugin.
The plugin uses typed camel-case options and serializes the provider's
snake-case wire fields. Preserving configured values does not prove identical
provider behavior or latency through the former inference gateway.

## LiveKit turn ownership

Keep `inference.TurnDetector()` and its native thresholds, fixed endpointing,
Silero activation 0.3 / deactivation 0.15, and adaptive interruption handling.
Dynamic endpointing, preemptive generation, preemptive TTS, and ForceEndpoint
remain off.

AssemblyAI finalizes transcript chunks; LiveKit decides when the accumulated
transcript becomes a conversational user turn. A positive audio completion
prediction selects the minimum LiveKit delay; an uncertain prediction selects
the maximum. Elapsed silence is deducted. These are alternative paths, not two
sequential waits.

## Context and profile lifecycle corrections

Generated TTS text may contain an unspoken question after interruption. It can
arm recognition early, but only SDK-committed assistant `ConversationItemAdded`
text updates `agentContext` and the remembered profile for follow-up questions.
Context is capped at the latest 1500 characters. The controller owns forwarding;
leave the plugin's separate `agentContextCarryover` option disabled.

A final STT chunk is not necessarily the caller's complete answer. Retain the
active recognition and endpointing profiles through intermediate finals; reset
both when the user conversation item is committed. Context-only updates leave
endpointing unchanged. Entity timing values and all profile cues remain
unchanged; ordinary timing and when a profile resets are intentional changes.

SDK-committed text remains subject to playback-alignment limits. This change
does not guarantee word-exact correspondence with what the caller heard.

## Verification and limits

Regression tests cover interrupted/unspoken questions, follow-up inheritance,
context limits, profile retention through multiple finalized chunks, reset on
user commitment, and actual fixed endpointing transitions in an AgentSession.
Option tests pin the balanced constructor, unchanged entity values, and explicit
balanced silence restoration after each committed entity answer.

Earlier equal-window, balanced, dynamic, and ForceEndpoint experiments do not
validate the complete migrated conversation lifecycle. The user selected balanced
for ordinary speech while retaining existing entity protection.
The transport still changes authentication, billing, connection behavior, and
provider routing; configure the AssemblyAI credential before deployment and
verify representative conversations before claiming behavioral parity.

[LiveKit AssemblyAI integration](https://docs.livekit.io/agents/models/stt/assemblyai/)
and [AssemblyAI turn detection](https://www.assemblyai.com/docs/streaming/turn-detection)
describe the provider and turn-handling contracts.
