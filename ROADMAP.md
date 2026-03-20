# LiveKit Agent — Roadmap & Plans

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

## Structured call state (userdata)

Critical data from tool results is stored in a typed `CallState` object on the session, not just in chat history. This ensures values survive compaction, can't be hallucinated, and flow reliably between tools.

### State shape

```typescript
interface CallState {
  // From verify_patient / add_patient
  patientId?: string;
  patientName?: string;
  routing?: string;
  allowedProviders?: string[];
  verified: boolean;
  isNewPatient: boolean;
  preauthRequired: boolean;

  // From conversation flow
  appointmentType?: number;
  patientDob?: string;

  // From get_availability (selected slot)
  selectedSlot?: {
    columnId: number;
    profileId: number;
    datetime: string;
    duration: number;
    provider: string;
  };

  // From confirm_appt (for cancel/reschedule)
  appointments?: Array<{
    id: number;
    date: string;
    time: string;
    provider: string;
  }>;
}
```

### How tools use it

**Writing** — tools store results in state after a successful call:
```typescript
// verify_patient execute:
const result = await callApi("/api/verify-patient", { lastName, firstName, dob });
if (result.status === "verified") {
  ctx.userdata.patientId = result.patientId;
  ctx.userdata.patientName = result.name;
  ctx.userdata.routing = result.routing;
  ctx.userdata.verified = true;
}
return result;
```

**Reading** — tools pull values from state instead of relying on LLM to pass them:
```typescript
// book_appt execute:
const patientId = ctx.userdata.patientId;  // guaranteed correct
const slot = ctx.userdata.selectedSlot;     // from get_availability
```

### Precedence rules

When conflicting information exists:
1. **Latest user input** — caller corrects something ("actually it's spelled F-A-G-E-N")
2. **Structured state** — tool results stored in userdata
3. **Chat history** — LLM's memory of past messages

### What this solves

- **Lost patient IDs** — compaction strips old tool results, but userdata persists
- **LLM passing wrong values** — ASR misheard "Chase" as "Cheers", but userdata has the verified name from AMD
- **Routing flow** — routing rule flows from verify → get_availability via state, not LLM memory
- **Multi-step workflows** — reschedule needs IDs from verify, confirm_appt, get_availability, and book_appt. State carries them all reliably.

### Injection into prompt

Optionally inject key state into the system prompt so the LLM knows what's been established:
```
Current call state:
- Patient: Chase Fagen (verified)
- Routing: all_three
- Appointment type: not yet determined
```

This gives the LLM awareness of where we are in the flow without depending on it to parse old tool results.

---

## Compaction integration

The call logger owns the compaction logic (moves out of main.ts):
- Monitors promptTokens from LLM metrics
- Triggers `_summarize()` when threshold exceeded
- Logs compaction events with timestamp and before/after token counts
- Includes compaction events in the call summary

---

# Roadmap

## 1. Book appointment via middleware
**Status:** Done (2026-03-19)
**Blocker for:** Full scheduling flow

Added `/api/appointment/book` endpoint to the AMD middleware on Railway. The middleware now handles color mapping, facilityid/episodeid constants, type array wrapping, column validation, and 409 conflict handling. Updated `book_appt` in `tools.ts` to use `callApi("/api/appointment/book", params)` — same pattern as all other tools. Removed direct AMD REST API calls and the `AMD_REST_BASE`/`AMD_REST_TOKEN` env vars from the agent.

## 2. Post-call analysis
**Status:** Not started
**Depends on:** Call logger (above)

Build the call logger, then create an analytics endpoint to receive the post-call JSON. Options:
- Simple: POST to a Railway service that stores in a database
- Dashboard: Build a UI to view call history, filter by date, see per-turn metrics
- Alerts: Flag calls with high TTFT, tool errors, or compaction events

Key metrics to surface:
- Call volume and duration distribution
- Average TTFT and TTS TTFB over time
- Tool success/failure rates
- Cache hit rate trends
- Context growth patterns
- ASR transcript quality (for review)

