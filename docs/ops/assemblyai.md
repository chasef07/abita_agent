# AssemblyAI Universal-3.5 Pro STT — Design Decisions

Switched STT from Deepgram Nova-3 to AssemblyAI Universal-3 Pro Streaming on 2026-04-06, then to AssemblyAI Universal-3.5 Pro Streaming on 2026-06-20. The active runtime now reaches AssemblyAI through LiveKit Inference using the existing LiveKit Cloud credentials.

## Key decisions

**LiveKit Inference transport:** Using `new inference.STT(getAssemblyAIInferenceSttOptions())` from `@livekit/agents`. The model remains `assemblyai/universal-3-5-pro`; provider options are passed in snake case through `modelOptions`.

**LiveKit audio turn detection:** The session uses `inference.TurnDetector()` as the primary turn-boundary owner. AssemblyAI's silence settings still control transcription timing and entity-dictation quality, but its end-of-speech events do not commit turns in this mode.

**Context-aware endpointing:** Normal conversation uses fixed `300-600ms` endpointing. Insurance, member ID, intake, and email prompts temporarily use fixed `500-2500ms` endpointing. The normal profile returns only after LiveKit commits the caller's message, not when AssemblyAI first emits a final transcript.

**No language pinned:** Universal-3.5 Pro auto-detects and code-switches between English, Spanish, German, French, Portuguese, and Italian. Omitting `language` lets it detect automatically — important since callers may speak Spanish.

**Aligned LiveKit VAD:** The session tunes LiveKit's auto-provisioned local-inference Silero model to `activationThreshold=0.3` and `deactivationThreshold=0.15`, matching AssemblyAI Universal-3.5 Pro's internal VAD threshold for consistent barge-in behavior while preserving LiveKit's default VAD lifecycle. The `250ms` minimum silence duration remains unchanged for the audio turn detector.

**No agent-side noise cancellation:** The agent does not configure LiveKit background voice cancellation or AssemblyAI Voice Focus before STT. SIP trunk-level noise/echo cancellation (Telnyx) is separate from this.

**Conservative keyterms enabled at startup:** The agent passes a short `keytermsPrompt` list for hard-to-hear practice terms, locations, provider names, and only a couple of distinctive always-on payer terms. This targets observed STT misses without loading the full insurance list.

**Dynamic profiles for high-risk turns:** When an assistant message asks for insurance, member ID, DOB/intake details, or email, the session calls `stt.updateOptions({ modelOptions })` before the next caller turn. LiveKit sends the update through the active Inference stream as `session.update`, so the AssemblyAI stream is updated without reconnecting. This bumps silence for entity dictation and swaps to the most relevant keyterms. Member ID, intake, and email profiles intentionally send an empty keyterm list so those turns get extra silence without carrying stale payer bias. After the caller's final transcript, the session resets to the default profile.

## Parameters

```
min_turn_silence: 275   — silence (ms) before speculative EOT check (punctuation-based)
max_turn_silence: 2000  — max silence (ms) before forced turn end on normal turns
vad_threshold: 0.3      — AssemblyAI internal VAD threshold
```

## Tuning notes

- Increase `min_turn_silence` if brief pauses cause early EOT on terminal punctuation
- Increase `max_turn_silence` if forced turn end cuts off users mid-thought or splits entities (phone numbers, DOBs) across turns
- Tune LiveKit turn-commit timing in `src/session-options.ts`.
- Runtime profile changes are owned by `src/runtime/turn-profile-controller.ts`,
  attached during session startup in `src/main.ts`; examples include insurance
  plan lookup, insurance member ID, intake/DOB/address, and email collection.
- `keytermsPrompt` is configured in `src/stt-config.ts`. Keep the default list short: AssemblyAI limits streaming keyterms to 100 terms and ignores individual terms longer than 50 characters.
- `src/stt-config.ts` defines the `default`, `insurance`, `memberId`, `intake`, and `email` profiles. Keep profile terms specific; broad/common terms can over-bias transcription.
