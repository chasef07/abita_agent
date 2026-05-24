# Prompt Improvements

Analysis of the current system prompt (SOUL.md + TOOLS.md + VOICE.md + KNOWLEDGE.md) with recommendations based on context management research findings.

---

## Current Prompt Size

| File | Est. Tokens |
|------|-------------|
| SOUL.md | ~1,200 |
| TOOLS.md | ~6,000 |
| VOICE.md | ~400 |
| KNOWLEDGE.md | ~1,500 |
| **Total** | **~9,000-10,000** |

~6,300 words / ~38K characters across all four files. This is sent at the top of every LLM call for the entire duration of the call.

---

## Assessment

**The prompt is not too long.** 8-10K tokens for a complex scheduling agent is reasonable. The problem isn't the system prompt size — it's what accumulates after it (tool results, conversation turns). Per the context management research:

- System prompt sits at the **top** of context (strong attention — good)
- Recent user message sits at the **bottom** (strong attention — good)
- Tool results and old turns pile up in the **middle** (weak attention — bad)

However, every token in the system prompt is carried on every single LLM call, so unnecessary tokens compound across a 20-turn call.

---

## What's Working Well

- **"One question at a time"** — Perfectly aligned with Microsoft Research finding that LLMs make early assumptions. Collecting info incrementally with confirmation reduces lock-in on wrong values.
- **"Confirm before you commit"** — Prevents the "rarely recovers from wrong turns" failure mode.
- **Clear flow structure** — The model knows what order to do things (verify → availability → book).
- **Spell-back pattern** — Forces verification at the point of highest error (names over phone).
- **No same-day appointments / Dr. Bach limited schedule** — Concrete guardrails that prevent known failure cases.

---

## What to Improve

### 1. Insurance List is Too Large (~2,000 tokens)

**Problem:** The accepted insurance list in TOOLS.md under `add_patient` is ~100 lines and ~2,000 tokens. It's carried on every LLM call for the entire conversation, but it's only needed during the `add_patient` flow — specifically when collecting the insurance field.

**Recommendation:** Move the insurance list to a tool lookup. Create an `insurance_lookup` tool or inject the list into context only when the flow reaches insurance collection (via `onUserTurnCompleted`). This saves ~2,000 tokens on every non-registration call — which is the majority of calls.

**Alternative:** If keeping it in the prompt, move it to the very end of TOOLS.md. Per the "Lost in the Middle" research (arXiv:2307.03172), the model attends better to the beginning and end of context. Currently the insurance list sits in the middle of TOOLS.md where attention is weakest.

### 2. Tool Response Descriptions Are Redundant with Userdata

**Problem:** Each tool section has a detailed "What comes back" block describing every field in the response (patientId, routing, allowedProviders, routingAmbiguous, etc.). This is ~800 tokens total. With `session.userdata` (Phase 2 of context management plan), the tools would store these values in typed state — the model doesn't need to understand or remember the response structure.

**Current:**
```
**What comes back:**
- `patient_id` — from `patientId` in response. You need this for every tool call after.
- `patient_verified` — from `status`. Either they're in the system or they're not.
- `routing` — the insurance routing rule: `all_three`, `bach_only`, `bach_licht`, or `not_accepted`.
- `allowedProviders` — display names of doctors this patient can see.
- `routingAmbiguous` — if `true`, the carrier ID is shared across plans...
```

**After userdata implementation:**
```
**What comes back:**
The tool stores patient ID, routing, and provider info automatically. You'll see a
confirmation like "Patient verified: Chase Fagen. Routing: all_three." Use the
confirmed name going forward. If routing is `not_accepted`, tell the patient their
insurance isn't accepted and offer self-pay or a transfer.
```

**Savings:** ~800 tokens. Requires Phase 2 (session.userdata) to be implemented first.

### 3. Spell-Back Instructions Are Duplicated

**Problem:** The instruction to spell back names and confirm appears in three places:
- SOUL.md: "spell back the name and confirm the date of birth before calling any tool"
- TOOLS.md verify_patient: Full 4-step spelling flow
- TOOLS.md add_patient: "Can you spell your first name for me?" flow