## 3. Language detection + multilingual support
**Status:** Not started

Implement `language_detection` tool that switches the conversation language. Currently support English, Spanish, Arabic, Vietnamese per the TOOLS.md spec.

Steps:
- Detect caller's language from first utterance (Scribe STT supports language detection)
- Switch TTS voice/language settings dynamically
- Switch system prompt language or add translation layer
- Test each language end-to-end on a real call

## 4. Transfer tool implementation
**Status:** Not started
**Depends on:** SIP REFER support on LiveKit

Implement `transfer_to_number` tool for warm/cold transfers to the office.

### Option A: SIP REFER (simple cold transfer)
- Enable SIP REFER on the Twilio trunk
- Build the tool: accepts a phone number, initiates the transfer
- Handle the handoff gracefully — agent says "let me connect you" then transfers

### Option B: Agent handoff pattern (recommended)
LiveKit's agent handoff system (`llm.handoff()`) provides a cleaner approach. Instead of a raw SIP transfer, hand off to a "transfer agent" that manages the outbound dial via LiveKit's SIP participant API.

```typescript
// In the scheduling agent's tools:
transferToOffice: llm.tool({
  description: "Transfer the caller to a human at the office",
  execute: async (_, { ctx }) => {
    return llm.handoff({
      agent: new HumanTransferAgent({ chatCtx: ctx.agent.chatCtx }),
      returns: "Connecting you with someone at the office now",
    });
  },
}),
```

Benefits over raw SIP REFER:
- Agent can summarize the call for the human before connecting
- Conversation history is preserved via `chatCtx` passthrough
- `AgentHandoff` items are tracked in chat context for analytics
- Can implement warm transfer (agent briefs the human) vs cold transfer

Reference: https://docs.livekit.io/agents/logic/agents-handoffs/

### Steps
- Test with actual office number
- Decide warm vs cold transfer behavior
- Add transfer events to CallLogger for analytics

## 5. Test compaction
**Status:** Not started
**Depends on:** Call logger with compaction integration

Verify compaction works end-to-end:
- Simulate a very long call (or lower the threshold temporarily to e.g. 15k tokens)
- Confirm `_summarize()` fires, context shrinks, and conversation continues normally
- Verify system prompt and recent turns are preserved
- Verify userdata survives compaction
- Check that the LLM can still reference summarized information accurately
- Log before/after token counts

## 6. Structured call state (userdata)
**Status:** Planned (see spec above)
**Depends on:** None

Implement the `CallState` interface and wire tools to read/write from it. Biggest reliability improvement for multi-step workflows like reschedule.

### LiveKit's official pattern: `session.userdata`

LiveKit provides typed userdata on the session object — no custom implementation needed. Define a typed state, pass it when creating the session, and access it from any tool via `context.userdata`.

```typescript
// Define typed state
interface CallState {
  patientId?: string;
  patientName?: string;
  routing?: string;
  verified: boolean;
  isNewPatient: boolean;
  selectedSlot?: {
    columnId: number;
    profileId: number;
    datetime: string;
    duration: number;
    provider: string;
  };
  appointments?: Array<{
    id: number;
    date: string;
    time: string;
    provider: string;
  }>;
}

// Pass to session
const session = new voice.AgentSession<CallState>({
  userdata: { verified: false, isNewPatient: false },
  // ... other params
});

// Access in tools via context
const verify_patient = llm.tool({
  execute: async ({ lastName, firstName, dob }, { ctx }) => {
    const result = await callApi("/api/verify-patient", { lastName, firstName, dob });
    if (result.status === "verified") {
      ctx.userdata.patientId = result.patientId;
      ctx.userdata.patientName = result.name;
      ctx.userdata.routing = result.routing;
      ctx.userdata.verified = true;
    }
    return result;
  },
});
```

### Why this matters
- **Survives compaction** — userdata persists even when chat history is summarized
- **Survives handoffs** — userdata carries across agent transitions (multi-office, transfer)
- **Can't be hallucinated** — tool reads from typed state, not LLM memory
- **No custom code** — LiveKit provides the mechanism natively

