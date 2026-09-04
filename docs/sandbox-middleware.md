# Sandbox middleware routing

## Contract

One agent codebase; two middleware services. Production real-office calls keep
their existing middleware and Product destinations. All three demo Office
Profiles and every named LiveKit deployment use the sandbox middleware.

| Call | Middleware | Product interactions | Staff tasks / transfers |
| --- | --- | --- | --- |
| Production, real office | Existing production | Existing real Practice | Existing behavior |
| Production, demo office | Sandbox | Existing Acuity Demo Practice | Blocked |
| Named deployment, any office | Sandbox | Skipped, never reported as delivered | Blocked |

Blocked tools explicitly report that no transfer/message happened. They create
no success receipt and must not promise staff follow-up. No outbound SMS tool
exists in this agent. Middleware and EMR notification settings must be verified
separately before enabling sandbox mutations.

## Configuration and rollout

LiveKit activation is intentionally pending. This PR does not change live
agent secrets, deploy either agent deployment, or restart production.

1. Deploy the same middleware code as a separate service with `AMD_ENV=dev`,
   sandbox EMR credentials, and distinct API and booking-token signing secrets.
   EMR credentials stay in middleware, not in this agent.
2. Verify synthetic-patient lookup and availability on that service. No booking
   is required for this setup gate.
3. Add `SANDBOX_AMD_API_URL` and `SANDBOX_AMD_API_TOKEN` to the agent's secrets.
   LiveKit shares secrets across deployments; do not replace `AMD_API_URL` or
   `AMD_API_TOKEN`. Sandbox configuration is mandatory for sandbox calls and
   must use HTTPS, a distinct service origin, and a distinct API token.
4. After review, deploy this image to `staging`. Missing configuration prevents
   startup rather than falling back to production. Dispatch explicitly with
   `deployment=staging` and the existing SIP office context.
5. After merge/release approval, deploy to production to switch existing demo
   callers. A staging deployment alone does not change production demo routing.
   Do not disable the sandbox service while demo callers depend on it.

The initial sandbox transport pins requests to middleware's `spring_hill`
selector, the configured development office. This intentionally shares sandbox
inventory across demo specialties; it does not claim independent EMR specialty
workflows. Routine-vision and other unmapped visit types remain unsupported by
the sandbox until middleware mappings are verified. Token-bound booking and
cancellation requests continue to omit an office override: signed middleware
tokens own their target. Use synthetic identities only.

This change does not create a browser/simulation entrypoint: ordinary calls
still require a supported SIP trunk. It does not run the five booking scenarios
or create test appointments.

## Dependency evidence

[LiveKit staging deployments](https://livekit.com/blog/staging-deployments-for-livekit-agents)
documents shared secrets, empty `LIVEKIT_AGENT_DEPLOYMENT` for production, and
the Node SDK minimum of 1.7.1. This repository pins 1.7.1; its worker registers
the deployment from that environment variable. Any nonempty deployment name
is isolated, so a future preview deployment cannot fall through to production.
