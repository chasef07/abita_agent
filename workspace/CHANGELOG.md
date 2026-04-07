# Prompt Changelog

## 2026-04-06 — Autonomous optimization run (20 transcripts)

Evaluated 20 recent transcripts from the call database. Found 2 fixable issues + 1 ablation simplification.

### Changes

**RUNBOOK.md — Add ophthalmology scope guard to Path 3**
- Why: In SCL_nhNHBoWVHfk5, agent told caller "we do comprehensive eye exams" and offered to schedule for glasses. The practice does NOT do routine eye exams — it's ophthalmology, not optometry. The knowledge base has this info, but the agent answered without consulting it.
- What changed: Added explicit scope rule directly in Path 3 (Quick Question): "We do NOT do routine eye exams, glasses prescriptions, or contact lens fittings. If someone asks, tell them they'd want an optometrist."
- Why in RUNBOOK and not just knowledge base: The agent needs to know this without calling lookup_knowledge. Putting it in the prompt ensures it's always visible.

**RUNBOOK.md — Skip re-asking insurance if already confirmed**
- Why: In SCL_5JV5Z2yeATcX, caller opened with "do you accept Sunshine Health?" — agent confirmed acceptance. Then during registration (turn 8), agent asked "What insurance does she have?" again. Wasted a turn.
- What changed: Added note to registration step 1: "If you already confirmed their insurance via check_insurance earlier in this call, skip this step."

**RUNBOOK.md — Ablation: Consolidate duplicate transfer-on-insistence rule**
- Why: The transfer-on-insistence rule was stated in full twice — once in "How You Work" (line 11) and again in Path 4 (line 77), with nearly identical wording. The duplication adds prompt length without benefit.
- What changed: Replaced the full duplicate in Path 4 with a short reference: "Second insistence = transfer immediately (see 'How You Work' rule above)." Saves ~180 characters.

## 2026-04-02 — Autonomous optimization run (20 transcripts)

Evaluated 20 recent transcripts from the call database. Found 3 critical behavioral issues.

### Changes

**RUNBOOK.md — Block fabricated registration data**
- Why: In SCL_VFDwKT4Gj8Lp, agent called add_patient with fabricated data — fake email (example.com), fake address (123 Main St), fake member ID (ABC123456). Agent skipped the entire collection phase and hallucinated values to fill required parameters.
- What changed: Added explicit rule under Path 2 — every field must be collected from the caller before calling add_patient. No guessing, no placeholders.

**RUNBOOK.md — Strengthen transfer-on-insistence**
- Why: In SCL_NLZya5NUF5TG, caller said "Live representative" and "Agent" twice but agent continued registration instead of transferring. Existing rule said "insist after one ask" but agent pushed through twice.
- What changed: Made the trigger words explicit ("representative", "agent", "human", "real person") and clarified that a second request = immediate transfer, no exceptions. "One attempt to help is the maximum."

**tools.ts — transfer_call: stop double-calling**
- Why: 46 out of 195 calls have transfer_call called 2+ times. 3 calls had it called 4 times. The SIP session disconnects after the first call, so subsequent calls are wasted.
- What changed: Added explicit language that after transfer_call executes, the SIP session disconnects — no further tool calls, no further text. Stronger than previous "do not retry" wording.
- Note: A code-level guard in the execute function (checking state.transferred before executing) would be more reliable. Prompt-level fix may not fully resolve this.

**tools.ts — add_patient: anti-hallucination guard**
- Why: Same fabricated data issue as RUNBOOK change above. The tool description didn't explicitly say "don't make up data."
- What changed: Added "NEVER call this tool with fabricated, guessed, or placeholder data" at the top of the description.

## 2026-04-01 — Multi-call transcript review

Reviewed 6 high-turn/long-duration calls. Found recurring issues with name spelling loops, availability search loops, echoing partial data mid-stream, and agent interrupting callers.

### Changes

**main.ts — Turn handling tuned**
- Endpointing minDelay 500→1000ms, maxDelay 2000→3000ms to stop jumping in during natural pauses.
- Interruption minWords 0→2 so backchanneling ("uh-huh", "ok") doesn't cut the agent off.
- minDuration back to 500ms (default) since minWords now handles filtering.
- Added LLM FallbackAdapter with GLM-5 as backup for GLM-4.7.

