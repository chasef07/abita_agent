# Prompt Changelog

## 2026-04-07 — Clean up transfer logic and make transfer message conversational

**Removed conflicting transfer guidance**
- "Go straight to transferring" and "work through it first" were both in Path 4 — LLM could get mixed signals on borderline requests. Reorganized into three clear buckets: transfer immediately (out-of-scope), try to help first (in-scope concerns), caller asks for a human (one chance to qualify).

**Conversational transfer message**
- Old: "We will transfer you to the office now, but we may be dealing with patients. If so, please leave us a voicemail and we will get back to you as soon as we can."
- New: "Let me transfer you over to the office. They might be with a patient, so if no one picks up just leave a voicemail and they'll get back to you."

**Single source of truth for transfer behavior**
- Stripped behavioral instructions out of the transfer_call tool description — it now just says what the tool does and points to the RUNBOOK. All transfer rules live in Path 4 only.
- Top-of-runbook pushback rule now references Path 4 instead of restating the full policy.

## 2026-04-06 — Comprehensive prompt audit and restructure

Reviewed 7 real call transcripts and identified recurring issues: verbosity, agent restating what the caller said, ignoring the transfer message, reading back all registration fields, duplicate tool calls, location confusion, missing appointment reason, and corporate tone on unhappy paths. Then conducted a full research audit across OpenAI, Anthropic, Google, and voice AI platforms (LiveKit, Vapi, Retell, ElevenLabs) to benchmark against state-of-the-art prompting practices. Restructured the entire prompt based on findings.

### Research-driven structural changes

**Flipped negative instructions to positive framing**
- Why: Research on the "pink elephant effect" shows LLMs follow "do Y" instructions significantly better than "don't do X." The prompt had 25+ negative instructions. The most-violated rules ("don't parrot," "don't ask anything else," "don't pad") were all negatives.
- What changed: Rewrote all high-frequency behavioral rules as positive instructions. "Don't parrot back what the caller said" → "Act on what the caller said — move forward." "Don't pad with extra sentences" → "Say what needs to be said in 1-3 sentences." Kept negatives only for hard safety boundaries (don't fabricate data, don't call transfer twice) where research says they're appropriate.

**Added "Remember" section at end of RUNBOOK**
- Why: Stanford/UC Berkeley research on the "lost in the middle" effect shows rules at the beginning and end of prompts get the most attention. Google's Dec 2025 paper showed repeating 2-3 critical rules improved compliance 47 out of 70 times. The three most-violated rules (sentence limit, parroting, transfer message) were buried in the middle.
- What changed: Added a "Remember" section at the very end of RUNBOOK.md with the three most critical rules, exploiting recency bias.

