# Prompt Changelog

## 2026-04-04 — Autonomous optimization run (20 transcripts)

Evaluated 20 new transcripts from the call database. Found 2 fixable behavioral issues.

### Changes

**RUNBOOK.md — Add "referral" to Path 4 transfer list**
- Why: In SCL_qgMJRwgEb4Qi, caller said "A referral" and agent tried to schedule a "referral appointment" instead of transferring. Caller had to say "No. No. No." before getting transferred. Similar to SCL_MCFTYbDdZmXh from the previous run where a referral request was mishandled — the previous fix addressed intent-before-identity but didn't add "referral" as a transfer-worthy intent.
- What changed: Added "Referral requests" to Path 4's transfer list and added "referral" to Step 1's Path 4 description.

**tools.ts — Clarify booking retry behavior in book_appt**
- Why: In SCL_B8MWYb2dfrf5, 3 consecutive book_appt calls failed (slots taken by other callers) before the 4th succeeded. Agent kept trying stale slots instead of refreshing availability data.
- What changed: Replaced "retry once, then offer different time or transfer" with guidance to try the next slot, and after two consecutive failures, re-check get_availability for fresh results.

### Skipped Issues

- **Double transfer_call**: Still persists in 6+ calls this batch. Code-level race condition — both tool calls execute concurrently. Not fixable by prompt.
- **STT quality issues**: Several calls had garbled caller input (SCL_GTugHgdBqz3P, SCL_ouFMNPtDjYPM). Not prompt-fixable.
- **"Speak to someone" during frustration (SCL_R8bZsBSdFH9K)**: Caller said "Can I speak to someone?" at turn 42 while frustrated about being interrupted, but continued the call and completed registration. Borderline — not a clear transfer request, and adding "speak to someone" as a trigger risks false positives.

## 2026-04-03 — Autonomous optimization run (16 transcripts)

Evaluated 16 new transcripts from the call database. Found 4 fixable behavioral issues.

### Changes

**RUNBOOK.md — Day-of-week verification before booking**
- Why: In SCL_SuQdqrt9Ys9g, agent told a Spanish-speaking caller that April 22 (a Wednesday) was "jueves" (Thursday). Caller booked on the wrong day-of-week.
- What changed: Added rule under General Rules — when a caller asks for a specific day of the week, verify the date from get_availability actually falls on that day. If not, tell the caller the real day and offer alternatives.

**RUNBOOK.md — Spanish compound phone number guidance**
- Why: In SCL_SuQdqrt9Ys9g, a 48-turn confusion loop occurred while collecting a phone number because the caller used Spanish compound numbers (diez=10, once=11) and the agent couldn't parse them.
- What changed: Added rule explaining Spanish compound number conventions (diez, once, doce, etc.) and how to expand them to individual digits. If parsing fails after two attempts, ask the caller to say digits one at a time.

**RUNBOOK.md — Strengthen intent-before-identity (Step 1)**
- Why: In SCL_kfDQPipRtb6F, caller said "Speak to miss Emma" (specific person by name) and agent asked for the caller's first name instead of transferring. In SCL_MCFTYbDdZmXh, caller said "patient information" and agent collected PII before clarifying intent.
- What changed: Clarified that asking for the caller's name IS identification and must wait until after intent is captured. Added explicit instruction: if the caller's opening mentions a specific person by name, go to Path 4 immediately.

**tools.ts — add_patient: Require explicit subscriber name**
- Why: In SCL_SuQdqrt9Ys9g, agent inferred subscriber name from the email address (Valentino.06Padilla@gmail.com → "Valentino Padilla") instead of asking the caller directly.
- What changed: Added instruction that subscriber name must be asked explicitly — never infer from email or other fields.

### Skipped Issues

- **Double transfer_call**: Persists in 8+ calls despite last run's fix. Root cause is a race condition in the code-level guard (both tool calls execute concurrently, bypassing the state.transferred check). Not fixable by prompt — requires a code change to set the flag synchronously before any async work.
- **verify_patient error handling (SCL_rWjG7tbNtZhV)**: API returned "unknown office" error (phone number passed as office name). Agent treated it as "not found." Root cause is a code/config issue, not a prompt issue.
- **"It" as last name (SCL_9qyFHjJss9MV)**: Agent parsed "It is 05/23/1951" as lastName="It" + DOB. This is an LLM comprehension error — the instructions are clear. Adding more text won't help.

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
