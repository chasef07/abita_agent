# Cloud SQL PostgreSQL

Use this adapter when call evidence lives in PostgreSQL on Google Cloud SQL.

## Safety contract

- Never request, print, or store a person's Google password, database password, access token, service-account key, or connection string.
- Keep raw transcript data only in the active one-call review context. Never persist it in commands, logs, reports, or the temporary ledger.
- Read credentials only from the execution environment or an approved secret provider. Never write them into this skill, source control, commands, logs, reports, or temporary ledgers.
- Require a dedicated database principal with `CONNECT`, schema `USAGE`, and `SELECT` only on the necessary evidence tables. Do not reuse an application, migration, owner, portal, or worker role.
- Run evidence queries inside `BEGIN TRANSACTION READ ONLY` and stop if `SHOW transaction_read_only` is not `on`.
- Treat unrestricted filesystem or shell access as execution capability, not database authorization.

## Required configuration

Require these values from the execution environment or approved secret provider:

```text
VOICE_OBSERVABILITY_CLOUD_SQL_INSTANCE
VOICE_OBSERVABILITY_DB_NAME
VOICE_OBSERVABILITY_DB_USER
VOICE_OBSERVABILITY_PRACTICE_ID
VOICE_OBSERVABILITY_TIMEZONE
VOICE_OBSERVABILITY_WINDOW_START
VOICE_OBSERVABILITY_WINDOW_END
```

For password authentication, also require `VOICE_OBSERVABILITY_PGPASSFILE`, pointing to a mode-`0600` PostgreSQL password file. Never put the password in a connection URL or command.

Do not start if the instance, database, tenant scope, timezone, frozen window, or read-only principal is unknown. Report the missing configuration without attempting alternate credentials.

## Local connection

Prefer the Cloud SQL Auth Proxy instead of a direct public database connection.

For an interactive local run:

1. Require `gcloud`, Cloud SQL Auth Proxy v2, and `psql`.
2. Ask the operator to complete `gcloud auth login` themselves if no active Google session exists. Never ask for their login details.
3. Start the proxy with the operator's existing Google credentials:

```bash
cloud-sql-proxy \
  --gcloud-auth \
  --address 127.0.0.1 \
  --port 6543 \
  "$VOICE_OBSERVABILITY_CLOUD_SQL_INSTANCE"
```

4. Connect through the local proxy with a dedicated read-only PostgreSQL user:

```bash
PGHOST=127.0.0.1 \
PGPORT=6543 \
PGDATABASE="$VOICE_OBSERVABILITY_DB_NAME" \
PGUSER="$VOICE_OBSERVABILITY_DB_USER" \
PGPASSFILE="$VOICE_OBSERVABILITY_PGPASSFILE" \
PGSSLMODE=disable \
psql -X --no-password -v ON_ERROR_STOP=1 \
  --set=practice_id="$VOICE_OBSERVABILITY_PRACTICE_ID" \
  --set=window_start="$VOICE_OBSERVABILITY_WINDOW_START" \
  --set=window_end="$VOICE_OBSERVABILITY_WINDOW_END"
```

## Unattended connection

Use a dedicated service account attached to the runtime; do not download a service-account key. Keep database and Gmail identities separate.

Before running, require an operator to:

1. Enable IAM database authentication on the Cloud SQL instance.
2. Add the service account as a Cloud SQL IAM database user.
3. Grant it `roles/cloudsql.client` and `roles/cloudsql.instanceUser`.
4. Grant its PostgreSQL user only `CONNECT`, schema `USAGE`, and the required `SELECT` privileges.

The identity that starts the proxy must be the identity that connects to PostgreSQL. Start the proxy with the attached service account's Application Default Credentials:

```bash
cloud-sql-proxy \
  --auto-iam-authn \
  --address 127.0.0.1 \
  --port 6543 \
  "$VOICE_OBSERVABILITY_CLOUD_SQL_INSTANCE"
```

For `service-name@project-id.iam.gserviceaccount.com`, set `VOICE_OBSERVABILITY_DB_USER` to `service-name@project-id.iam`. Connect without a password:

