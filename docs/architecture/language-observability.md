# Call Observability Upgrade Spec

## Goal

Add call-level observability that makes it obvious what happened during a
voice call, why the agent made key runtime decisions, and how those decisions
should be evaluated later.

The first concrete additions are:

- accepted language-change telemetry
- first-class tool execution analytics
- first-class session event analytics
- derived LLM fallback/cache summaries
- cleanup of stale repo docs and deprecated build commands

## Current State

The agent already posts usage, LLM metrics, turn metrics, language telemetry,
and a full session report from the shutdown analytics path. The language payload
currently looks like this:

```json
{
  "language": {
    "initialLanguage": "en",
    "currentLanguage": "es",
    "languageSwitches": 1,
    "observedLanguages": ["en", "es"]
  }
}
```

That is enough to know the final language and that Spanish was observed, but it
is not explicit enough for dashboards or evals:

- `observedLanguages` can include a detected language before the runtime accepts
  a real agent language switch.
- `languageSwitches > 0` works as a rough flag but does not explain what changed.
- There is no structured switch history to inspect false positives, timing, or
  evaluation outcomes.

The broader analytics payload also has gaps:

- Tool calls are not emitted as a first-class sanitized analytics array.
- Session events such as errors, close reason, false interruptions, and
  overlapping speech are not persisted as structured call-quality signals.
- LLM fallback/cache behavior is available in raw metrics but not summarized for
  dashboards.
- Repo docs still describe an older LiveKit Inference/Inworld provider path even
  though the runtime uses direct AssemblyAI STT and direct Cartesia TTS.
- The Docker build still uses the deprecated `pnpm download-files` wrapper
  instead of the current `npx livekit-agents download-files` command.

## Acuity Site Consumer Current State

The admin portal in `/Users/chasefagen/acuity_site` already receives the agent
payload through `POST /api/livekit/calls` and stores normalized rows in
`AgentCall`.

Important current paths:

- `app/api/livekit/calls/route.ts` receives the webhook payload.
- `lib/call-ingestion.ts` upserts `AgentCall` rows.
- `lib/call-normalization.ts` derives totals, turns, tool counts, costs,
  review state, and audio storage.
- `prisma/schema.prisma` has first-class columns for core call metrics such as
  `fallbackUsed`, `toolCalls`, `toolErrors`, `interruptionCount`,
  `reviewStatus`, and `reviewResult`.
- `AgentCall.data` preserves the incoming payload without `audioBase64`, so new
  observability fields can land without an immediate schema migration.
- `app/admin/practices/[practiceId]/calls/[callId]/page.tsx` renders the admin
  call detail page with transcript, review, audio, latency, actions, and raw
  JSON.
- `app/components/turn-bubble.tsx` renders raw session-report tool args and
  outputs in collapsible admin transcript details.
- `app/portal/app/calls/[callId]/page.tsx` and `lib/portal-overview.ts` render a
  safer customer-facing transcript that only shows caller/agent messages.

The portal already has the right persistence backbone. The missing work is to
teach normalization, admin analytics, and review/eval inputs about the new
producer fields so they are visible as first-class signals instead of buried in
raw JSON.

## Requirements

### Language Analytics Flags

Extend the call-level `language` payload with explicit dashboard fields:

```ts
type VoiceLanguageTelemetry = {
  initialLanguage: VoiceLanguage;
  currentLanguage: VoiceLanguage;
  languageChanged: boolean;
  languageSwitches: number;
  observedLanguages: VoiceLanguage[];
  acceptedLanguages: VoiceLanguage[];
  switchEvents: VoiceLanguageSwitchEvent[];
};
```

`languageChanged` is the primary dashboard flag. It is true when the runtime
accepted at least one language switch during the call.

`acceptedLanguages` is the ordered list of languages the agent actually used for
conversation output. It starts with the initial language and appends a language
only when the runtime accepts a switch.

`observedLanguages` remains useful for debugging STT behavior, but it must not
be used as the dashboard language-change flag.

### Switch Event Shape

Each accepted switch should append one event:

```ts
type VoiceLanguageSwitchEvent = {
  from: VoiceLanguage;
  to: VoiceLanguage;
  reason: "explicit_request" | "strong_text_evidence" | "stt_detection";
  detectedLanguage?: string;
  languageConfidence?: number;
  atTurn?: number;
  createdAt: string;
};
```

