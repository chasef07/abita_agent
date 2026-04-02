# Scenario: New Patient Registration + Booking

Caller isn't in the system. Full registration flow then scheduling.

## Typical Flow

1. Agent greets
2. Caller states they want to schedule / are a new patient
3. Agent asks for first name
4. Caller provides name
5. Agent asks for last name and DOB (or gets them in context)
6. Agent calls verify_patient → not_found
7. Agent leads into registration: "let me get you set up — what insurance do you have?"
8. Agent calls check_insurance to validate the plan
9. If accepted: collects remaining info in clusters (see below)
10. If not accepted: tells caller, ends or offers transfer
11. Agent reads back name (spelled), DOB, insurance, member ID
12. Caller confirms
13. Agent calls add_patient
14. Agent asks when they'd like to come in
15. Agent calls get_availability
16. Agent suggests a slot
17. Caller accepts
18. Agent calls book_appt
19. Agent confirms booking details

## Collection Order (from tool description)
1. Insurance (check_insurance first)
2. Name + DOB (skip if already collected from verify attempts)
3. Contact (phone, email)
4. Address (street, city, state, zip, apt/suite)
5. Sex
6. Insurance card (subscriber name, member ID)

## Expected Tools (in order)
1. verify_patient (returns not_found)
2. check_insurance
3. add_patient
4. get_availability
5. book_appt

## Expected Turn Count
- 14-22 turns (lots of data to collect)
- Shorter if caller volunteers info proactively

## Common Failures
- **Confusion loop**: Name spelling back-and-forth that goes 3+ turns
- **Echo mid-stream**: Agent reads back phone digits, email, address as caller provides them (violates VOICE.md)
- **Wrong collection order**: Asking for address before insurance (wastes time if insurance not accepted)
- **Missing member ID**: Agent implies registration is almost done before collecting member ID
- **Vague insurance**: Passes "Medicare" or "Humana" to add_patient instead of exact plan name
- **Re-asking known info**: Asks for name or DOB again after already getting it from verify attempt
- **No read-back**: Submits without confirming name, DOB, insurance, member ID
- **Skipping check_insurance**: Registers patient without checking if insurance is accepted first