```bash
PGHOST=127.0.0.1 \
PGPORT=6543 \
PGDATABASE="$VOICE_OBSERVABILITY_DB_NAME" \
PGUSER="$VOICE_OBSERVABILITY_DB_USER" \
PGSSLMODE=disable \
psql -X --no-password -v ON_ERROR_STOP=1 \
  --set=practice_id="$VOICE_OBSERVABILITY_PRACTICE_ID" \
  --set=window_start="$VOICE_OBSERVABILITY_WINDOW_START" \
  --set=window_end="$VOICE_OBSERVABILITY_WINDOW_END"
```

## Verify access before reading calls

Open one `psql` session with error-stop enabled and verify the transaction:

```sql
BEGIN TRANSACTION READ ONLY;
SHOW transaction_read_only;
SELECT current_user;
```

Inspect the live schema before querying. Confirm the required columns and JSON paths, then verify that the current user can read but not modify the evidence table:

```sql
SELECT
    has_table_privilege(current_user, 'ai_interactions', 'SELECT') AS can_select,
    has_table_privilege(current_user, 'ai_interactions', 'INSERT')
        OR has_table_privilege(current_user, 'ai_interactions', 'UPDATE')
        OR has_table_privilege(current_user, 'ai_interactions', 'DELETE')
        OR has_table_privilege(current_user, 'ai_interactions', 'TRUNCATE') AS can_write;
```

Continue only when `can_select` is true and `can_write` is false. Treat missing evidence or access as an instrumentation gap. Do not broaden privileges to work around missing access.

## Acuity Product evidence adapter

When the current schema contains `ai_interactions`, use it as the call evidence source. Do not substitute a legacy call table merely because it is easier to access.

Use these fields:

- Stable citation: `id`, `source_call_id`, `started_at`, `ended_at`
- Lifecycle: `status`, `lifecycle_stage`
- Transcript: `transcript->'chat_history'->'items'`
- Tool calls and results: `closeout_payload->'toolExecutions'`
- Final scheduling evidence: `appointment_action`, `appointment_outcome`, `booking_result`, `cancellation_result`, `old_appointment_id`, `new_appointment_id`

First query only metadata for the frozen half-open window and explicit tenant scope. Do not emit every transcript or tool payload in one query:

```sql
SELECT
    id,
    source_call_id,
    started_at,
    ended_at,
    status,
    lifecycle_stage,
    appointment_action,
    appointment_outcome,
    jsonb_array_length(
        COALESCE(transcript->'chat_history'->'items', '[]'::jsonb)
    ) AS transcript_item_count,
    jsonb_array_length(
        COALESCE(closeout_payload->'toolExecutions', '[]'::jsonb)
    ) AS tool_execution_count
FROM ai_interactions
WHERE practice_id = :'practice_id'::uuid
  AND started_at >= :'window_start'::timestamptz
  AND started_at < :'window_end'::timestamptz
ORDER BY started_at, id;
```

Add `location_id` only when the requested scope requires it. Review every returned ID in order. For each ID, set `call_id`, fetch only that call's evidence, complete its ledger record, and release the raw evidence before fetching the next call:

```sql
SELECT
    id,
    source_call_id,
    started_at,
    ended_at,
    status,
    lifecycle_stage,
    transcript->'chat_history'->'items' AS transcript_items,
    closeout_payload->'toolExecutions' AS tool_executions,
    appointment_action,
    appointment_outcome,
    booking_result,
    cancellation_result,
    old_appointment_id,
    new_appointment_id
FROM ai_interactions
WHERE practice_id = :'practice_id'::uuid
  AND id = :'call_id'::uuid;
```

Never select phone numbers, patient identifiers, or receipt payloads unless a specific anomaly cannot be judged without them and the operator has explicitly authorized that access.

Commit the read-only transaction after the scoped read:

```sql
COMMIT;
```

If the proxy, authentication, PostgreSQL authorization, schema check, or query fails, preserve the exact non-secret error category as an instrumentation gap and stop. Never retry with broader credentials.