**VOICE.md — Stop echoing data mid-stream**
- Why: Agent was repeating digits, letters, and partial names back as callers gave them, causing confusion and frustrating loops (one caller said "shut up, let me finish").
- What changed: One clear rule — don't echo anything mid-stream during data collection. All read-backs happen once at the end of registration.

**RUNBOOK.md — Fix availability search loops**
- Why: Agent asked "what time were you thinking?" 6 times for a date with zero availability, calling get_availability for the same date 5 times.
- What changed: If no slots returned, tell the caller and offer the nearest available date. Never re-ask for a time on a day with no openings. Never query the same date twice.

**RUNBOOK.md — Don't assume scheduling intent**
- Why: Caller asked "do you see kids?" and agent immediately started collecting info to schedule before confirming that's what they wanted.
- What changed: Removed "lean toward scheduling" bias. Let the caller state their reason.

**RUNBOOK.md — Trust the STT for names**
- Why: Agent got the spelling right on first pass but still entered a letter-by-letter echo loop that lasted 10+ turns.
- What changed: Collect names without echoing or spelling back. Only spell back at end of registration. If verify_patient fails, then ask them to spell it.

**tools.ts — verify_patient description updated**
- Removed instruction to spell back last name before calling. Now: call with what you heard, API is source of truth.
- HMO/PPO question moved under routingAmbiguous only — don't ask every verified patient about their plan type.

**tools.ts — get_availability description updated**
- Added: if no slots returned, tell caller and offer nearest date. Don't loop on the same date.
- Default to follow-up appointment type for existing patients. Only use post-op if caller mentions recent surgery — don't ask "follow-up or post-op?"

**tools.ts — add_patient description updated**
- "subscriber name" → "whose name is on the insurance card?" (callers didn't understand the term)
- Added 10-digit phone validation — ask again if not 10 digits.
- Clarified: don't read back individual fields during collection. One read-back at the end with name, DOB, insurance, and member ID.

**VOICE.md — removed conflicting goodbye rule**
- "ask if there's anything else" conflicted with RUNBOOK's "don't ask is there anything else." Removed.

**VOICE.md — fill silence during multi-search**
- Added: give brief updates between back-to-back availability searches so caller knows you're still here.

## 2026-03-30 — Post-call review (Donald Brubaker, Eye Radiance)

First real patient call. Reviewed full transcript against prompt and identified gaps.

### Changes

**SOUL.md — AI honesty rule strengthened**
- Why: Caller asked "you're a real person, right?" and the agent said yes. Previous wording only triggered on direct "are you AI?" questions.
- What changed: Honesty rule now explicitly covers "are you real?", "are you a machine?", and similar variants. Agent must not claim to be human.
- Goal: Maintain caller trust. If they find out later, it damages the practice's credibility.

**RUNBOOK.md — Transfer announcement required**
- Why: At the end of the call, the agent transferred without warning after the caller mentioned wanting The Villages location.
- What changed: Added rule that every transfer must be announced before it happens — tell the caller they're being transferred and why.
- Goal: Callers should never be silently handed off mid-conversation.

**RUNBOOK.md — Work through concerns before transferring**
- Why: Same call — caller said they wanted a different location and the agent immediately transferred instead of explaining what locations are available.
- What changed: Added rule to try resolving concerns (wrong location, scheduling conflicts, insurance issues) before jumping to a transfer. Use available tools, explain options, let the caller decide.
- Goal: Reduce unnecessary transfers. The agent can handle most of these situations.

**tools.ts (add_patient) — Insurance must match accepted list**
- Why: Agent registered the patient with "Medicare PPO" which isn't a real plan name. Had to circle back after registration to clarify it was Aetna Medicare PPO.
- What changed: Insurance value passed to add_patient must be an exact plan name from the accepted list via check_insurance. Vague names like "Medicare PPO" are not allowed.
- Goal: Get insurance right the first time. Avoid confusing back-and-forth after registration.

**tools.ts (add_patient) — Removed email from read-back**
- Why: Email read-back caused a three-round correction loop on this call (Ruby vs BRUBY, gmail vs hotmail). Reading back emails adds friction without much value.
- What changed: Email removed from the pre-submit read-back list.
- Goal: Shorter registration, fewer correction loops.

**VOICE.md — No email read-back**
- Why: Same as above. TTS mispronunciation of email usernames causes confusion.
- What changed: Email addresses are no longer read back. Agent moves on to the next field after the caller provides it.
- Goal: Cleaner registration flow.
