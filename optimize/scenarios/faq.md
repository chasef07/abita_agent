# Scenario: Quick Question (FAQ)

Caller has a question — insurance, hours, providers, services. No scheduling, no identification needed.

## Variants

### Insurance Check
- Caller: "Do you accept [plan name]?"
- Agent: calls check_insurance, gives a clear yes/no
- If not accepted: "unfortunately we don't accept that plan"
- If accepted: confirm and let the caller lead (don't push scheduling)
- If ambiguous plan name (e.g., "Humana"): ask which specific plan

### Practice Info
- Caller: "What are your hours?" / "Do you see kids?" / "Where are you located?"
- Agent: calls lookup_knowledge, answers naturally from the result
- Don't read the entire knowledge doc — just what answers their question

### Multi-part Question
- Caller asks about insurance AND wants to schedule
- Handle the question first, then transition to scheduling only if they bring it up

## Expected Tools
- check_insurance (1 call) and/or lookup_knowledge (1 call)
- No verify_patient, no scheduling tools

## Expected Turn Count
- 2-4 turns (greeting + question + answer + goodbye)
- Up to 6 if follow-up questions

## Common Failures
- **Unnecessary transfer**: Agent transfers a simple insurance or hours question instead of using check_insurance/lookup_knowledge
- **Pushing scheduling**: Caller just asked a question, agent steers into "would you like to schedule?"
- **Wrong insurance answer**: Agent says a plan is accepted when it's not, or vice versa
- **Over-qualifying**: Agent asks for name, DOB, etc. when it's just a simple question