Do not include transcript text in switch events. The existing protected
transcript/audio paths remain the source of truth when a reviewer needs the
utterance that caused a switch.

`atTurn` can be added once the call logger has a stable turn counter. If that
is not available in the first patch, omit it rather than guessing.

### Evals Contract

The language payload should support these future eval questions:

- Did the agent switch languages after an explicit caller request?
- Did the agent avoid switching on weak evidence like numbers, "yes", or short
  ambiguous utterances?
- Did the agent switch back when the caller explicitly requested English?
- Did the agent use the expected TTS language after an accepted switch?
- Did the agent avoid treating raw STT language detection as accepted language
  use?

The first eval dataset can be built from synthetic `VoiceLanguageRuntime` tests
before it needs real call recordings.

### Language Implementation Notes

1. Add `languageChanged`, `acceptedLanguages`, and `switchEvents` to
   `VoiceLanguageTelemetry`.
2. Track accepted languages inside `VoiceLanguageRuntime`.
3. Return a switch reason from the existing language-decision path instead of
   adding a second classifier.
4. Append a `switchEvents` record only after the runtime actually changes
   `currentLanguage`.
5. Keep the analytics payload shape backward-compatible by retaining existing
   `initialLanguage`, `currentLanguage`, `languageSwitches`, and
   `observedLanguages` fields.
6. Add unit tests in `src/__tests__/language-runtime.test.ts` for:
   - no language change on English-only calls
   - explicit Spanish request sets `languageChanged`
   - accepted switch adds `acceptedLanguages` and one `switchEvents` item
   - raw STT detection that fails confidence/weak-evidence checks does not set
     `languageChanged`
   - switching back to English records a second switch event

## Analytics Consumer Expectations

Dashboards should use these fields:

- call changed language: `language.languageChanged`
- final language: `language.currentLanguage`
- languages actually used by the agent: `language.acceptedLanguages`
- STT/debug languages seen: `language.observedLanguages`
- eval/debug timeline: `language.switchEvents`

Do not infer language-change rate from `observedLanguages.length`.

### Tool Execution Analytics

Subscribe to LiveKit's `FunctionToolsExecuted` session event and add a
sanitized top-level `toolExecutions` array to the analytics payload.

```ts
type ToolExecutionAnalytics = {
  callId: string;
  toolName: string;
  createdAt: string;
  status: "success" | "error";
  outputClass?: string;
};
```

The first version should capture:

- tool name
- LiveKit function call id
- event creation time
- success/error status
- optional redacted output class, such as `appointment_booked`,
  `availability_returned`, `transfer_started`, `patient_not_found`,
  `middleware_error`, or `unknown`

Do not blindly send tool args or raw outputs. This agent handles patient,
insurance, phone, and appointment data, so full function args/results can
contain PHI. The protected `sessionReport` can remain the detailed artifact;
`toolExecutions` should be the dashboard-safe index.

This unlocks cleaner reporting for:

- tool failures
- booking, update, cancel, and transfer outcomes
- duplicate tool calls
- middleware/API error rate by tool
- tool usage per call flow

### Session Event Analytics

Subscribe to these LiveKit session events and summarize them in a top-level
`sessionEvents` object:

```ts
type SessionEventAnalytics = {
  close?: {
    reason?: string;
    createdAt: string;
  };
  errors: Array<{
    name?: string;
    code?: string;
    messageClass: string;
    createdAt: string;
  }>;
  falseInterruptions: Array<{
    resumed: boolean;
    createdAt: string;
  }>;
  overlappingSpeech: Array<{
    createdAt: string;
    durationMs?: number;
  }>;
};
```

These events should answer call-quality questions directly:

- Did the agent cut the caller off?
- Did the agent recover after a false interruption?
- Why did the session close?
- Was there overlapping speech?
- Did a runtime/provider error happen during the call?

Keep raw errors out of the public dashboard. Store a stable `messageClass`
instead of full exception text when the message could contain provider payloads
or caller content.

### LLM Fallback And Cache Summary

Keep posting raw `llmMetrics`, but add a derived `llmSummary` so downstream
analytics does not need to reimplement the same interpretation.

```ts
type LlmSummary = {
  modelsUsed: string[];
  fallbackUsed: boolean;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  cacheHitRate: number;
  peakPromptTokens?: number;
  avgTtftMs?: number;
};
```

