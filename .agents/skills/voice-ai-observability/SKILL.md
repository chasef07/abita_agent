---
name: voice-ai-observability
description: Audit Voice AI calls from database transcripts, tool calls, outcomes, lifecycle events, and sentiment. Use for daily call-quality review, anomaly detection, failure ranking, and delivery of a cited HTML and PDF report.
---

# Voice AI Observability

Review every call in a frozen daily window. Judge calls one at a time, rank the anomalies, and email a concise report.

## 1. Establish the dataset

- Use available database tools with read-only access.
- For PostgreSQL on Google Cloud SQL, read [references/cloud-sql-postgres.md](references/cloud-sql-postgres.md) completely before connecting or querying.
- Inspect the live schema; do not assume provider, table, or field names.
- Freeze the requested time window and timezone before querying.
- Load all calls in scope. Do not sample or pre-filter the review set.
- Record the source, filters, frozen window, and total call count.

## 2. Review one call at a time

For each call, load the available transcript, tool calls and results, lifecycle events, final outcome, duration, and sentiment or acoustic signals.

Reconstruct the smallest useful timeline:

```text
caller intent -> agent response -> tool call -> tool result -> agent claim -> final state
```

Append one compact result to a temporary ledger, then release the raw call from working context. Never copy full transcripts into the ledger or report.

Use one JSONL record per call with these fields:

```text
call_id, started_at, duration_seconds, intent, conversation_score,
tool_score, truthfulness_score, classification, sentiment_change,
sentiment_cause, anomalies, evidence_refs, caller_impact, investigate,
confidence
```

## 3. Score the call

Score each dimension from 1 to 5. Use `N/A` and flag an instrumentation gap when evidence is insufficient.

### Conversation and sentiment

Judge intent understanding, clarity, efficiency, frustration handling, and recovery. Describe sentiment as `start -> end`, assign `high`, `medium`, or `low` confidence, and attribute negative sentiment as `agent_caused`, `pre_existing`, `mixed`, or `unclear`.

### Tool workflow

Good flow uses the correct tool at the correct stage, satisfies prerequisites, supplies grounded inputs, follows the required order, interprets results accurately, retries only after material change, and recovers safely.

Bad flow uses the wrong tool, calls too early, omits required inputs, repeats a failure without new information, uses stale state, continues after a terminal result, or fails without giving the caller a safe next step.

### Outcome truthfulness

Compare every material agent claim with tool results and final state. Spoken claims, aggregate flags, and initiated actions do not prove completion. Flag unsupported, contradictory, irrelevant, nonsensical, or hallucinated statements.

Use these anchors consistently:

- `5`: healthy; no material issue
- `4`: minor friction without meaningful caller impact
- `3`: material friction that was recovered
- `2`: unresolved failure or misleading behavior
- `1`: severe failure, false outcome claim, or unsafe behavior

## 4. Apply guaranteed anomaly rules

Flag a call when any condition holds:

1. A tool call failed. Prioritize booking and rescheduling failures and explain the failed step.
2. The call exceeded five minutes and no appointment was booked. Explain the caller intent and observed blocker; do not assume the call should have produced a booking.
3. The caller showed negative sentiment. Cite the change and distinguish agent-caused frustration from pre-existing frustration.
4. The agent made an unsupported, contradictory, irrelevant, nonsensical, or hallucinated statement.
5. The agent's claimed outcome does not match tool or final-state evidence.

Classify the call as `confirmed_issue`, `ambiguous`, `recovered`, or `healthy`.

## 5. Cite every finding

Identify each flagged call with its stable database call ID, start time, and duration. Do not use a phone number as the citation.

For every anomaly include:

- Caller intent
- Exact anomaly or error category
- Three scores
- Transcript turn number or timestamp
- Tool name and result when relevant
- Final-state evidence
- Sentiment movement and attribution
- Caller impact
- Recommended investigation
- Confidence

Separate `Observed error`, `Workflow issue`, and `Likely cause`. Label inference and use `Unknown` when the evidence does not establish a cause.

No anomaly enters the report without a specific call citation and supporting evidence. A recurring pattern must cite every supporting call.

## 6. Rank anomalies

When all three scores are available, add them for a total out of 15 and rank lower totals first. Break ties by lower outcome truthfulness, then tool workflow, then conversation and sentiment. Put confirmed issues before ambiguous cases when scores tie. List calls with any `N/A` score under instrumentation gaps instead of inventing a rank.

## 7. Create and verify the report

Create `voice-ai-observability-YYYY-MM-DD.html` and `voice-ai-observability-YYYY-MM-DD.pdf`.

Keep the report simple and include:

1. Audit source, frozen window, and calls reviewed
2. Average score for each dimension
3. Counts of confirmed, ambiguous, recovered, and healthy calls
4. Counts of tool errors, booking or rescheduling failures, long calls without booking, negative sentiment, and unsupported statements
5. Ranked anomaly table with call citations
6. One concise evidence card per flagged call
7. Recurring patterns and their supporting calls
8. Instrumentation gaps

Use short sanitized excerpts only. Exclude caller names, phone numbers, patient information, credentials, private URLs, and raw transcripts.

Use the `$pdf` skill to render the PDF, inspect every page, and correct clipping, overflow, broken tables, or unreadable text. Confirm the HTML and PDF contain the same findings.

## 8. Email the report

After verification, use `$gmail` to send the report to `chase@acuityhealth.io` and `kyle@acuityhealth.io`.

- Subject: `Voice AI Daily Observability - YYYY-MM-DD`
- Body: concise HTML summary with counts and the highest-priority anomaly
- Attachment: verified PDF report

Report delivery only after Gmail accepts the send. If Gmail is unavailable or sending fails, preserve both reports, report the failure, and do not substitute another email service.

Send at most once per reporting window unless the user explicitly requests a resend.
