# AssemblyAI U3 Pro STT — Design Decisions

Switched STT from Deepgram Nova-3 to AssemblyAI Universal-3 Pro Streaming on 2026-04-06. The app now uses the official Node plugin, `@livekit/agents-plugin-assemblyai`, instead of the old local wrapper.

## Key decisions

**Official Node plugin:** Using `new assemblyai.STT({ speechModel: "u3-rt-pro" })` from `@livekit/agents-plugin-assemblyai` with a direct `ASSEMBLYAI_API_KEY`. This keeps billing and rate limits on the AssemblyAI side while avoiding the repo-local wrapper we had before.

**STT-based turn detection (`turnDetection: "stt"`):** Both LiveKit and AssemblyAI docs recommend this as the primary approach for U3 Pro. The model has built-in punctuation-based turn detection (checks for `.` `?` `!` after silence). MultilingualModel is only an alternative if you specifically want a third-party model making turn decisions on top.

**Endpointing minDelay set to 0:** LiveKit's default 0.5s delay is additive on top of AssemblyAI's own endpointing — pure extra latency. AssemblyAI's `min_turn_silence` and `max_turn_silence` already control timing.

**No language pinned:** U3 Pro auto-detects and code-switches between English, Spanish, German, French, Portuguese, and Italian. Omitting `language` lets it detect automatically — important since callers may speak Spanish.

**VAD thresholds aligned at 0.3:** U3 Pro defaults its internal VAD to 0.3. Silero must match to avoid a dead zone where AssemblyAI is transcribing but LiveKit hasn't detected speech yet, delaying barge-in. Silero is still recommended with STT turn detection for faster local interruption handling — LiveKit uses whichever speech-start signal arrives first.

**Noise cancellation removed from agent pipeline:** AssemblyAI recommends no audio pre-processing — NC artifacts hurt transcription more than background noise. SIP trunk-level noise/echo cancellation (Telnyx) is fine and separate from this.

## Parameters

```
min_turn_silence: 250   — silence (ms) before speculative EOT check (punctuation-based)
max_turn_silence: 2000  — max silence (ms) before forced turn end
vad_threshold: 0.3      — AssemblyAI internal VAD, must match Silero
```

## Tuning notes

- Increase `min_turn_silence` if brief pauses cause early EOT on terminal punctuation
- Increase `max_turn_silence` if forced turn end cuts off users mid-thought or splits entities (phone numbers, DOBs) across turns
- Can use `stt.updateOptions({ maxTurnSilence: 3000 })` mid-stream during entity dictation, then reset after
- `keytermsPrompt` is available to boost recognition of specific terms (provider names, insurance carriers, etc.)