**Added example conversation exchanges**
- Why: Every research source — OpenAI, Anthropic, LiveKit, Vapi, ElevenLabs — identifies few-shot examples as the single most reliable way to control tone and response length. The prompt had phrase-level examples but no full conversation exchanges.
- What changed: Added two example conversations in RUNBOOK.md: one existing patient confirmation (short, clean) and one new patient registration (full flow showing David's tone, readback format, and reason-for-visit question).

**Added "Ask one question at a time"**
- Why: Universal voice AI guidance across all platforms. Prevents the agent from stacking multiple questions in one turn.
- What changed: Added to VOICE.md core rules and reinforced in the Remember section.

**Added exit criteria to all four paths**
- Why: OpenAI's Realtime guide recommends explicit phases with exit criteria so the model knows when a path is complete. Without exit criteria, the agent defaulted to filler like "is there anything else?"
- What changed: Each path now has an explicit "Exit:" line telling the agent when to stop and let the caller lead.

### Deduplication

**Consolidated overlapping rules across files**
- Why: The same rules appeared in 3-4 places with slightly different wording (e.g., "don't echo" appeared 8 times across VOICE.md, RUNBOOK.md, and tools.ts). Research shows this dilutes the signal — the model treats each as a soft suggestion rather than a hard rule.
- What changed: Each rule now lives in exactly one place. SOUL.md owns identity and tone. VOICE.md owns output format. RUNBOOK.md owns call flow. Tool descriptions own tool-specific logic and reference the runbook where appropriate. Cut ~30% of redundant content.

**Trimmed VOICE.md from 62 lines to 36**
- Removed three separate "don't echo" rules, duplicate acknowledgment examples, duplicate time formatting, and the confirmation section (RUNBOOK owns that).

**Trimmed tool descriptions**
- add_patient: removed duplicate field collection instructions (RUNBOOK owns the order) and duplicate "never fabricate" paragraph.
- verify_patient: removed duplicate "don't echo the name" rule.
- get_availability: removed duplicate "never call for the same date twice" (general rule covers it).

### Transcript-driven fixes

**RUNBOOK.md — Readback trimmed to four fields only**
- Why: In call cmnn5o8ea, agent read back all registration fields (name, DOB, phone, email, address, sex, insurance, member ID). Caller said "No" and asked for a human. Too much information.
- What changed: Readback now limited to name (spell last name), DOB, insurance plan, and member ID. Consistent across RUNBOOK line 8, line 60, and add_patient tool description.

**SOUL.md — Added unhappy path tone examples**
- Why: Agent sounded like David on happy paths but switched to corporate voice when things went wrong ("Unfortunately, we are not in network with that insurance carrier"). Transcripts showed this on insurance rejections, transfers, and no-availability scenarios.
- What changed: Added four David-voice vs corporate-voice contrast examples for: insurance rejected, can't help, no availability, patient not found.

**KNOWLEDGE_EYERADIANCE.md — Dr. Licht practices at both locations**
- Why: In call cmnnbhd8i, agent told a caller "Dr. Licht sees patients at the Spring Hill location" then found him available at Crystal River two turns later. The knowledge base listed Dr. Licht only under Spring Hill providers.
- What changed: Updated to "Dr. Licht practices at both locations."

**tools.ts — confirm_appt now includes location in readback**
- Why: Same call — agent confirmed the appointment without mentioning the location, then had to explain it was at a different office than the caller expected.
- What changed: Description now says "Read back the nearest appointment: date, time, doctor, and location."

**tools.ts — transfer_call uses exact required message**
- Why: In calls cmnnj3oz6 and cmnnm6lyy, agent said "One moment while I transfer you" instead of the required voicemail message. The tool description had a different example message than the RUNBOOK required.
- What changed: Tool description now contains the exact transfer message text, matching RUNBOOK.

**VOICE.md — Don't repeat yourself after tool calls**
- Why: In calls cmnnj3oz6 and cmnn64ax4, agent said "I completely understand your frustration" before the tool call, then repeated the same phrase after the tool returned. The filler rule caused duplication.
- What changed: Added "When the tool returns, pick up where you left off — your pre-tool-call message already covered the acknowledgment."

**RUNBOOK.md — Ask reason for visit before scheduling**
- Why: In call cmnnm6lyy, caller said "I need an eyelash removal" but agent never asked the reason for the visit when scheduling. The get_availability tool description said "you decide, not the caller" for appointment type, which discouraged asking.
- What changed: Added "ask reason for visit" step to both Path 1 (Schedule) and Path 2 flows. Updated get_availability description to clarify: agent determines new/existing and adult/pediatric from context, but asks the caller for the visit reason to pick the right code.

**RUNBOOK.md — Push back once during scheduling**
- Why: In call cmnnm6lyy, caller asked to talk to a real person while the agent was in the middle of booking an appointment. Agent gave up immediately. Scheduling is the agent's core competency.
- What changed: If the caller asks for a human during scheduling, push back once — "I'm very capable of booking appointments, let's keep going." Transfer on the second ask.

**RUNBOOK.md — Never call same tool with same input twice**
- Why: In call cmnnajaqt, lookup_knowledge was called twice with identical input. Agent already had the answer.
- What changed: Added general rule: "Use tool results you already have. Never call the same tool with the same input twice."

**prompt.ts — Ask "have you been seen here before?" for unknown callers**
- Why: In call cmnnhidc1, phone lookup returned NO MATCH but the agent still collected name/DOB, tried verify_patient twice, failed, then awkwardly pivoted to registration. If it had asked upfront, the flow would have been smoother.
- What changed: NO MATCH context now instructs the agent to ask "have you been seen here before?" If no, skip verify_patient and go straight to registration.

**tools.ts — No same-day wording improved**
- Why: In call cmnnm6lyy, agent said "I can't do same-day appointments" as if it were office policy. The real issue was the system constraint, not a practice rule.
- What changed: Reworded to "just let them know the earliest you can schedule is tomorrow and offer that."

## 2026-04-03 — Knowledge base updates, insurance restructure, audio fix

### Changes

**INSURANCE.md — Restructured for better agent matching**
- Why: Agent told a caller we don't accept "Simply Health" when Simply Medicaid is accepted under iCare. The grouped-by-carrier structure made it hard for the agent to match shorthand names.
- What changed: Added common aliases section at top for shorthand matching. Flattened plan list to alphabetical. Removed internal AMD codes. Added safer fallback: ask to clarify before rejecting. Added "Simply Health" alias → Simply Medicaid.

**KNOWLEDGE_SPRINGHILL.md — Added NPI numbers and cross-location reference**
- Added NPI numbers for Dr. Bach, Dr. Noel, and Dr. Licht.
- Added reference to Crystal River (Eye Radiance) location with address and hours.

**KNOWLEDGE_EYERADIANCE.md — Added fax, NPI, and cross-location reference**
- Added Crystal River fax: (352)-228-4315.
- Added Dr. Licht NPI number.
- Added reference to Spring Hill location with address, hours, and providers.

**call-logger.ts — Fix audio not included in webhook payload**
- Why: onClose handler was calling flush() before the shutdown callback in main.ts could attach sessionReport and audioBase64. The webhook was posting without audio data.
- What changed: Removed early flush() from onClose. Audio and session report now attach before flush() is called in the shutdown callback.

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
