# Call Logger — Implementation Plan

## Goal
Track per-turn and per-call analytics for every phone call. Post a summary to an analytics endpoint when the call ends. Log to stdout during the call for real-time observability.

## What it tracks per turn
- Caller transcript (from STT)
- Agent response text
- LLM metrics: promptTokens, completionTokens, cachedTokens, TTFT, tok/s
- TTS metrics: TTFB, character count
- Tool calls: name, args, duration, success/error
- Context size (promptTokens = current context window usage)

## What it tracks per call
- Call ID (room name) / caller phone number
- Start/end time, duration in seconds
- Total turns
- Total tokens: input, output, cached
- Cache hit rate: `cachedTokens / (promptTokens + cachedTokens)` across all turns
- Peak context usage (highest promptTokens seen)
- Whether compaction occurred (count + timestamps)
- Tool call summary: total calls, total errors
- Average TTFT (LLM time to first token)
- Average TTS TTFB (time to first byte of audio)

## Architecture

### New file: `src/call-logger.ts`

A `CallLogger` class that:
1. Accepts the session, agent, and caller metadata at construction
2. Subscribes to session events
3. Accumulates per-turn data
4. On session close, computes totals and POSTs the summary

### Events to hook into

| Event | What it gives us |
|-------|-----------------|
| `MetricsCollected` (llm_metrics) | promptTokens, completionTokens, cachedTokens, TTFT, tok/s |
| `MetricsCollected` (tts_metrics) | TTFB, character count |
| `UserInputTranscribed` | Caller's speech text |
| `ConversationItemAdded` | Agent responses, tool calls, tool results |
| `FunctionToolsExecuted` | Tool call completion with timing |
| `Close` | Triggers the summary POST |

### Integration in main.ts

```typescript
import { CallLogger } from "./call-logger.js";

// After session.start():
const logger = new CallLogger({
  session,
  agent,
  callerPhone: participant.identity,  // sip_+17277092035
  roomName: ctx.room.name,
  analyticsUrl: process.env.ANALYTICS_URL,  // optional
});
```

The logger replaces the inline metrics_collected handler we have now. It also handles the compaction trigger internally.

## Output shape

```json
{
  "callId": "room-abc123",
  "callerPhone": "+17277092035",
  "startedAt": "2026-03-18T20:52:00Z",
  "endedAt": "2026-03-18T20:54:30Z",
  "durationSec": 150,
  "totalTurns": 8,
  "totals": {
    "inputTokens": 85000,
    "outputTokens": 450,
    "cachedTokens": 62000,
    "cacheHitRate": 0.73,
    "peakContextTokens": 11200,
    "compactions": 0,
    "toolCalls": 3,
    "toolErrors": 0,
    "avgTTFT": 280,
    "avgTTSttfb": 220
  },
  "turns": [
    {
      "turn": 1,
      "callerText": "I'd like to schedule an appointment",
      "agentText": "sure, can you spell your first name?",
      "promptTokens": 10409,
      "completionTokens": 19,
      "cachedTokens": 0,
      "ttftMs": 894,
      "ttsttfbMs": 147,
      "toolCalls": []
    },
    {
      "turn": 2,
      "callerText": "C-H-A-S-E",
      "agentText": "so that's C-H-A-S-E?",
      "promptTokens": 10440,
      "completionTokens": 19,
      "cachedTokens": 0,
      "ttftMs": 269,
      "ttsttfbMs": 177,
      "toolCalls": []
    },
    {
      "turn": 5,
      "callerText": "April 7th 2000",
      "agentText": "one moment while I pull up your chart... I found you in our system.",
      "promptTokens": 10650,
      "completionTokens": 35,
      "cachedTokens": 0,
      "ttftMs": 280,
      "ttsttfbMs": 200,
      "toolCalls": [
        {
          "name": "verify_patient",
          "args": { "lastName": "Fagen", "firstName": "Chase", "dob": "04/07/2000" },
          "durationMs": 720,
          "isError": false
        }
      ]
    }
  ],
  "compactions": []
}
```

## Stdout logging

During the call, log each turn as it completes:
```
[call] +17277092035 — connected
[llm] 10409 in / 19 out / cached: 0 / TTFT: 894ms / 20 tok/s
[tts] TTFB: 147ms / 77 chars
[llm] 10440 in / 19 out / cached: 0 / TTFT: 269ms / 51 tok/s
[tts] TTFB: 177ms / 64 chars
[tool] verify_patient ✓ 720ms
[call] Ended — 8 turns, 150s
  tokens: 85000 in / 450 out / 62000 cached
  cache hit rate: 73.0%
  peak context: 11200 tokens (5.6% of 200k)
  tools: 3 calls, 0 errors
  avg TTFT: 280ms, avg TTS TTFB: 220ms
```

## Post-call webhook

On session close:
1. Compute all totals
2. Log summary to stdout
3. If `ANALYTICS_URL` is set, POST the full JSON
4. If POST fails, log error but don't crash

## Compaction integration

The call logger owns the compaction logic (moves out of main.ts):
- Monitors promptTokens from LLM metrics
- Triggers `_summarize()` when threshold exceeded
- Logs compaction events with timestamp and before/after token counts
- Includes compaction events in the call summary