**Recommendation:** Define the spell-back protocol once in SOUL.md as a core behavior, then reference it briefly in the tool sections: "Follow the spell-back protocol for first and last name." Remove the full step-by-step from add_patient since it's identical to verify_patient.

**Savings:** ~300 tokens.

### 4. Negative Examples Burn Tokens

**Problem:** Several sections use verbose negative examples that add tokens without proportional value:

```
**Don't:** Give the caller a menu of doctors. Dump a list of times. Compare two
doctors' availability. Call the tool twice with the same date.
```

```
Not this: long explanations, hollow affirmations, or anything that sounds like a
call center script.
```

**Recommendation:** Compress to single-line rules:

```
Never list multiple options — suggest one best-fit slot and adjust if rejected.
```

```
No call-center language. No hollow affirmations.
```

**Savings:** ~400 tokens.

### 5. VOICE.md Could Be Stronger (Per LiveKit Blog)

**Problem:** VOICE.md is currently ~400 tokens with good principles but lacks the concrete patterns that LiveKit's own research says models need. The article "Prompting Voice Agents to Sound More Realistic" (livekit.com/blog) says "the model will fight you unless you're very explicit."

**Missing patterns:**
- Filler word structures: `"yeah, um... so, I can do that"` — not just "use fillers"
- Before/after pairs: Show the model what NOT to say alongside what TO say
- Sentence starters: `"so," "yeah so," "ok so"` instead of declarative `"I will," "Let me"`
- Recovery patterns: `"sorry, I missed that — what was the name again?"` not `"I apologize, could you repeat that?"`

**Recommendation:** Add 200-300 tokens of concrete speech patterns. Net prompt growth is small (~200 tokens after trimming elsewhere) but voice quality improves significantly.

**Also:** Repeat a one-line voice style rule in SOUL.md for reinforcement. The LiveKit article and Anthropic best practices both recommend redundancy for behavioral rules across sections: "You speak casually — fillers, false starts, connectors. Never sound scripted."

### 6. KNOWLEDGE.md Has Low-Priority Info

**Problem:** Some sections in KNOWLEDGE.md are rarely needed and could be trimmed:

- "Glasses Warranty or Broken Glasses" (~50 tokens) — edge case
- "Payment Information" (~30 tokens) — very generic
- "Scope Limitation" (~30 tokens) — already covered in SOUL.md boundaries

**Savings:** ~110 tokens. Minor, but every token counts per the context rot research.

---

## Summary

| Change | Tokens Saved | Effort | Dependency |
|--------|-------------|--------|------------|
| Move insurance list to tool/injection | ~2,000 | Medium | None (or Phase 3 onUserTurnCompleted) |
| Trim "What comes back" sections | ~800 | Easy | Phase 2 (session.userdata) |
| Deduplicate spell-back instructions | ~300 | Easy | None |
| Compress negative examples | ~400 | Easy | None |
| Trim low-priority KNOWLEDGE.md | ~110 | Easy | None |
| **Total savings** | **~3,600** | | |
| Add VOICE.md speech patterns | +200 | Easy | None |
| **Net savings** | **~3,400** | | |

A ~3,400 token reduction on the system prompt saves ~3,400 tokens on **every LLM call for every turn of every call**. On a 15-turn call, that's ~51,000 fewer tokens processed total.

---

## Priority

1. **Move insurance list out of prompt** — Biggest single win, most calls don't need it
2. **Compress negative examples + deduplicate spell-back** — Quick edits, no dependencies
3. **Strengthen VOICE.md** — Small token cost, noticeable quality improvement
4. **Trim tool response descriptions** — After userdata is implemented
5. **Trim KNOWLEDGE.md** — Minor but easy

---

## State-of-the-Art Prompting Comparison

Comparison of our prompt against best practices from Anthropic (Claude), Google (Gemini), and general prompting research.

### What We're Doing Right

