# Middleware tool diagnostics

Each middleware request gets a UUID before dispatch. The same `X-Request-ID`
appears in middleware logs and the agent's diagnostic record, including client
timeouts where no response headers arrive.

The seven middleware tools execute inside an isolated async diagnostic scope.
The agent records each attempt's transport result, HTTP status, original safe
middleware outcome/category, response status, independent appointment-load
status, provider failures, duration, and normalization/retry disposition, including
explicit booking/cancellation rejections and the fixed `missing_appointment_id`
validation detail. Retry permission uses the same policy as the tool runtime. Raw
messages, arguments, credentials, provider bodies and patient values are excluded.

Existing runtime failure reasons and retry rules are unchanged. In particular,
`indeterminate_write` remains non-retryable; recovered read attempts retain their
original failure even when a later attempt succeeds.

LiveKit 1.8 invokes user code before it starts the `function_tool` span. The
agent therefore owns a separate `middleware_tool` span correlated by
`gen_ai.tool.call.id` and `gen_ai.tool.name`. The final `abita.middleware.requests`
attribute contains the complete normalized records. Earlier per-request events
are transport observations; normalization/retry fields are finalized afterward.

The same records are persisted as `middlewareRequests` on the existing receipt
for the tool's call ID. A tool without a domain receipt gets a diagnostics-only
receipt (`outcome: middleware_diagnostics`, `status: observed`); it establishes
no patient/domain success. Product intentionally omits that receipt from its
domain-status display while showing its diagnostics. Completed/recovered domain
receipts retain their authoritative outcome and status.

Product's operator tool detail shows these attempts beneath the native execution
status. Absence of new headers on older middleware deployments is supported;
missing provider status/code stays unknown. The model-facing recovery message
is separate from operator diagnostics.
