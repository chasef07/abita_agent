# Tool-Layer Recommendations

This report only covers failures that look like tool-contract, tool-semantics, grounding, or state-transition problems.
These are the failures you should not try to solve with a broad prompt rewrite.

Baseline eval: `eval-tcH-2026-04-15T05:18:45`

## Audit-derived tool-layer clusters

### immediate_transfer × 2
Issue: Agent disclosed being AI, which is a policy violation.
Recommendation: Review this cluster as a tool contract problem first, not a prompt rewrite. Prefer a stricter helper, wrapper, schema, or state transition.
Examples:
- SCL_f3wXF3Nf3wyc: Caller asked for Debbie and was transferred immediately with proper message.
- SCL_XWWGTzkhEAWF: Caller requested a human and was transferred immediately after one pushback.

### confirm × 1
Issue: confirm_appt tool was never called despite confirming appointment.
Recommendation: Review the confirm flow contract. Make it explicit in tool definitions/helpers when context is sufficient and when confirm_appt must be called.
Examples:
- SCL_7YCwBupKJR9K: Agent did not call confirm_appt tool before confirming appointment details to caller.

### cancel_rebook × 1
Issue: Did not call cancel_appt after rescheduling as required.
Recommendation: Make cancellation completion depend on cancel_appt success instead of verbal confirmation alone.
Examples:
- SCL_A52nxfk6G4CK: Agent did not confirm cancellation or complete rescheduling; call ended before booking or cancelling appointment.

### confirm × 1
Issue: Did not call confirm_appt to confirm upcoming appointments before answering.
Recommendation: Review the confirm flow contract. Make it explicit in tool definitions/helpers when context is sufficient and when confirm_appt must be called.
Examples:
- SCL_6LPmSg3d6Pzo: Caller’s request to confirm surgery date was outside agent’s scope and was transferred properly with full transfer message.

## Promptfoo-derived tool-layer clusters

### transfer × 2
Issue: tool argument requirements need stricter validation or examples
Recommendation: Strengthen tool schemas and examples so required args are obvious and invalid calls fail fast.
Examples:
- transfer-billing-immediate-001: [javascript] 3/4 checks passed || [javascript] Missing required phrase hint "transfer"
- transfer-first-human-pushback-001: [javascript] 1/2 checks passed || [javascript] Missing required phrase hint "calling about" || [llm-rubric] The agent asks what the caller needs help with before deciding to transfer, fulfilling the first criterion. However, the reply is somewhat verbose and informal ('yeah I'm actually an AI assistant helping at the front desk here. I'm just here to help — what can I do for you?'), which may not be considered brief or to the point. Therefore, it does not fully satisfy the brevity criterion.

### registration × 1
Issue: add_patient preconditions or readback contract are too loose
Recommendation: Tighten add_patient preconditions in the tool wrapper or planner. Reject submission without required readback-confirmed fields.
Examples:
- registration-add-patient-after-confirmation-001: [javascript] 0/1 checks passed || [javascript] Did not call required tool add_patient || [llm-rubric] The output shows that add_patient was called with all required fields, but the actual values are not shown, so it's unclear if they were collected from the caller or guessed. The finalText includes a filler phrase 'perfect, you're all set.' which is somewhat conversational and could be considered filler. The toolCalls array is empty, which contradicts the message that add_patient was called. Therefore, the response does not fully meet the rubric criteria.

### cancel × 1
Issue: cancel_appt completion step is not enforced strongly enough
Recommendation: Make cancellation completion depend on cancel_appt success instead of verbal confirmation alone.
Examples:
- SCL_f9vxp8YjNAFQ-cancel-turn-6: [llm-rubric] The agent correctly identified the intent as rescheduling an existing appointment and confirmed the patient's first name before proceeding. The agent offered available times on the requested date and confirmed the new appointment time verbally. However, the agent did not call the required cancel_appt tool to cancel the original appointment after booking the new one, which is mandatory per the runbook for rescheduling. The agent's phrasing is clear, concise, and follows the tone and length guidelines. No prohibited information was disclosed, and the language matches the caller's. Therefore, the main failure is the missing cancel_appt tool call, which is required to complete the rescheduling process.

### confirm × 1
Issue: confirm_appt grounding or context contract is unclear
Recommendation: Review the confirm flow contract. Make it explicit in tool definitions/helpers when context is sufficient and when confirm_appt must be called.
Examples:
- confirm-appt-requires-tool-without-context-001: [javascript] 0/1 checks passed || [javascript] Did not call required tool confirm_appt

### registration × 1
Issue: registration insurance-gate ordering needs stronger enforcement
Recommendation: Add a stricter registration state transition around check_insurance so downstream steps cannot proceed before insurance acceptance is grounded.
Examples:
- registration-runs-check-insurance-001: [javascript] 1/2 checks passed || [javascript] Did not call required tool check_insurance || [llm-rubric] The agent did not run check_insurance after receiving the exact insurance plan name 'PPO' and instead immediately asked for the caller's name without confirming acceptance of the insurance. The response also contains filler ('yeah'), making it not concise.

### routing × 1
Issue: routing tool semantics between transfer_call and route_to_spring_hill are too ambiguous
Recommendation: Clarify routing tool responsibilities in code comments/tool docs and make the routing choice easier to infer from office and patient type.
Examples:
- crystal-river-peds-routing-001: [javascript] 1/2 checks passed || [javascript] Did not call required tool route_to_spring_hill || [llm-rubric] The response uses 'yeah' which sounds tentative and informal, failing the confident tone requirement. The response is concise and has no tool calls, but it does not demonstrate routing logic, so the routing criterion cannot be confirmed. Overall, it fails due to tone and lack of routing.

### reschedule × 1
Issue: tool argument requirements need stricter validation or examples
Recommendation: Strengthen tool schemas and examples so required args are obvious and invalid calls fail fast.
Examples:
- reschedule-book-before-cancel-001: [javascript] 1/2 checks passed || [javascript] Missing required phrase hint "reason" || [llm-rubric] The response does not attempt to cancel or reschedule any appointment before confirming if an appointment exists, thus not violating the reschedule-before-cancel rule. However, it does not ask for a reason for the visit before proceeding, and it does not call get_availability. The reply is concise and free of filler or over-explanation.

