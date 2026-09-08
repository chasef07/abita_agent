# Agent simulations

All six cases are in `scenarios.yaml`: availability, existing-patient booking,
new-patient registration + booking, reschedule, cancel, and insurance acceptance.

```sh
pnpm build
NODE_ENV=development lk agent simulate --scenarios evals/scenarios.yaml --concurrency 1 dist/main.js
```

This runs **every case**, including real sandbox writes. Comment out cases you
do not want to run. No extra opt-in flag, custom runner or booking helper.

## How it works

- `instructions`: fictional caller facts and behavior.
- `agent_expectations`: LiveKit's semantic rubric.
- `userdata.office`: selects the office profile; every simulation uses dev middleware.

Patient facts appear only in caller instructions; the agent learns them in the
conversation. `src/runtime/simulation.ts` connects the text session, office and
dev middleware to the real agent. All EMR tools retain their normal validation
and behavior. Transfers and staff tasks are excluded because they reach other
systems. SIP, speech services and Product ingestion are not exercised.

LiveKit grades the conversation and tool results. There are no custom read-only
guards, preflight checks, retry locks or backend verifier. Even the
availability/insurance cases have normal tools: their no-write requirement is
in the rubric, not enforced by an extra wrapper. A judge pass is not independent
proof of saved EMR state.

## Fixture preparation

The names below are fictional scenario data, **not newly provisioned records**.

| Case | Preparation before running |
| --- | --- |
| Availability / existing booking | Avery Codextest, DOB 03/12/1990: existing insured chart. Review existing appointments before the booking case. |
| New patient | Morgan Cedartest, DOB 06/14/1992: the first trial created a partial chart. Change the fictional name and member number before another new-patient run. |
| Reschedule | Riley Mapletest, DOB 05/16/1988: existing insured chart with one upcoming medical appointment and another available morning within two weeks. |
| Cancel | Jordan Birchtest, DOB 11/04/1985: separate chart with one upcoming appointment. |
| Insurance | No patient fixture required; tests office participation, not individual eligibility. |

New-patient fields are fictional; Aetna is a real carrier. Confirm the dev
middleware maps Aetna to a valid sandbox carrier before treating registration
results as agent failures. Office acceptance alone does not prove insurance
attachment works. This change does not fix carrier mapping.

Reschedule and cancel use separate fixtures; neither relies on another scenario
running first. No automatic setup or cleanup. Reruns can change sandbox state;
timeouts can still leave saved appointments. Inspect tool results and sandbox
records when investigating failures.

## Prerequisites

Node 22, pnpm 10.34.3, installed dependencies, authenticated LiveKit CLI and the
agent's model credentials. Supply `SANDBOX_AMD_API_URL` and
`SANDBOX_AMD_API_TOKEN` through the environment, never YAML. Leave
`LIVEKIT_AGENT_DEPLOYMENT` unset for the CLI's local worker.
Each session has a four-minute timeout; LiveKit/model charges apply.
One local new-patient trial created a partial chart without insurance and booked
nothing. It also exposed an incorrect callback number and an unsupported
follow-up promise. Insurance integration and agent behavior fixes are deferred;
the other five cases have not been run with this setup. No CI or deployment.
