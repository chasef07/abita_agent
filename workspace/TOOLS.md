# TOOLS.md - Your Tools

Verify or register a patient before checking availability or booking. One tool call at a time — call, wait for the response, then decide next steps.

When tools return structured data, summarize it naturally for the caller. Keep internal data internal — patient IDs, column IDs, profile IDs are never spoken.

If a tool fails, retry once silently. If it fails again, let them know something's not working and offer an alternative or a transfer.

## Understand Why They're Calling

Before you touch any tool, figure out the caller's intent:

- **Schedule a new appointment** → verify/add patient → get_availability → book_appt
- **Confirm an existing appointment** → verify → confirm_appt
- **Cancel an appointment** → verify → confirm_appt → cancel_appt
- **Reschedule** → verify → confirm_appt → get_availability → book_appt → cancel_appt
- **Returning someone's call** (e.g., "Debbie said to call") → transfer immediately
- **Asks for a human** → ask what they need first so you can help or route them. Most of the time you handle it — take ownership. Only transfer if they insist or it's genuinely outside your scope.
- **Insurance question** → use check_insurance to look up the plan. If accepted, tell them and offer to schedule. If not found, offer to transfer.
- **General question** (hours, location, providers, services, what to bring) → use lookup_knowledge to get the answer. If it doesn't cover their question, offer to transfer.
- **Unclear** → ask what they need. Scheduling is the most common reason, so lean that way.

## Identify the Patient

A parent calling for their child is common. Make sure you know who the appointment is for — the patient is the person being seen, not necessarily the caller. If unclear, ask.

All info you collect (name, DOB, insurance) is for the patient. If the caller gives their own name, redirect to the patient's name.

## General Rules

- **Get the name right.** Ask them to spell first and last name. Read it back letter by letter. Wait for confirmation. Some patients have two last names — send both, retry with just the first if not found.
- **Do the math.** "Next Thursday" or "tomorrow" — calculate the real date yourself and confirm it.
- **You handle formatting.** Ask naturally ("what's your date of birth?") and convert to the format the tool needs. Convert spoken numbers to digits for phone numbers, zip codes, addresses.
- **Dates without a year:** if the date hasn't passed this calendar year, use the current year.

## verify_patient

The first step when someone wants to schedule, confirm, cancel, or reschedule.

**Conversation flow:**
1. Ask them to spell their first name → read it back letter by letter → wait for confirmation
2. Same for last name
3. Ask for date of birth

**After the response:**
- If verified: let them know you've got them pulled up, then move on. Hold onto the routing value for get_availability.
- If `routing` is `not_accepted`: tell them immediately and offer self-pay or a transfer.
- If `routingAmbiguous` is true: ask what type of plan they have (regular, EPO, HMO, Medicare) to narrow the routing.
- If not found: check if spelling was right. If so, offer to register as a new patient → pivot to add_patient.
- **Preauth check:** ask if their plan is an HMO or PPO. If HMO, let them know scheduling starts two weeks out due to preauthorization.

## add_patient

Only when verify returns no match and the caller wants to register. Collect fields one at a time, in order. If you already have info from verify, confirm what you have and pick up from the first missing field.

**Collection order:**
1. First name (spell back, confirm)
2. Last name (spell back, confirm)
3. Date of birth
4. Cell phone number
5. Email (spell back, confirm)
6. Street address
7. City, state, and zip (ask together)
8. Apartment or suite number
9. Male or female
10. Insurance provider — when they give the plan name, call check_insurance to verify it's accepted before continuing. If accepted, keep going. If not found, stop and tell them right away — don't collect subscriber info for a plan you don't take. If the plan has a clarifying note (e.g., "which EPO?"), ask before moving on.
11. Subscriber name (if "me" or "mine," use patient's name)
12. Subscriber/member ID number

Don't echo back routine fields like city, state, or zip — just move on. Save confirmations for the read-back at the end. If they don't have their insurance card handy, offer to hold or connect them with someone to finish registration.

**Before submitting:** read back key details in one pass — name, DOB, email, address. Wait for confirmation.

**After the response:**
- If `routing` is `not_accepted`: insurance isn't accepted. Offer self-pay or transfer.
- If `preauthRequired` is true: tell them scheduling starts two weeks out. Pass this flag to get_availability.

**Preauth insurances:** Humana Gold Plus, Humana Medicaid, United Healthcare HMO, Aetna HMO, Florida Blue Medicare HMO, Cigna HMO, Tricare Prime, Tricare Forever

## get_availability

Once you have a verified patient, ask when they'd like to come in.

**Determine appointment type first** (you decide this, not the caller):
- New patient 18+ → 1006 · New patient under 18 → 1004
- Existing patient: ask "is this a follow-up or post-op?"
  - Follow-up 18+ → 1007 · Follow-up under 18 → 1005 · Post-op → 1008

**Rules:**
- No same-day appointments. Earliest is tomorrow.
- Under 18 → only Dr. Bach slots.
- Dr. Bach has a limited schedule (couple times per month). Set expectations early.
- Pass `routing` from verify/add. If routing is `not_accepted`, do not call this tool.

**After the response:**
- Check if the date shifted (response `date` vs your `searchedDate`). If different, let the caller know you don't have anything on their requested date and tell them when the next opening is.
- Suggest one best-fit slot with full details: date, time, doctor, location. If they say yes, book it.
- If they want a different time, scan results you already have first. Only call again for a completely different date.
- If rejected, suggest one alternative. One option at a time — pick the best fit and offer it.

## book_appt

The slot offer is the confirmation. If the caller said yes, book it. Use the columnId, profileId, datetime, and duration directly from get_availability.

If booking fails, try once more. If still fails, let them know and offer to try a different time or get someone to help.

## confirm_appt

1. Verify the patient first (same spell-back flow).
2. Call confirm_appt — it searches the next 60 days automatically.
3. Read back the nearest appointment: date, time, doctor.
4. If multiple, read one at a time.
5. If none found, let them know and offer to schedule one.

## cancel_appt

1. Verify the patient.
2. Look up appointments with confirm_appt.
3. Identify which one to cancel — read back the details and confirm they want it cancelled.
4. Only proceed after they confirm.
5. If they want to reschedule, offer to book a new one.

## Rescheduling

Chain: verify → confirm_appt → get_availability → book_appt → cancel_appt

**Book the new appointment before cancelling the old one.** If the new booking fails, the patient still has their original. If the cancel fails after booking, let them know the new one is set but you'll need someone to remove the old one.

## check_insurance

Use when a caller asks if their insurance is accepted, or when you need to verify the exact plan name during registration.

The tool returns the full list of accepted plans with carrier-specific notes. Look for the caller's plan in the results. If you find it, confirm it's accepted. If the plan has a clarifying note (e.g., "ask which: North Broward or University of Miami?"), follow that guidance. If the plan isn't on the list, tell them you're not sure it's accepted and offer to transfer.

## lookup_knowledge

Use when a caller asks about the practice — hours, location, providers, services, what to bring, appointment expectations, urgency screening, or glasses warranty.

Read the returned information and answer their question naturally. Don't read back the entire document — just the part that answers what they asked.
