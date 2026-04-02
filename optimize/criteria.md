# Evaluation Criteria

When reviewing a transcript, flag concrete behavioral issues. Each issue references specific turns and explains what went wrong. A single real issue in one transcript is enough to act on — we get lots of edge cases.

## Issue Types

### Unnecessary Transfer
The agent transferred the call when it had the tools and information to handle the request.

**Flag when:**
- Caller asks about scheduling, insurance, hours, providers, or services and gets transferred
- Agent transfers after a tool error instead of retrying or handling gracefully
- Agent transfers because it's unsure, but the answer is in lookup_knowledge or check_insurance
- Agent transfers without attempting to resolve the caller's concern first

**Do NOT flag when:**
- Caller asks for medical records, prescriptions, clinical questions, glasses/contacts — these require a human
- Caller explicitly asks to speak to a person and insists after agent offers to help
- Caller asks for a specific employee by name

### Missed Transfer
The agent tried to handle something it shouldn't have, or failed to transfer when it clearly should.

**Flag when:**
- Caller has a clinical question (symptoms, medications, test results) and agent tries to answer
- Caller asks for medical records or prescriptions and agent doesn't transfer
- Agent reaches a dead end (can't help, no tools for this) but doesn't offer a transfer
- Caller is clearly frustrated and wants a human but agent keeps trying

**Do NOT flag when:**
- Agent reasonably attempts to handle a borderline case before offering transfer

### Missed Intent
The caller asked for one thing and the agent did something else, or ignored the request entirely.

**Flag when:**
- Caller states their reason for calling and agent goes down a different path
- Agent assumes scheduling intent when caller just had a question
- Caller corrects the agent and the correction is ignored
- Agent asks for information the caller already provided
- Caller says something and agent responds to a different interpretation

**Do NOT flag when:**
- Agent clarifies an ambiguous request before proceeding (that's good)

### Confusion Loop
The conversation gets stuck — repeating, contradicting, or going in circles.

**Flag when:**
- Agent asks the same question twice (or more)
- Agent and caller go back and forth on spelling, dates, or other data for 3+ turns
- Agent contradicts something it said earlier in the same call
- Agent calls the same tool with the same arguments twice
- Agent repeats an acknowledgment phrase consecutively ("got it... got it... got it")
- Agent echoes back data mid-stream during collection (violates VOICE.md)

**Do NOT flag when:**
- Agent re-asks because the caller gave unclear or contradictory info (that's reasonable)

### Wrong Outcome
The agent completed an action, but it was the wrong one.

**Flag when:**
- Booked the wrong appointment type, wrong date, wrong provider
- Registered patient with incorrect information (wrong insurance, wrong DOB format)
- Gave incorrect information about hours, providers, or services
- Cancelled the wrong appointment
- Told caller insurance is accepted when it's not (or vice versa)

**Do NOT flag when:**
- The error came from the API/tool returning bad data (not the agent's fault)

## How to Use These Criteria

For each transcript:

1. Read the full conversation turn by turn
2. For each issue found, record:
   - **Type**: Which issue category
   - **Turn(s)**: Which turn numbers
   - **What happened**: One sentence describing the problem
   - **Root cause**: Is this a prompt issue, tool description issue, or edge case the prompt doesn't cover?
   - **Fixable**: Can this be addressed by changing workspace/*.md or tool descriptions in src/tools.ts?

3. Skip calls with 1 turn (hangups) and calls under 5 seconds (no real interaction)
4. Focus on fixable issues — if the root cause is the LLM hallucinating despite clear instructions, note it but don't try to fix it with more prompt text
