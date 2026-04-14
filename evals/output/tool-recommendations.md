# Tool-Layer Recommendations

This report only covers failures that look like tool-contract, tool-semantics, grounding, or state-transition problems.
These are the failures you should not try to solve with a broad prompt rewrite.

Baseline eval: `eval-lon-2026-04-14T22:52:05`

## Audit-derived tool-layer clusters

_No tool-layer clusters found._
## Promptfoo-derived tool-layer clusters

### confirm × 1
Issue: confirm_appt grounding or context contract is unclear
Recommendation: Review the confirm flow contract. Make it explicit in tool definitions/helpers when context is sufficient and when confirm_appt must be called.
Examples:
- confirm-appt-requires-tool-without-context-001: [javascript] 0/1 checks passed || [javascript] Did not call required tool confirm_appt

### routing × 1
Issue: routing tool semantics between transfer_call and route_to_spring_hill are too ambiguous
Recommendation: Clarify routing tool responsibilities in code comments/tool docs and make the routing choice easier to infer from office and patient type.
Examples:
- crystal-river-peds-routing-001: [javascript] 1/2 checks passed || [javascript] Did not call required tool route_to_spring_hill || [llm-rubric] The reply uses 'yeah' which sounds tentative and informal, failing the confident tone requirement. There is no evidence of routing or transfer call in toolCalls, so routing criteria cannot be confirmed. The reply is somewhat concise but the tone issue causes failure.

### reschedule × 1
Issue: tool argument requirements need stricter validation or examples
Recommendation: Strengthen tool schemas and examples so required args are obvious and invalid calls fail fast.
Examples:
- reschedule-book-before-cancel-001: [javascript] 1/2 checks passed || [javascript] Missing required phrase hint "reason" || [llm-rubric] The response does not attempt to reschedule or cancel any appointment, so it does not violate the rule about booking before cancelling. However, it does not ask for a reason for the visit before proceeding, and it does not call get_availability. The reply is concise and without filler.

### transfer × 1
Issue: tool argument requirements need stricter validation or examples
Recommendation: Strengthen tool schemas and examples so required args are obvious and invalid calls fail fast.
Examples:
- transfer-billing-immediate-001: [javascript] 3/4 checks passed || [javascript] Missing required phrase hint "transfer"

