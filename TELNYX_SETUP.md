# Telnyx SIP Trunk Setup for LiveKit Cloud

## Prerequisites

- Telnyx account with a purchased phone number
- Telnyx API V2 key
- LiveKit Cloud project with an inbound trunk and dispatch rule

## Step 1: Get your LiveKit SIP endpoint

Your SIP endpoint uses the **project ID**, not the project name.

```
{project_id_without_p_}.us.sip.livekit.cloud
```

Find your project ID:

```sh
lk project list
```

If your project ID is `p_3ix7gzvuwmc`, your SIP endpoint is `3ix7gzvuwmc.us.sip.livekit.cloud`.

> The project name subdomain (e.g. `abitatest-aqvfuhdr`) works for WebSocket but NOT for SIP. Always use the project ID.

## Step 2: Create LiveKit inbound trunk

Create `inbound-trunk.json`:

```json
{
  "trunk": {
    "name": "Telnyx inbound",
    "numbers": ["+1XXXXXXXXXX"],
    "krispEnabled": true
  }
}
```

```sh
lk sip inbound create inbound-trunk.json
```

## Step 3: Create LiveKit dispatch rule

Create `dispatch-rule.json`:

```json
{
  "dispatch_rule": {
    "rule": {
      "dispatchRuleIndividual": {
        "roomPrefix": "call-"
      }
    },
    "name": "telnyx-inbound",
    "trunk_ids": ["ST_YOUR_TRUNK_ID"],
    "roomConfig": {
      "agents": [{
        "agentName": "your-agent-name"
      }]
    }
  }
}
```

```sh
lk sip dispatch create dispatch-rule.json
```

## Step 4: Create Telnyx FQDN connection

```sh
export TELNYX_API_KEY="your_api_key"

curl -L 'https://api.telnyx.com/v2/fqdn_connections' \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H "Authorization: Bearer $TELNYX_API_KEY" \
-d '{
  "active": true,
  "anchorsite_override": "Chicago, IL",
  "connection_name": "LiveKit SIP Trunk",
  "inbound": {
    "ani_number_format": "+E.164",
    "dnis_number_format": "+e164",
    "sip_region": "US"
  },
  "transport_protocol": "TCP"
}'
```

Save the `connection_id` from the response.

> Setting `sip_region` to `"US"` and anchoring to `"Chicago, IL"` prevents Telnyx from routing through EU servers, which causes 404 errors on LiveKit.

## Step 5: Create FQDN record

```sh
curl -L 'https://api.telnyx.com/v2/fqdns' \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H "Authorization: Bearer $TELNYX_API_KEY" \
-d '{
  "connection_id": "<connection_id>",
  "fqdn": "<project_id>.us.sip.livekit.cloud",
  "port": 5060,
  "dns_record_type": "a"
}'
```

## Step 6: Assign phone number to the connection

Get the phone number ID:

```sh
curl -L -g 'https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=XXXXXXXXXX' \
-H 'Accept: application/json' \
-H "Authorization: Bearer $TELNYX_API_KEY"
```

Assign it:

```sh
curl -L -X PATCH 'https://api.telnyx.com/v2/phone_numbers/<phone_number_id>' \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H "Authorization: Bearer $TELNYX_API_KEY" \
-d '{
  "connection_id": "<connection_id>"
}'
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| 404 No trunk found | SIP subdomain uses project name instead of project ID | Use `{project_id}.us.sip.livekit.cloud` |
| 404 No trunk found | Telnyx routing through EU servers | Set `sip_region: "US"` and `anchorsite_override: "Chicago, IL"` |
| 404 No trunk found | Phone number not assigned to FQDN connection | PATCH phone number with `connection_id` |
| 404 No trunk found | Number format mismatch | Ensure `dnis_number_format` is `+e164` (with leading +) |
| No calls reaching LiveKit | Wrong connection type | Must use FQDN connection, not credential or IP connection |