| Best Practice | Source | Our Prompt |
|--------------|--------|------------|
| Give the model a clear role with specific expertise | Anthropic, Google | SOUL.md defines David as a scheduling specialist with clear boundaries |
| Be clear and direct — treat model as a new employee | Anthropic | SOUL.md "Core Truths" are specific and actionable |
| Provide sequential steps with numbered lists | Anthropic | Tool sections have numbered conversation flows |
| Use few-shot examples for tone/format | Anthropic, Google | VOICE.md has "Prefer this" examples; tool sections have sample phrases |
| Explain WHY behind instructions (motivation) | Anthropic | "This is a doctor's appointment, not a pizza order" — great |
| Specify constraints and boundaries | Anthropic, Google | "Stay in your lane" section clearly defines scope |
| Handle edge cases explicitly | Google | Parent calling for child, two last names, insurance ambiguity all covered |

### What We're Missing or Could Improve

#### 1. No XML Tags for Structure (High Impact)

**Best practice (Anthropic):** "XML tags help Claude parse complex prompts unambiguously, especially when your prompt mixes instructions, context, examples, and variable inputs."

**Our prompt:** Uses markdown headers (##, ###) throughout. Markdown is fine for humans but XML tags are more parseable for LLMs. The model has to infer section boundaries from formatting rather than explicit delimiters.

**Recommendation:** Wrap major sections in XML tags. This doesn't mean rewriting everything — just adding structure around existing content:

```xml
<role>
You are David, the front desk scheduling assistant at Abita Eye Care...
</role>

<rules>
- One question at a time
- Confirm before you commit
- Spell back names letter by letter
</rules>

<tools>
<tool name="verify_patient">
...
</tool>
</tools>

<knowledge>
...
</knowledge>
```

The model can then unambiguously distinguish role from rules from tool definitions from knowledge. This is especially valuable as context grows and the system prompt needs to compete with conversation history for attention.

#### 2. Instructions Are Mixed with Context (Medium Impact)

**Best practice (Anthropic):** "Put longform data at the top. Place your long documents and inputs near the top of your prompt, above your query, instructions, and examples."

**Best practice (Google):** "Supply context first, then place specific instructions at the end."

**Our prompt:** SOUL.md (behavioral rules) comes first, then TOOLS.md (instructions + data mixed), then VOICE.md (behavioral rules), then KNOWLEDGE.md (reference data). The instruction ordering is:

```
1. SOUL.md    — Rules (behavioral)
2. TOOLS.md   — Rules + Data (instructions mixed with insurance lists, field specs)
3. VOICE.md   — Rules (behavioral)
4. KNOWLEDGE.md — Data (reference)
```

**Recommendation:** Reorder to separate data from instructions. Put reference data first (it's the "longform data"), then behavioral rules and tool instructions after. Per the U-shaped attention finding, putting critical behavioral rules LAST (closer to the conversation) may actually improve adherence:

```
1. KNOWLEDGE.md  — Reference data (top of context, stable)
2. TOOLS.md      — Tool definitions and flows
3. SOUL.md       — Core behavioral rules
4. VOICE.md      — Speech style rules (closest to conversation, highest attention)
```

This puts the most important behavioral constraints (SOUL + VOICE) at the end of the system prompt, right before the conversation starts — exploiting recency bias.

#### 3. No Explicit Examples of Full Interactions (Medium Impact)

**Best practice (Anthropic):** "Include 3-5 examples for best results. Wrap examples in `<example>` tags."

**Best practice (Google):** "Prompts without few-shot examples are likely to be less effective. Include 2-4 varied examples."

**Our prompt:** Has inline phrase examples ("let me check what's available") but no full interaction examples showing a complete turn — what the caller says, what the agent does, what tool to call, how to respond.

**Recommendation:** Add 1-2 short `<example>` blocks showing an ideal mini-interaction:

```xml
<example>
Caller: "hi I need to make an appointment"
You: "sure, I can help with that. can you spell your first name for me?"
Caller: "C-H-A-S-E"
You: "ok so that's C-H-A-S-E?"
Caller: "yes"
You: "and your last name? can you spell that too?"
</example>
```

This grounds the model in the exact rhythm and tone you want, which is more effective than describing it abstractly.

#### 4. Tell What to Do, Not What Not to Do (Medium Impact)

**Best practice (Anthropic):** "Tell Claude what to do instead of what not to do."

**Our prompt:** Has significant negative instruction:
- "Never say this to the caller"
- "Don't guess — hand it off"
- "Don't: Give the caller a menu of doctors"
- "Never dead-end the call"
- "Never send a placeholder"
- "Don't rush through this"

**Recommendation:** Flip negatives to positives where possible:

| Current (negative) | Rewritten (positive) |
|---|---|
| "Never say the patient ID to the caller" | "Keep patient IDs internal — confirm identity naturally" |
| "Don't guess — hand it off" | "When unsure, offer to connect them with someone who can help" |
| "Don't rush through this" | "Collect each field one at a time, confirming as you go" |
| "Never dead-end the call" | "Always offer a next step — different time, different approach, or a transfer" |

Some negatives are fine (they're guardrails for known failure modes), but the ratio should favor positive instructions. The model follows "do X" more reliably than "don't do Y."

#### 5. No Context About Why Voice Matters (Low Impact)

**Best practice (Anthropic):** "Providing context or motivation behind your instructions can help Claude better understand your goals." Example: instead of "NEVER use ellipses", say "Your response will be read aloud by a text-to-speech engine, so never use ellipses since the TTS engine won't know how to pronounce them."

**Our prompt:** VOICE.md says rules like "Only include words meant to be spoken" and "No markdown" but doesn't explain that a TTS engine is reading the output.

**Recommendation:** Add one line to the top of VOICE.md:

```
Your words are spoken aloud by a text-to-speech engine — the caller hears audio,
not text. Everything you output is pronounced verbatim. No markdown, no labels,
no formatting — only natural speech.
```

This gives the model the WHY, which Anthropic's research shows helps it generalize the rule to edge cases.

#### 6. Behavioral Rules Could Be Reinforced at End (Low Impact)

**Best practice (Anthropic):** For long-context prompts, "queries at the end can improve response quality by up to 30%."

**Our prompt:** All behavioral rules are in SOUL.md (at the top) and VOICE.md (third section). By the time conversation turns accumulate, these rules are far from the model's strongest attention zone.

**Recommendation:** Already addressed in `../architecture/context-management.md` Phase 3 (state injection via `onUserTurnCompleted`). The injected state summary should include a brief behavioral reminder alongside the call state.

---

## Overall Grade

| Category | Grade | Notes |
|----------|-------|-------|
| Role definition | A | Clear, specific, grounded identity |
| Behavioral rules | A- | Strong rules, but too many negatives and some redundancy |
| Tool instructions | B+ | Thorough but verbose; data mixed with instructions |
| Examples | B- | Good inline phrases, but no full interaction examples |
| Structure | B- | Markdown headers work but XML tags would be more robust |
| Voice/tone | C+ | Principles are right but lacks concrete speech patterns |
| Token efficiency | C+ | Insurance list and tool response descriptions are bloated |
| Section ordering | C | Behavioral rules should be closer to conversation, not furthest away |

The prompt is well-written and covers edge cases thoroughly — it's clearly been iterated on with real calls. The main gaps are structural (XML tags, section ordering) and efficiency (insurance list, response descriptions). The content quality is high; the packaging could be optimized.

---

## Research References

- "Lost in the Middle" — Model attention is U-shaped; middle content gets 30%+ less attention ([arXiv:2307.03172](https://arxiv.org/abs/2307.03172))
- "Context Rot" — Performance degrades non-uniformly as input length increases, even on simple tasks ([research.trychroma.com/context-rot](https://research.trychroma.com/context-rot))
- "Same Task, More Tokens" — Longer context degrades reasoning by 13.9-85% even with perfect retrieval ([arXiv:2510.05381](https://arxiv.org/html/2510.05381v1))
- "Prompting Voice Agents to Sound More Realistic" — Models need explicit before/after examples and structured filler patterns ([livekit.com/blog](https://livekit.com/blog/prompting-voice-agents-to-sound-more-realistic))
- "LLMs Get Lost In Multi-Turn Conversation" — 39% performance drop in multi-turn; models lock onto early assumptions ([arXiv:2505.06120](https://arxiv.org/abs/2505.06120))
