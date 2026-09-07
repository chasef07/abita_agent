# Agent simulations

Edit `scenarios.yaml`, then run the normal agent through LiveKit:

```sh
pnpm build
NODE_ENV=development lk agent simulate --scenarios evals/scenarios.yaml --concurrency 1 dist/main.js
```

Prerequisites: Node 22, pnpm 10.34.3, installed project dependencies, and an
authenticated LiveKit CLI. Supply `SANDBOX_AMD_API_URL` and
`SANDBOX_AMD_API_TOKEN` securely in the local process environment. Never put
credentials in YAML or GitHub files. Leave `LIVEKIT_AGENT_DEPLOYMENT` unset for
the CLI's temporary local worker.

- `instructions`: the simulated caller's identity and goal.
- `agent_expectations`: the conversation rubric.
- `userdata.office`: selects the existing office/trunk profile, not a SIP call.
- `userdata.patient`: restricts backend reads to the synthetic test patient;
  it does not pre-verify them or reveal their identity to the receptionist.
  Keep these values consistent with the caller instructions.

`main.ts` detects LiveKit's simulation context and delegates test setup and
safety checks to `src/runtime/simulation.ts`. The helper reuses the real agent
prompt, model and tools with dev middleware; it is not a separate entrypoint. Simulation startup skips
SIP, phone-based pre-call lookup, Product ingestion and speech services.
Normal calls keep the existing startup path. There is no custom CLI runner.

This first version supports **read-only text availability scenarios**. Booking,
registration, insurance changes, cancellation, transfers and messages are
blocked. LiveKit judges the conversation; the agent also checks verified
patient lookup and returned inventory. Inspect the exported tool history to
confirm the spoken offers match inventory. A timeout/backend error is not a
clean behavioral regression result. Each session is limited to four minutes;
run one scenario at a time initially. LiveKit/provider charges still apply.

Use synthetic sandbox records only. The sandbox clock and inventory are live;
this is an integration smoke test, not a fixed-date reproducibility benchmark.
The YAML does not provision its patient or insurance. This setup does not
enable CI or deploy the agent. Automatic writes remain blocked.
