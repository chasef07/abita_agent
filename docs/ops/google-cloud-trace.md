# Google Cloud Trace

## Architecture

LiveKit Agents → authenticated OTLP/HTTP collector on Cloud Run → Google Telemetry
API → Cloud Trace. The agent's exporter runs in the background and retains the
LiveKit Insights exporter through `FanoutSpanProcessor`.

Direct export was investigated first. The production project's organization
policy blocks service-account key creation. The collector therefore uses an
attached Google service account; no Google private key is created or uploaded to
LiveKit. Its bearer token grants access only to the collector's trace receiver.

`src/runtime/google-cloud-tracing.ts` owns agent export. The pinned standard
OpenTelemetry Collector and its configuration live in `ops/google-cloud-trace/`.
The collector overwrites `gcp.project_id` with its configured destination.

## Google Cloud setup

Enable `telemetry.googleapis.com`, `cloudtrace.googleapis.com`, `observability.googleapis.com`,
`run.googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`,
and `secretmanager.googleapis.com` in the destination project.

The collector's dedicated service account needs:

- `roles/telemetry.tracesWriter` on the destination project.
- `roles/serviceusage.serviceUsageConsumer` on that project.
- `roles/secretmanager.secretAccessor` on its ingest-token secret only.

Generate a random 32-byte ingest token and store it in Secret Manager. Build the
collector from `ops/google-cloud-trace`, then deploy the image to Cloud Run with:

- The dedicated service account attached.
- `GOOGLE_CLOUD_PROJECT` set to the destination project.
- `TRACE_INGEST_TOKEN` supplied from a pinned Secret Manager version.
- HTTP port 8080, request-based billing, 1 CPU, 512 MiB memory.
- Minimum 0 instances, maximum 2 instances, concurrency 20, request timeout 30s.
- Public HTTPS ingress with application authentication: every trace request
  requires the bearer token. Cloud Run's IAM invocation layer must permit the
  request so the collector can authenticate it. Use `--no-invoker-iam-check`,
  Google's documented option for domain-restricted sharing; an `allUsers` IAM
  binding is rejected by this organization. The collector still rejects
  missing or incorrect tokens. Organization policies are not changed.

The receiver accepts only traces and limits request bodies to 4 MiB. No debug
exporter, logs pipeline, or metrics pipeline is enabled. The collector has no
batch processor or background sending queue: it acknowledges only after Google
responds, so request-based CPU throttling cannot strand accepted batches. The
agent's OTLP exporter handles bounded retries of transient HTTP failures.

## LiveKit configuration

Set both secrets together:

```dotenv
GOOGLE_CLOUD_TRACE_ENDPOINT=https://your-collector.run.app/v1/traces
GOOGLE_CLOUD_TRACE_TOKEN=the-secret-manager-token
```

`lk agent update-secrets --secrets-file /secure/path/tracing.env` merges these with
existing secrets and triggers a rolling restart. Never use `--overwrite` for
this change. Removing both values disables the exporter; setting only one is a
configuration error. Credentials and actual internal endpoint URLs must stay out
of source control.

The agent registers its provider before session startup. It sets service name
`abita-agent` and deployment environment, strips recognized content using
`allowPii: false`, batches asynchronously, and flushes during job shutdown.
Known conversation fields, tool arguments/results, and exception content are
removed from external spans. Custom unmarked attributes still require review.
Export errors log only a fixed message and span count, never the raw transport
error, request payload, or authorization header.

## Verification and release

Run the repository's format, lint, typecheck, and test checks. The tracing tests
exercise content stripping, parent/child IDs, additional processor registration,
authentication configuration, disabled/invalid configuration, shutdown flushing,
and failed exports.

Validate the collector configuration with the pinned collector binary before
building. Against the deployed collector, verify unauthenticated requests fail
and a synthetic trace reaches Cloud Trace with the expected service resource.
A local synthetic span proves Google ingestion, not deployment of the agent.
Use Trace Explorer or Observability Analytics to inspect stored spans. Google's
legacy Cloud Trace API cannot retrieve Telemetry API spans and can return 404
even after export succeeds. See the [documented limitation](https://docs.cloud.google.com/trace/docs/troubleshooting#known-issues).

Release agent changes through the normal release workflow described in
`release-automation.md`. After release, verify a synthetic LiveKit session appears
in both Insights and Cloud Trace with final session spans and no content fields.
Do not claim production agent ingestion until this deployed path is observed.

## Cost

Checked September 7, 2026: Cloud Trace costs $0.20 per million spans after the
first 2.5 million spans per billing account per month. Retention is 30 days.
A call has many spans; measure actual spans per call before forecasting.

| Calls/month | Assumed spans/call | Trace ingestion/month |
| ----------: | -----------------: | --------------------: |
|      10,000 |                100 |                 $0.00 |
|     100,000 |                100 |                 $1.50 |
|     100,000 |                500 |                 $9.50 |

These examples assume the full free allowance is available. Cloud Run adds
request/compute charges and scales to zero. Tier 1 request-based prices before
free tiers are $0.40/million requests, $0.000024/vCPU-second, and
$0.0000025/GiB-second. For example, 1 million non-overlapping 100ms requests at
1 CPU/512 MiB cost about $2.93 before free tiers, excluding cold starts, logs,
network, image storage/builds, and Secret Manager. Actual duration and concurrency
change that estimate; the existing billing account shares the free tiers.

## Sources

- [Google OTLP setup and IAM](https://docs.cloud.google.com/trace/docs/migrate-to-otlp-endpoints)
- [LiveKit tracing](https://docs.livekit.io/deploy/observability/tracing/)
- [LiveKit secrets](https://docs.livekit.io/deploy/agents/secrets/)
- [Collector bearer authentication](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/extension/bearertokenauthextension)
- [Collector Google authentication](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/extension/googleclientauthextension)
- [Cloud Trace pricing](https://cloud.google.com/products/observability/pricing#cloud-trace)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Cloud Run application-authenticated ingress](https://docs.cloud.google.com/run/docs/authenticating/public)
- [Trace retention](https://docs.cloud.google.com/trace/docs/quotas)
