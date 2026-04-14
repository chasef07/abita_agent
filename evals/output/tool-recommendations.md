# Tool-Layer Recommendations

This report only covers failures that look like tool-contract, tool-semantics, grounding, or state-transition problems.
These are the failures you should not try to solve with a broad prompt rewrite.

Baseline eval: `eval-s6B-2026-04-14T23:19:21`

## Audit-derived tool-layer clusters

_No tool-layer clusters found._
## Promptfoo-derived tool-layer clusters

### registration × 1
Issue: add_patient preconditions or readback contract are too loose
Recommendation: Tighten add_patient preconditions in the tool wrapper or planner. Reject submission without required readback-confirmed fields.
Examples:
- registration-add-patient-after-confirmation-001: [javascript] 0/1 checks passed || [javascript] Did not call required tool add_patient || [llm-rubric] The output shows a call to add_patient with all required fields, but it is unclear if all fields were collected from the caller or if any placeholders or guesses were used. The finalText includes a system message '[Called add_patient with all required fields] returned: patient created and verified.' which suggests the call was made properly. The reply is concise and does not contain filler or over-explanation. However, since the output does not explicitly confirm that all required fields were collected from the caller and that no placeholders or guesses were used, it cannot be fully verified that the first two criteria are met. Therefore, the response does not fully pass the rubric.

### cancel × 1
Issue: cancel_appt completion step is not enforced strongly enough
Recommendation: Make cancellation completion depend on cancel_appt success instead of verbal confirmation alone.
Examples:
- past-appointment-cant-cancel-001: [javascript] 1/2 checks passed || [javascript] Missing required phrase hint "already" || [llm-rubric] The agent does not mention that the appointment is past or that it cannot be cancelled, nor does it offer to schedule a new one. The agent also calls 'confirm_appt' but does not attempt to cancel the appointment, which is correct. The reply is somewhat concise but includes filler phrases like 'let me pull up your appointment.' The tone is warm and helpful. However, the key requirement to explain that past appointments cannot be cancelled and to offer scheduling a new one is missing, so the response fails the rubric.

### confirm × 1
Issue: confirm_appt grounding or context contract is unclear
Recommendation: Review the confirm flow contract. Make it explicit in tool definitions/helpers when context is sufficient and when confirm_appt must be called.
Examples:
- confirm-appt-requires-tool-without-context-001: [javascript] 0/1 checks passed || [javascript] Did not call required tool confirm_appt

### insurance × 1
Issue: insurance acceptance flow needs a clearer required-tool contract
Recommendation: Document check_insurance as the only grounding path for plan acceptance and add examples for ambiguous plan names.
Examples:
- insurance-acceptance-check-tool-001: [llm-rubric] The agent correctly calls check_insurance with the plan 'Aetna PPO' and does not answer from memory. However, the reply includes filler phrases like 'let me check that for you' and 'I can't confirm that from the shorthand alone,' which makes it less concise than ideal.

### routing × 1
Issue: routing tool semantics between transfer_call and route_to_spring_hill are too ambiguous
Recommendation: Clarify routing tool responsibilities in code comments/tool docs and make the routing choice easier to infer from office and patient type.
Examples:
- crystal-river-peds-routing-001: [javascript] 1/2 checks passed || [javascript] Did not call required tool route_to_spring_hill || [llm-rubric] The reply uses 'yeah' which sounds tentative and informal, failing the confident tone requirement. The reply is concise and has no tool calls, but the routing criteria cannot be evaluated as no routing action is taken. Overall, the lack of confident tone causes failure.

### reschedule × 1
Issue: tool argument requirements need stricter validation or examples
Recommendation: Strengthen tool schemas and examples so required args are obvious and invalid calls fail fast.
Examples:
- reschedule-book-before-cancel-001: [javascript] 1/2 checks passed || [javascript] Missing required phrase hint "reason" || [llm-rubric] The response does not attempt to cancel any appointment before booking a new one, it asks a clarifying question about the existing appointment but does not ask for a reason for visit, and the reply is concise without filler or over-explanation.

### transfer × 1
Issue: tool argument requirements need stricter validation or examples
Recommendation: Strengthen tool schemas and examples so required args are obvious and invalid calls fail fast.
Examples:
- transfer-billing-immediate-001: [javascript] 3/4 checks passed || [javascript] Missing required phrase hint "transfer"

### scheduling × 1
Issue: tool argument requirements need stricter validation or examples
Recommendation: Strengthen tool schemas and examples so required args are obvious and invalid calls fail fast.
Examples:
- SCL_TarxLthDHCzV-scheduling-turn-4: [llm-rubric] The agent correctly identified the caller as an existing patient (Tanya) and acknowledged the current appointment. The caller requested to reschedule to next Wednesday. The agent responded with a natural, concise phrase: 'Let me check the calendar for next Wednesday.' However, the agent called get_availability three times with the same date argument (2026-04-22), which violates the runbook rule 'Do not call the same tool with the same input twice unless you got new information.' Also, the agent did not ask for the reason for visit before calling get_availability, violating the rule 'Always ask the reason for visit before calling get_availability.' The agent did not confirm the new appointment date and time before booking, but since this is only the availability check step, that is acceptable. Overall, the agent failed to follow the runbook because of redundant tool calls and missing the reason for visit before availability check.

