# Call Capture Receiver Contract

`src/runtime/call-capture.ts` owns queueing, order, retry, request deadlines,
authentication, report reconciliation, and bounded finalization. Its runtime
interface is `start`, `record`, and `finish`.

## Current deployment gate

The current portal `/api/livekit/calls` receiver replaces one whole call row by
`callId`. It does not durably acknowledge individual conversation items, reject
stale sequences, or deduplicate tool outcomes. Sending progressive checkpoints
there would permit a late request to replace newer state.

Until the portal implements this contract:

- leave `CALL_CAPTURE_URL` unset;
- keep `ANALYTICS_URL` configured for compatible start and final writes;
- expect checkpoint results to remain explicitly pending in agent telemetry.

Setting `CALL_CAPTURE_URL` switches all start, checkpoint, and final envelopes
to the new receiver. It does not also send to `ANALYTICS_URL`. The agent fails
closed and sends no capture envelopes when the receiver bearer secret is absent.

## Request

The receiver accepts authenticated JSON envelopes:

```json
{
  "schemaVersion": 1,
  "type": "checkpoint",
  "callId": "call-id",
  "idempotencyKey": "call-id:item-id",
  "sequence": 2,
  "items": [
    {
      "id": "item-id",
      "role": "user",
      "text": "committed message text",
      "timestamp": 1721466010000,
      "interrupted": false,
      "transcriptConfidence": 0.94
    }
  ]
}
```

`type` is `start`, `checkpoint`, or `final`.

- Start includes `call` identity and LiveKit correlation metadata.
- A checkpoint contains exactly one `items` or `toolOutcomes` entry.
- Each conversation item uses `callId:itemId` as its idempotency key.
- A sanitized tool outcome contains the LiveKit tool-call ID in `callId`, its
  `createdAt` ISO timestamp, `toolName`, `outputClass`, `status`, and
  `idempotencyKey`. It uses `callId:tool:toolCallId` as the envelope and outcome
  idempotency key.
- Final includes every known item and tool outcome plus `finalState`.
- Only committed LiveKit `ChatMessage` items are sent. Interim speech
  recognition events are not capture inputs.
- The final LiveKit report is reduced to committed message items and usage
  metadata; raw function calls and function outputs are not forwarded.
- No media bytes or recording locations are sent.

## Receiver invariants

The receiver must:

1. Authenticate the bearer secret before parsing or storing the envelope.
2. Commit each item uniquely by `(callId, itemId)` and each tool outcome
   uniquely by `(callId, toolCallId)`.
3. Treat an identical idempotency key as a replay, returning the existing
   durable result without duplicating data.
4. Store the highest accepted `sequence` per call and prevent a lower sequence
   from replacing newer call state.
5. Merge checkpoint and final entities transactionally. A final envelope may
   reconcile entities already accepted by checkpoints.
6. Return success only after the entities and sequence are durably committed.
7. Accept duplicate and out-of-order delivery without losing newer data.

The agent retries transport failures, timeouts, `408`, `429`, and `5xx`
responses in sequence. Other HTTP responses and incomplete acknowledgments
remain pending without blocking later checkpoints.

## Acknowledgment

Every successful response is JSON:

```json
{
  "ok": true,
  "callId": "call-id",
  "idempotencyKey": "call-id:item-id",
  "sequence": 2,
  "recordedItemIds": ["item-id"],
  "recordedToolCallIds": []
}
```

The arrays must include every item or tool-call ID in the request, including
entities that were already present. A bare `2xx` is not an acknowledgment; the
agent keeps an incomplete response pending and advances the checkpoint queue.
