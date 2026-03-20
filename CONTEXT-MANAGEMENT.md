# Context Management Strategy

Research-backed guide for maintaining LLM quality across multi-turn voice calls. All recommendations are grounded in published research and tailored to our LiveKit agent architecture.

---

## The Problem

Our agent "gets dumb" on longer calls. This is not a bug — it's a well-documented phenomenon across all LLMs. Three separate research efforts explain why:

### 1. Multi-turn degradation (Microsoft Research, ICLR 2026)

**Paper:** "LLMs Get Lost In Multi-Turn Conversation" — Liu et al., 2025 ([arXiv:2505.06120](https://arxiv.org/abs/2505.06120))

**Finding:** All major LLMs (open and closed-weight) show an **average 39% performance drop** in multi-turn conversations vs. equivalent single-turn tasks, tested across 200,000+ simulated conversations.

**Why it happens:**
- LLMs make early assumptions to fill in missing information
- They prematurely attempt solutions before having all the facts
- Once the model takes a wrong turn, **it rarely recovers** — errors compound
- Accuracy in early turns (first 20%): **30.9%**. In final turns (last 20%): **64.4%**

**Key mitigation:** CONCAT — consolidating all accumulated information into a **fresh single prompt** instead of continuing the multi-turn thread recovers **~95% of single-turn performance**. The information isn't lost; the conversation format itself causes the degradation.

**Relevance to our agent:** Our scheduling flow collects patient name, DOB, insurance, and appointment preferences across many turns. The model may lock onto a misheard value on turn 2 and carry that error through turn 15. `session.userdata` is our equivalent of CONCAT — it pulls confirmed facts out of the conversation into typed state.

### 2. Lost in the Middle (Stanford/Meta, TACL 2024)

**Paper:** "Lost in the Middle: How Language Models Use Long Contexts" — Liu et al., 2024 ([arXiv:2307.03172](https://arxiv.org/abs/2307.03172))

**Finding:** LLMs exhibit a **U-shaped attention curve** — they attend strongly to information at the **beginning** and **end** of context, with a **30%+ accuracy drop** for information in the middle.

**Root cause:** Rotary Position Embedding (RoPE) introduces long-term decay that de-emphasizes middle tokens.

**Relevance to our agent:**
- System prompt (SOUL.md, VOICE.md) is at the **top** — good, gets attention
- Latest user message is at the **bottom** — good, gets attention
- Old tool results and conversation turns pile up in the **middle** — bad, gets ignored
- This means our scheduling instructions and behavioral rules fade as the conversation grows

### 3. Context Rot (Chroma Research, 2025)

**Paper:** "Context Rot" — Chroma Research ([research.trychroma.com/context-rot](https://research.trychroma.com/context-rot))

**Finding:** LLM performance degrades as input length increases, **even on trivially simple tasks** designed to isolate length as the only variable. Tested across 18 models.

**Key findings:**
- **Structured, coherent content** (like a real conversation) performs *worse* than random shuffled content — attention mechanisms get confused by patterns
- Topically-related distractors (old tool results about the same patient) are **especially harmful**
- Performance degrades **non-uniformly and unpredictably** — not a gradual decline
- Models increasingly refuse tasks or generate nonsense as context grows

### 4. Context Length Alone Hurts Reasoning (2025)

**Paper:** "Same Task, More Tokens: the Impact of Input Length on the Reasoning Performance of Large Language Models" ([arXiv:2510.05381](https://arxiv.org/html/2510.05381v1))

**Finding:** Even when models can **perfectly retrieve** all relevant information, longer context still degrades reasoning by **13.9%–85%**.

- This is NOT a retrieval problem — the model finds the info but reasons worse about it
- **Whitespace padding alone** (not even real content) causes degradation
- Their fix: **"Retrieve Then Solve"** — extract relevant info into a short context, then reason over that. Improved results by up to **31%**.

### 5. JSON Tool Responses Hurt Performance (2025)

**Paper:** "How Good Are LLMs at Processing Tool Outputs?" ([arXiv:2510.15955](https://arxiv.org/abs/2510.15955))

**Finding:** JSON processing remains difficult even for frontier models. Tested across 15 models.

- **Simplifying JSON** (keeping only relevant fields) improved accuracy by **8–38 percentage points**
- Average response size after simplification: **12x smaller** (60,968 → 5,056 chars)
- GPT-4o accuracy drop from 10K to 80K token responses: **-7%**
- Mistral accuracy drop: **-91%**
- Requiring JSON output reduced accuracy by **27.3 percentage points** on reasoning tasks (Tam et al., 2024)

**Relevance to our agent:** Our tools return raw JSON from the AMD API. Every tool response sits in context for the rest of the call. If `get_availability` returns a big array of slots with full metadata, the model must parse that on every subsequent turn — and the research shows it does this increasingly poorly.

---

## Action Plan

### Phase 1: Tool Response Trimming (High Impact, Easy)

**What:** Transform tool responses before they enter the conversation context. Return concise natural language summaries instead of raw JSON.

**Where:** Each tool's `execute` function in `src/tools.ts`

**Pattern:**
```typescript
// Before (raw API response hits context):
execute: async ({ lastName, firstName, dob }) => {
  return callApi("/api/verify-patient", { lastName, firstName, dob });
}

// After (trimmed response + userdata storage):
execute: async ({ lastName, firstName, dob }, { ctx }) => {
  const result = await callApi("/api/verify-patient", { lastName, firstName, dob });

  // Store full data in typed state (survives compaction)
  if (result.status === "verified") {
    ctx.userdata.patientId = result.patientId;
    ctx.userdata.patientName = result.name;
    ctx.userdata.routing = result.routing;
    ctx.userdata.verified = true;
  }

  // Return minimal text to context
  return `Patient verified: ${result.name} (ID: ${result.patientId}). Routing: ${result.routing}.`;
}
```

**Apply to all tools:**
- `verify_patient` → Store patientId, name, routing. Return one-line summary.
- `add_patient` → Store patientId, name. Return confirmation.
- `get_availability` → Store raw slots in userdata for `book_appt`. Return only the top 3-5 slots as readable text.
- `confirm_appt` → Store appointment list. Return readable list.
- `cancel_appt` → Return confirmation.
- `book_appt` → Return confirmation with date/time/provider.

**Research basis:** JSON simplification yields +8-38% accuracy improvement (arXiv:2510.15955). Tool responses are "topically-related distractors" that compound degradation (Chroma).

### Phase 2: Session Userdata (High Impact, Medium Effort)

**What:** Implement typed `CallState` on `session.userdata` so tools read/write confirmed values from state instead of relying on the LLM's memory of old context.

**Where:** `src/agent.ts`, `src/main.ts`, `src/tools.ts`

**Pattern:**
```typescript
interface CallState {
  patientId?: string;
  patientName?: string;
  routing?: string;
  verified: boolean;
  isNewPatient: boolean;
  appointmentType?: number;
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

// In main.ts:
const session = new voice.AgentSession<CallState>({
  userdata: { verified: false, isNewPatient: false },
  // ...
});
```

**Research basis:** This is the "Retrieve Then Solve" pattern from arXiv:2510.05381 — extracting confirmed facts out of long context into a clean, short representation. Also the CONCAT pattern from Microsoft Research — tools act on authoritative state, not degraded multi-turn memory.

### Phase 3: State Injection via onUserTurnCompleted (High Impact, Medium Effort)

**What:** Before each LLM call, inject a brief system message that restates the current call state and key behavioral rules. This exploits the U-shaped attention curve — the model pays most attention to the beginning and end of context.

**Where:** Override `onUserTurnCompleted` in `src/agent.ts`

**LiveKit hook:** `onUserTurnCompleted(turnCtx, newMessage)` is called when the user finishes speaking, before the LLM generates a reply. It receives the full `ChatContext` and the new user message. We can inject a state summary into `turnCtx`.

```typescript
async onUserTurnCompleted(
  turnCtx: llm.ChatContext,
  newMessage: llm.ChatMessage,
): Promise<void> {
  const state = this.session.userdata as CallState;

  const parts: string[] = [];
  if (state.verified) {
    parts.push(`Patient: ${state.patientName} (ID: ${state.patientId})`);
  }
  if (state.routing) {
    parts.push(`Routing: ${state.routing}`);
  }
  if (state.selectedSlot) {
    parts.push(`Selected slot: ${state.selectedSlot.provider} on ${state.selectedSlot.datetime}`);
  }

  if (parts.length > 0) {
    turnCtx.addMessage({
      role: "assistant",
      content: `[Current state: ${parts.join(". ")}. Remember: one question at a time, confirm before booking.]`,
    });
  }
}
```

**Research basis:** End-of-context reminders exploit the U-shaped attention curve (arXiv:2307.03172). Periodic reinforcement prevents instruction drift (Anthropic best practices). Fresh state summary acts as a mini-CONCAT (Microsoft Research).

### Phase 4: Earlier Compaction (Medium Impact, Easy)

**What:** Lower the compaction threshold from 140k to 50-60k tokens.

**Where:** `src/main.ts` — change `COMPACT_THRESHOLD`

**Why:** The Context Rot and arXiv:2510.05381 papers show degradation starts well before the context window limit. A 30-40k context is already degraded. Compacting earlier keeps the "middle" section of context smaller, reducing the lost-in-the-middle effect.

**Tradeoff:** More frequent summarization LLM calls. But each call is cheap compared to the quality improvement. With userdata storing critical values, the summary only needs to preserve conversational tone and recent context — not exact data values.

```typescript
const COMPACT_THRESHOLD = 50_000; // Was 140_000
```

**Research basis:** Context length alone degrades reasoning by 13.9-85% (arXiv:2510.05381). Structured content causes worse degradation than random content (Chroma).

### Phase 5: Custom LLM Node for Context Hygiene (Medium Impact, Higher Effort)

**What:** Override `llmNode()` in the Agent class to inspect and clean the chat context before each LLM call. This replaces the old `before_llm_cb` pattern.

**Where:** `src/agent.ts`

**Potential uses:**
- Strip old tool results beyond the last N turns (observation masking — JetBrains Research, 2025)
- Truncate the context if it exceeds a soft limit: `turnCtx.truncate(maxItems)`
- Log context size for analytics

```typescript
async llmNode(
  chatCtx: llm.ChatContext,
  tools: llm.Tool[],
  modelSettings: voice.ModelSettings,
): Promise<AsyncIterable<llm.ChatChunk | string>> {
  // Optional: truncate old items
  // chatCtx.truncate(30);

  // Use default LLM processing
  return voice.Agent.default.llmNode(this, chatCtx, tools, modelSettings);
}
```

**Research basis:** Observation masking (hiding old tool outputs from context while keeping their results) matched LLM summarization in both cost savings and problem-solving ability (JetBrains Research, 2025).

---

## Implementation Priority

| Phase | Change | Impact | Effort | Dependencies |
|-------|--------|--------|--------|-------------|
| 1 | Trim tool responses | High | Easy | None |
| 2 | Session userdata | High | Medium | None (pairs with Phase 1) |
| 3 | State injection via onUserTurnCompleted | High | Medium | Phase 2 (needs userdata to inject) |
| 4 | Earlier compaction threshold | Medium | Easy | None |
| 5 | Custom llmNode for context hygiene | Medium | Higher | Phases 1-3 should come first |

Phases 1 and 2 should be implemented together — trimming tool responses and storing values in userdata are two sides of the same change. Phase 3 builds on Phase 2 (it needs userdata to know what state to inject). Phase 4 is a one-line change that can happen anytime. Phase 5 is optional polish.

---

## References

1. Liu et al. "LLMs Get Lost In Multi-Turn Conversation." ICLR 2026. [arXiv:2505.06120](https://arxiv.org/abs/2505.06120)
2. Liu et al. "Lost in the Middle: How Language Models Use Long Contexts." TACL 2024. [arXiv:2307.03172](https://arxiv.org/abs/2307.03172)
3. Chroma Research. "Context Rot." 2025. [research.trychroma.com/context-rot](https://research.trychroma.com/context-rot)
4. Levy et al. "Same Task, More Tokens: the Impact of Input Length on the Reasoning Performance of Large Language Models." 2025. [arXiv:2510.05381](https://arxiv.org/html/2510.05381v1)
5. "How Good Are LLMs at Processing Tool Outputs?" 2025. [arXiv:2510.15955](https://arxiv.org/abs/2510.15955)
6. Tam et al. "Let Me Speak Freely? A Study on the Impact of Format Restrictions on Performance of Large Language Models." 2024.
7. LiveKit Docs. "Pipeline nodes and hooks." [docs.livekit.io/agents/logic/nodes](https://docs.livekit.io/agents/logic/nodes/)
8. LiveKit Docs. "Agents and handoffs." [docs.livekit.io/agents/logic/agents-handoffs](https://docs.livekit.io/agents/logic/agents-handoffs/)