The summary should be derived from the existing LLM metrics and session usage.
It should use the active model/provider metadata when available. The goal is not
to replace raw metrics; it is to make dashboard cards stable and reduce
consumer-side drift.

### Repo Documentation And Build Cleanup

Update the stale operator-facing docs to match the runtime:

- `README.md` should say the current runtime uses direct AssemblyAI STT and
  direct Cartesia TTS.
- `.env.example` should remove stale Inworld TTS variables and include the
  Cartesia variables the code actually reads.
- `../ops/assemblyai.md` should stop describing LiveKit Inference as the active path
  unless it is clearly marked as historical.
- `Dockerfile` should use `npx livekit-agents download-files` instead of the
  deprecated `pnpm download-files` wrapper.

### Acuity Site Consumer Updates

Update `/Users/chasefagen/acuity_site` in conjunction with the agent payload
changes.

#### Types

Extend `lib/call-types.ts` with the new producer payload fields:

```ts
type LiveKitWebhookPayload = {
  language?: VoiceLanguageTelemetry;
  llmSummary?: LlmSummary;
  sessionEvents?: SessionEventAnalytics;
  toolExecutions?: ToolExecutionAnalytics[];
};
```

These types should describe the inbound payload and the stored JSON shape. They
do not have to become Prisma columns in the first patch.

#### Normalization

Update `lib/call-normalization.ts` so the portal understands the new producer
contract:

- Prefer `llmSummary` for `llmModel`, `fallbackUsed`, token totals, cache hit
  rate, and peak context when it is present; keep the current raw-metric
  derivation as fallback.
- Use `toolExecutions` as the canonical source for aggregate `toolCalls`,
  `toolErrors`, and dashboard-safe tool outcome counts when present.
- Continue deriving detailed per-turn raw tool calls from `sessionReport` for
  the admin transcript, because that is the protected diagnostic view.
- Do not map sanitized `toolExecutions` into raw `TurnRecord.toolCalls` with
  fake args/results. Keep sanitized executions as their own payload field.
- Use `toolExecutions.outputClass` to set action booleans when raw
  `sessionReport` tool outputs are missing. For example, `appointment_booked`
  sets `bookedAppointment`, and `transfer_started` sets `transferred`.
- Preserve `language`, `sessionEvents`, `toolExecutions`, and `llmSummary` in
  `AgentCall.data`.
- Derive data-backed counts for admin display:
  - `languageChanged`
  - `currentLanguage`
  - `acceptedLanguages`
  - `runtimeErrorCount`
  - `falseInterruptionCount`
  - `overlappingSpeechCount`
  - `closeReason`

First implementation can compute those fields from `AgentCall.data` at read
time. Add Prisma columns only if these need indexed filters, trend charts, or
high-volume reporting.

#### Admin Call List

Update `lib/admin-analytics.ts` and `app/components/calls-table.tsx` so the call
list can surface the new observability signals:

- Add a `Language` or `Language Changed` badge/filter when
  `language.languageChanged` is true.
- Add runtime-error visibility when `sessionEvents.errors.length > 0`.
- Add false-interruption and overlapping-speech counts to the admin row model.
- Keep existing filters for bookings, transfers, fallback, errors, and needs
  review.
- Include language and runtime-event fields in admin search text when useful.

The staff/customer portal transcript should stay simpler. Do not show raw tool
args/results, raw errors, or raw JSON outside the admin surface.

#### Admin Call Detail

Update `app/admin/practices/[practiceId]/calls/[callId]/page.tsx`:

- Add a compact "Runtime Signals" section near the snapshot/latency cards.
- Show language-change status, final language, accepted languages, and switch
  count.
- Show false interruptions, overlapping speech, runtime errors, and close
  reason.
- Show `llmSummary.modelsUsed`, `fallbackUsed`, and cache hit rate when
  `llmSummary` exists.
- Show a sanitized "Tool Executions" panel based on `toolExecutions`: tool name,
  status, output class, and timestamp.
- Keep raw session-report function args/outputs behind collapsible admin
  transcript details only.

#### Review And Evals

The review/eval input should prefer the new structured fields:

- Tool correctness should use `toolExecutions` for call-level outcomes and use
  raw `sessionReport` details only as protected evidence.
- Interruption quality should use `sessionEvents.falseInterruptions`,
  `sessionEvents.overlappingSpeech`, and interrupted assistant messages.
- Language-handling evals should use `language.languageChanged`,
  `language.switchEvents`, `language.acceptedLanguages`, and transcript
  messages.
