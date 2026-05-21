# AssemblyAI U3 Pro STT — Design Decisions

Switched STT from Deepgram Nova-3 to AssemblyAI Universal-3 Pro Streaming on 2026-04-06. The active runtime now uses the direct `@livekit/agents-plugin-assemblyai` plugin with `ASSEMBLYAI_API_KEY`.

## Key decisions

**Direct AssemblyAI plugin:** Using `new assemblyai.STT(getAssemblyAISttOptions())` from `@livekit/agents-plugin-assemblyai`. This keeps STT on AssemblyAI U3 Pro while preserving direct AssemblyAI runtime options and profile updates.

**STT-based turn detection (`turnDetection: "stt"`):** Both LiveKit and AssemblyAI docs recommend this as the primary approach for U3 Pro. The model has built-in punctuation-based turn detection (checks for `.` `?` `!` after silence). MultilingualModel is only an alternative if you specifically want a third-party model making turn decisions on top.

**Endpointing minDelay set to 0:** LiveKit's default 0.5s delay is additive on top of AssemblyAI's own endpointing — pure extra latency. AssemblyAI's `min_turn_silence` and `max_turn_silence` already control timing.

**No language pinned:** U3 Pro auto-detects and code-switches between English, Spanish, German, French, Portuguese, and Italian. Omitting `language` lets it detect automatically — important since callers may speak Spanish.

**VAD thresholds aligned at 0.3:** U3 Pro defaults its internal VAD to 0.3. Silero must match to avoid a dead zone where AssemblyAI is transcribing but LiveKit hasn't detected speech yet, delaying barge-in. Silero is still recommended with STT turn detection for faster local interruption handling — LiveKit uses whichever speech-start signal arrives first.

**Noise cancellation removed from agent pipeline:** AssemblyAI recommends no audio pre-processing — NC artifacts hurt transcription more than background noise. SIP trunk-level noise/echo cancellation (Telnyx) is fine and separate from this.

**Conservative keyterms enabled at startup:** The agent passes a short `keytermsPrompt` list for hard-to-hear practice terms, providers, and insurance names such as Aetna Better Health, Humana Medicaid, Dr. Licht, and Crystal River. This targets observed STT misses without loading the full insurance list.

**Dynamic profiles for high-risk turns:** When an assistant message asks for insurance, member ID, DOB/intake details, or email, the session calls `stt.updateOptions(...)` before the next caller turn. This updates the active direct AssemblyAI STT stream, bumps silence for entity dictation, and swaps to the most relevant keyterms. After the caller's final transcript, the session resets to the default profile.

## Parameters

```
min_turn_silence: 275   — silence (ms) before speculative EOT check (punctuation-based)
max_turn_silence: 1000  — max silence (ms) before forced turn end on normal turns
vad_threshold: 0.3      — AssemblyAI internal VAD, must match Silero
```

## Tuning notes

- Increase `min_turn_silence` if brief pauses cause early EOT on terminal punctuation
- Increase `max_turn_silence` if forced turn end cuts off users mid-thought or splits entities (phone numbers, DOBs) across turns
- Runtime profile changes are based on the assistant's last prompt in `src/main.ts`; examples include insurance plan lookup, insurance member ID, intake/DOB/address, and email collection.
- `keytermsPrompt` is configured in `src/stt-config.ts`. Keep the default list short: AssemblyAI limits streaming keyterms to 100 terms and ignores individual terms longer than 50 characters.
- `src/stt-config.ts` defines the `default`, `insurance`, `memberId`, `intake`, and `email` profiles. Keep profile terms specific; broad/common terms can over-bias transcription.
