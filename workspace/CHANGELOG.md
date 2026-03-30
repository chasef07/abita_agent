# Prompt Changelog

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