- Fallback/cache evals should use `llmSummary` first, with raw metrics as
  fallback evidence.

If a separate review worker is added back into this repo later, it should write
results to the existing `AgentCall.reviewResult`, `reviewStatus`,
`reviewAverageScore`, and `needsReview` fields.

## Implementation Plan

1. Extend `VoiceLanguageRuntime.telemetry` with the new language fields and
   tests.
2. Add a small analytics accumulator in `src/main.ts` or a dedicated helper so
   session event subscriptions stay readable.
3. Subscribe to `FunctionToolsExecuted` and append sanitized `toolExecutions`.
4. Subscribe to `Error`, `Close`, `AgentFalseInterruption`, and
   `OverlappingSpeech`, then append sanitized `sessionEvents`.
5. Derive `llmSummary` from existing `llmMetrics` and usage before posting the
   shutdown analytics payload.
6. Keep the existing `usage`, `llmMetrics`, `turnMetrics`, `language`, and
   `sessionReport` fields for backward compatibility.
7. Update `acuity_site` types, normalization, admin table/detail surfaces, and
   tests so the new payload fields are visible where transcript review happens.
8. Update stale docs/env/build references after the payload contract is in
   place.
9. Add focused tests for language telemetry, analytics sanitization, summary
   derivation, and portal normalization/display inputs.

## Privacy Boundary

This upgrade should not create a new PHI surface.

- Do not include transcript text, names, dates of birth, phone numbers,
  addresses, insurance IDs, or appointment details in the switch event.
- Do not include raw tool args or raw tool outputs in `toolExecutions`.
- Do not include raw provider error payloads in `sessionEvents.errors`.
- The full call artifact can be inspected through the existing protected
  analytics path when reviewers need utterance-level evidence.

## Acceptance Criteria

### Language

- Existing analytics consumers continue to receive the old language fields.
- New calls include `language.languageChanged`.
- A call that starts and stays in English reports `languageChanged: false`.
- A call that switches from English to Spanish reports `languageChanged: true`
  and includes one switch event.
- A call that switches English to Spanish and back to English reports two switch
  events and `acceptedLanguages: ["en", "es", "en"]`.
- Unit tests cover accepted switches and rejected raw detections.

### Tool Executions

- New calls include `toolExecutions: []` even when no tools run.
- A successful tool execution appends a sanitized `success` record.
- A failed tool execution appends a sanitized `error` record.
- Tool execution records do not include raw args, patient names, dates of birth,
  phone numbers, insurance IDs, addresses, or appointment notes.
- Duplicate tool calls can be counted from repeated tool names/call ids.
- `acuity_site` uses `toolExecutions` for aggregate counts and action badges
  when present.
- `acuity_site` keeps raw tool args/results limited to the admin transcript
  details and raw JSON.

### Session Events

- New calls include `sessionEvents.errors`,
  `sessionEvents.falseInterruptions`, and `sessionEvents.overlappingSpeech`
  arrays.
- `Close` is persisted when LiveKit emits it before shutdown analytics posts.
- `AgentFalseInterruption` records whether the agent resumed.
- `OverlappingSpeech` increments a structured event record.
- Error records are classified without leaking raw provider payloads.
- `acuity_site` surfaces runtime errors, false interruptions, overlapping
  speech, and close reason on the admin call detail page.

### LLM Summary

- New calls include `llmSummary`.
- `fallbackUsed` is true when more than one model/provider appears in LLM
  metrics for the call.
- `cacheHitRate` is computed from cached prompt tokens and total prompt tokens.
- The raw `llmMetrics` field remains available for deeper debugging.
- `acuity_site` prefers `llmSummary` over consumer-side inference when both are
  present.

### Acuity Site

- `lib/call-types.ts` accepts the new payload fields.
- `lib/call-normalization.ts` preserves and derives from `language`,
  `toolExecutions`, `sessionEvents`, and `llmSummary`.
- `lib/__tests__/call-normalization.test.ts` covers a payload containing all new
  fields.
- Admin call list can identify calls with language changes and runtime events.
- Admin call detail shows runtime signals and sanitized tool executions.
- Customer-facing portal transcript remains message-only.

### Docs And Build

- Runtime docs no longer claim the active path is LiveKit Inference/Inworld.
- `.env.example` reflects the actual provider env vars consumed by code.
- Docker build no longer relies on the deprecated `download-files` wrapper.
