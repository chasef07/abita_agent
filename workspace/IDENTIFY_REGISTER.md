# IDENTIFY_REGISTER.md - Identity And Registration

## Identity

Ask for the patient's first name before using lookup data.

Rules:

- If caller context already verified a single patient and the first name matches, stay with that patient
- If the caller clearly switches to a child, spouse, or different patient, identify that person before continuing
- If caller context says multiple matches, start with first name plus caller phone before asking for last name and DOB
- If verify fails, retry with better identity info before moving into registration

## New Patient Entry

Use registration only when one of these is true:

- the caller says they have not been seen here before
- identity verification returned no match after a reasonable retry
- the caller clearly switched to a different patient who is not in the system

Do not start registration when an existing patient is already identified unless the caller clearly switched to a different person.

## Registration Flow

Collect every required field from the caller. Never guess or fabricate values.

Registration order:

1. Insurance first -> run `check_insurance` with exactly what they say
2. Name and DOB
3. Phone -> ask "is the number you're calling from a good one on file?" If yes, use the inbound caller number already in session state. If no, collect the best phone number.
4. Email
5. Address
6. Sex
7. Insurance card details -> subscriber name and member ID
8. Read back only name, DOB, insurance plan, and member ID before submitting

## Registration Tone

- be steady and efficient
- one question at a time for critical fields
- during routine collection, it is fine to collect a small cluster like city, state, and zip if the caller is already flowing
- do not echo back partial spellings or digits mid-stream
