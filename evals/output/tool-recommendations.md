# Tool-Layer Recommendations

This report only covers failures that look like tool-contract, tool-semantics, grounding, or state-transition problems.
These are the failures you should not try to solve with a broad prompt rewrite.

Baseline eval: `eval-1i1-2026-04-14T15:44:25`

## Audit-derived tool-layer clusters

### immediate_transfer × 1
Issue: Agent revealed AI status contrary to runbook guidance.
Recommendation: Review this cluster as a tool contract problem first, not a prompt rewrite. Prefer a stricter helper, wrapper, schema, or state transition.
Examples:
- SCL_XWWGTzkhEAWF: Caller requested human twice and was transferred after proper pushback.

### confirm × 1
Issue: confirm_appt tool was never called to verify appointment details.
Recommendation: Review the confirm flow contract. Make it explicit in tool definitions/helpers when context is sufficient and when confirm_appt must be called.
Examples:
- SCL_7YCwBupKJR9K: Appointment was confirmed verbally, matching caller intent.

### cancel_rebook × 1
Issue: Did not call cancel_appt after booking new appointment for reschedule.
Recommendation: Make cancellation completion depend on cancel_appt success instead of verbal confirmation alone.
Examples:
- SCL_A52nxfk6G4CK: No cancel_appt call made; appointment not actually cancelled.

### confirm × 1
Issue: Did not call confirm_appt to confirm existing appointments before reading them.
Recommendation: Review the confirm flow contract. Make it explicit in tool definitions/helpers when context is sufficient and when confirm_appt must be called.
Examples:
- SCL_6LPmSg3d6Pzo: Caller’s request to confirm surgery date was transferred appropriately.

## Promptfoo-derived tool-layer clusters

### registration × 1
Issue: add_patient preconditions or readback contract are too loose
Recommendation: Tighten add_patient preconditions in the tool wrapper or planner. Reject submission without required readback-confirmed fields.
Examples:
- registration-add-patient-after-confirmation-001: [javascript] 0/1 checks passed || [javascript] Did not call required tool add_patient

### insurance × 1
Issue: insurance acceptance flow needs a clearer required-tool contract
Recommendation: Document check_insurance as the only grounding path for plan acceptance and add examples for ambiguous plan names.
Examples:
- insurance-acceptance-check-tool-001: [llm-rubric] The agent correctly calls the 'check_insurance' tool with the specified plan 'Aetna PPO' and does not answer from memory. However, the finalText includes filler phrases like 'let me check that for you' and 'Is there anything else I can help you with?', making the reply not concise.

### reschedule × 1
Issue: tool argument requirements need stricter validation or examples
Recommendation: Strengthen tool schemas and examples so required args are obvious and invalid calls fail fast.
Examples:
- reschedule-book-before-cancel-001: [javascript] 1/2 checks passed || [javascript] Missing required phrase hint "reason" || [llm-rubric] The agent does not cancel any appointment before booking a new one, but it also does not ask for a reason for the visit before proceeding. The response is concise and without filler.

