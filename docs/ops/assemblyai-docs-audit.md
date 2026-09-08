# AssemblyAI developer documentation audit

Historical audit of the direct-plugin trial. The current runtime uses the direct plugin with fixed endpointing; see [current configuration](assemblyai.md) for the selected transport
and fixed endpointing settings. Context ownership and exact-entity validation
principles below remain applicable.

Reviewed 2026-09-08 against PR #435, `src/stt-config.ts`,
`src/runtime/turn-profile-controller.ts`, and installed
`@livekit/agents-plugin-assemblyai` 1.8.0 source. This is a configuration and
contract review, followed by a focused context-lifecycle correction. The earlier
[audio evaluation](assemblyai-plugin-evaluation.md) remains a parameter study;
this audit does not establish new optimal timing values.

## Supported settings and remaining timing tradeoffs

The plugin correctly serializes the configured model, language reporting,
silence windows, VAD threshold, keyterms, and assistant context to AssemblyAI's
snake-case wire fields. Its 16 kHz mono PCM defaults and the application's
30-second inactivity timeout are supported. Inactivity means lack of incoming
audio, not merely a caller pausing while silent audio continues arriving.
[WebSocket API](https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket)

`minTurnSilence: 100` / `maxTurnSilence: 100` remains provider endpointing:
the maximum forces transcript segmentation even when the content is incomplete.
LiveKit separately owns conversational commitment. Matching entity windows at
1500 ms similarly force segmentation after that pause; they cannot preserve
arbitrarily long pauses. AssemblyAI recommends increasing the minimum for
entity capture, illustrates 1000 ms, and allows increasing the maximum for
longer pauses. The documentation supports this mechanism, not the claim that
our measured 1500 ms choice is universally optimal. Preserve the regressions in
[the evaluation](assemblyai-plugin-evaluation.md).
[Turn detection](https://www.assemblyai.com/docs/streaming/turn-detection)

Universal-3.5 Pro does not use the older Universal Streaming
`end_of_turn_confidence_threshold` or `format_turns` controls. Leaving both unset
is correct. The provider VAD setting of 0.3 is legal but more selective than its
documented 0.2 default; matching Silero's numeric threshold does not calibrate
two different models.
[WebSocket API](https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket)

## Assistant context and conversation history

`agent_context` should contain the agent's spoken reply, especially the question
the caller answers. It improves recognition of short responses and spelled
emails/IDs. Send the opening greeting at connection time when available, then
update for subsequent replies during TTS. The review found that TTS-input observation published generated text before
playout completed, including questions subsequently discarded by interruption.
The controller now publishes context from assistant `ConversationItemAdded`
messages and caps it at 1500 characters. TTS input can arm a recognition profile;
only committed output updates the remembered profile used for follow-ups.
[Conversation context](https://www.assemblyai.com/docs/streaming/universal-3-5-pro/context-carryover)

The application's 1500-character suffix cap is safely below the documented
1750-character per-value limit. Increasing it is unnecessary. The provider
also bounds accumulated history to 1750 characters and drops older entries.
Only finalized user turns and supplied assistant values enter that history;
interims do not. Closing the WebSocket clears server history.
[Conversation context](https://www.assemblyai.com/docs/streaming/universal-3-5-pro/context-carryover)

`previous_context_n_turns` is intentionally unset: the documented default is
five conversation entries, its range is 0–100, and zero disables automatic
carryover. AssemblyAI recommends leaving it unset. Entries include finalized
STT chunks, so five entries need not mean five LiveKit conversational turns.
[WebSocket API](https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket)

Updates are deltas. The controller's profile reset omits `agentContext`, which
does not clear the prior value. A new supplied value replaces the configured
value. The docs do not establish an application-visible single-use consumption
event or promise that sending an empty string erases accumulated history; do
not invent either contract.
[Configuration updates](https://www.assemblyai.com/docs/streaming/updating-configuration-mid-stream),
[WebSocket API](https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket)

SDK-committed output is the best available conversation record, not a guarantee
of word-exact audible speech: interrupted generation uses synchronized text
when available and otherwise may fall back to generated text; `session.say`
commits its forwarded text. This follows the installed Agents 1.8.0
`voice/generation.ts` (`forwardedTextFor`) and `voice/agent_activity.ts`
(reply interruption and say commit paths). No SDK internals were patched.

The installed plugin also offers opt-in `agentContextCarryover: true`, feeding
assistant `ConversationItemAdded` events through `_pushConversationItem`.
Default remains false. It is an alternative owner, not an additional source to
enable alongside the controller. Its source performs no 1750-character trim.

## Vocabulary, entity recognition, and identity

Current vocabulary lists satisfy the documented limits: at most 100 terms,
each at most 50 characters. A new `keytermsPrompt` list replaces the previous
list; an empty list clears vocabulary bias. Thus the empty intake/member/email
lists deliberately remove office and payer hints. The plugin also merges any
session-level keyterms, so future session hints must respect the combined limit.
[Prompting and keyterms](https://www.assemblyai.com/docs/streaming/prompting-and-keyterms)

No contextual `prompt` is currently configured, consistent with AssemblyAI's
recommendation to establish a no-prompt baseline. If tested later, describe the
known call scenario rather than commanding formatting or entity corrections.
Keep explicit vocabulary in keyterms; only add terms justified by recognition
errors, because unnecessary common terms can overcorrect.
[Prompting and keyterms](https://www.assemblyai.com/docs/streaming/prompting-and-keyterms)

Recognition and written formatting of an entity do not verify its identity.
Neither hints nor context establish a patient match, valid member ID, payer
equivalence, or active coverage. Those remain runtime/middleware decisions;
do not insert guessed patient identifiers into STT hints. Entity evaluation
should compare canonical values as well as WER, which penalizes harmless spoken
versus written number formatting. This boundary follows the repository's
`AGENTS.md` and `VISION.md`.

The separate `entity_detection` feature classifies entities in the `/v2/transcript`
API. It is not an extra matching switch for this Universal-3.5 streaming plugin.
[Entity detection](https://www.assemblyai.com/docs/speech-understanding/entity-detection)

## Plugin gaps versus the current API

`languageDetection: true` requests language/confidence metadata; it does not
restrict recognition to English and Spanish. The provider's `language_codes`
can steer expected languages, but plugin 1.8.0 exposes no such option. Omitting
it leaves native multilingual recognition. A cast adding an unknown option
would not serialize it.
[Multilingual transcription](https://www.assemblyai.com/docs/streaming/multilingual-transcription)

The installed plugin also lacks `interruption_delay` and `continuous_partials`
options. It accepts `mode` at connection time but its live `updateOptions`
serializer omits `mode`, unlike the provider API. Explicitly resetting the
current silence fields works; copying the docs' live mode-reset example would
not. These are integration limitations, not reasons to retune without replay
evidence.
[Configuration updates](https://www.assemblyai.com/docs/streaming/updating-configuration-mid-stream)

## Correction verification

Both unspoken-question publication and interrupted follow-up inheritance failed
before their fixes and passed afterward. The full suite passed 48 files / 1019
tests, typecheck, lint, and formatting. A focused live stream then exercised the
new committed-context method across insurance, intake, and ordinary profiles:
all three exact synthetic answers survived, with no stream errors and 17 ms
maximum feed drift. This verifies the context/configuration path; it does not
prove word-perfect playback alignment or new latency improvements. Standards
and Spec reviews accepted the ownership correction with no remaining finding.
