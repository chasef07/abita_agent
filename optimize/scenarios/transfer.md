# Scenario: Transfer to Human

Caller needs something outside the agent's scope, or explicitly requests a human.

## Appropriate Transfers
- Medical records requests (from patients or provider offices)
- Prescription refills or medication questions
- Clinical questions (symptoms, test results, treatment)
- Glasses orders, optical, eyewear status
- Surgery coordination or post-op clinical concerns
- Caller asks for a specific person by name ("Debbie told me to call back")
- Billing or payment questions
- Caller insists on a human after agent offered to help once

## NOT Appropriate Transfers
- Insurance questions (use check_insurance)
- Office hours, location, providers (use lookup_knowledge)
- Scheduling, confirming, cancelling appointments (agent handles directly)
- "I want to talk to someone" without a specific reason — try once: "would you mind telling me what you're calling about?" If it's handleable, handle it. If they insist, transfer.

## Expected Flow
1. Caller states their need
2. Agent recognizes it's outside scope (or caller insists on human)
3. Agent announces the transfer: "let me transfer you to someone at the office who can help with [specific thing]"
4. Agent waits for TTS to finish (full sentence heard by caller)
5. Agent calls transfer_call exactly once

## Expected Tools
- transfer_call (exactly 1 call)
- Maybe lookup_knowledge or check_insurance if agent tried to handle first

## Expected Turn Count
- 2-4 turns (greeting + request + transfer announcement + transfer)
- Up to 6 if agent appropriately tries to handle first before transferring

## Common Failures
- **Double transfer_call**: Tool called twice (causes duplicate SIP transfer)
- **Silent transfer**: Agent calls transfer_call without announcing it first
- **Transfer mid-sentence**: Agent starts speaking transfer message but calls tool before TTS finishes
- **Premature transfer**: Caller mentions something borderline and agent transfers without trying to help first
- **Unnecessary transfer**: Caller asks about insurance or hours and gets transferred instead of agent using its tools
- **Promise then transfer**: Agent says "I can help with that" then realizes it can't and transfers — should have recognized the out-of-scope request immediately
- **No transfer when needed**: Caller asks about prescriptions or medical records and agent tries to handle it with scheduling tools