Reference: https://docs.livekit.io/agents/logic/agents-handoffs/ (Session Userdata section)

## 7. Adaptive interruption handling
**Status:** Blocked — waiting on `@livekit/agents-plugin-elevenlabs` STT support for Node.js
**Depends on:** ElevenLabs STT plugin with aligned transcript support

LiveKit 1.2.0 added adaptive interruption detection (ML-based barge-in instead of fixed VAD thresholds). It requires the STT to support `alignedTranscript: "word"`. Our custom `ScribeSTT` adapter doesn't provide word-level timestamps reliably — the `COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS` event from Scribe caused session crashes.

When the official `@livekit/agents-plugin-elevenlabs` Node.js package adds STT support (Python already has it), swap out the custom `ScribeSTT` for the official plugin and enable adaptive interruption:

```typescript
turnHandling: {
  interruption: { mode: "adaptive" },
}
```

The `turnHandling` config is already in place — just needs the STT swap.

## 8. Multi-office routing (per-trunk knowledge base)
**Status:** Not started
**Depends on:** None

Route calls to office-specific prompts based on the dialed trunk phone number. Different offices have different providers, locations, hours, and insurance details — the agent needs the right knowledge base loaded before the conversation starts.

### How it works

The trunk phone number is already captured in `main.ts` via `participant.attributes["sip.trunkPhoneNumber"]`. Pass it to `buildPrompt()` to select the correct knowledge file.

### Changes

**`prompt.ts`** — Map trunk numbers to office identifiers, load office-specific knowledge:
```typescript
const OFFICE_MAP: Record<string, string> = {
  "+17271234567": "spring-hill",
  "+19041234567": "hollywood",
};

export function buildPrompt(trunkPhone: string): string {
  const office = OFFICE_MAP[trunkPhone] ?? "spring-hill";
  const files = ["SOUL.md", "TOOLS.md", "VOICE.md", `KNOWLEDGE-${office.toUpperCase()}.md`];
  // ... rest of build
}
```

**`agent.ts`** — Accept trunk phone in constructor:
```typescript
constructor(trunkPhone: string) {
  super({ instructions: buildPrompt(trunkPhone), tools: { ... } });
}
```

**`main.ts`** — Pass trunk phone to agent:
```typescript
const agent = new Agent(trunkPhone);
```

**`workspace/`** — Create per-office knowledge files:
- `KNOWLEDGE-SPRING-HILL.md` — Spring Hill providers, hours, location, insurance
- `KNOWLEDGE-HOLLYWOOD.md` — Hollywood providers, hours, location, insurance

### Also per-office
- Greeting: "thank you for calling Abita Eye *Spring Hill*" vs "*Hollywood*"
- Office hours and provider schedules
- Location-specific insurance acceptance
- AMD middleware office routing (already handled via `setOffice()`)

## 9. Voice realism improvements
**Status:** Not started
**Depends on:** None

Apply LiveKit's prompting guide for natural-sounding speech. Update VOICE.md with:

- **Filler word patterns with structure:** `"yeah, um... so, I can do that"` not just "use fillers"
- **Before/after examples:** Show the model both sides so it knows what to avoid
- **Sentence starters:** Begin with "so," "yeah so," "ok so" instead of declarative "I will"
- **Recovery patterns:** `"sorry, I missed that — what was the name again?"` not `"I apologize, could you repeat that?"`
- **Redundancy:** Repeat style rules across SOUL.md and VOICE.md — models need more repetition than expected

Reference: https://livekit.com/blog/prompting-voice-agents-to-sound-more-realistic

## Priority order
1. Book appointment via middleware — unblocks full scheduling ✅
2. Post-call analysis — observability ✅
3. Structured call state — reliability for all tool flows
4. Multi-office routing — needed for multi-location launch
5. Transfer tool — needed for production
6. Voice realism improvements — polish
7. Language detection — needed for production
8. Test compaction — validation
