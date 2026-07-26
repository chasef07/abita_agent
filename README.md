# Abita Voice Agent

Production LiveKit Voice Agent for Abita Eye Group, Eye Radiance, and supported
practice lines. It answers SIP calls, identifies callers, handles scheduling and
insurance workflows, answers office questions, captures staff tasks, and
transfers callers when software should stop.

Runtime code is the source of truth. Product and engineering work is tracked in
[GitHub Issues](https://github.com/chasef07/abita_agent/issues).

> **Draft dependency:** this README describes the target layout after scheduling
> PR #254 and identity PR #256 land. Until then, follow the paths in the checked
> out runtime. Do not merge this documentation change before both dependencies.

## Runtime

```text
SIP caller
  -> LiveKit dispatches the worker
  -> office profile selects policy, prompts, tools, and handoff behavior
  -> pre-call bootstrap loads available caller context
  -> session.userData holds the authoritative CallState
  -> the Voice Agent invokes model-facing tools
  -> owned middleware performs backend reads and writes
  -> call closeout sends sanitized evidence and releases the room
```

The runtime preserves these invariants:

- `session.userData` is the single call-state container.
- A state-changing action succeeds only after its tool and middleware operation
  succeed.
- Patient IDs, booking tokens, provider payloads, and other private backend
  facts stay outside model-visible text.
- Identity promotion invalidates state belonging to the previous patient.
- Rescheduling books the replacement before cancelling the old appointment.
- Office policy comes from the active office profile, not scattered tool
  conditionals.
- Middleware owns backend availability, booking, cancellation, patient lookup,
  and insurance contract details.

## Target Repository Map

| Path | Ownership |
| --- | --- |
| `src/main.ts` | LiveKit job composition and session startup |
| `src/agent.ts` | Voice Agent construction and turn hooks |
| `src/customers/abita/profile.ts` | Office policy, prompts, routing, speech, scheduling capability, and handoff behavior |
| `src/identity/promotion.ts` | Identity confirmation, activation, switching, reset, and registration gates |
| `src/scheduling/` | Availability, booking, cancellation, rescheduling, replay protection, and speech-ready outcomes |
| `src/clients/owned-middleware.ts` | Semantic middleware interface with production and in-memory adapters |
| `src/runtime/` | Pre-call bootstrap, speech profiles, deadlines, shutdown, and call closeout |
| `src/state/` | `CallState` composition and state owned outside the deeper workflow modules |
| `src/tools/` | Remaining model-facing tool definitions and narrow runtime adapters |
| `src/__tests__/` | Interface-level behavior and dependency-contract tests |
| `workspace/` | Runtime role, voice, office policy, knowledge, and insurance sources |

## Agent Reading Order

1. Read [`AGENTS.md`](AGENTS.md) for repository rules.
2. Read [`CONTEXT.md`](CONTEXT.md) for domain language.
3. Find the owning module in the map above.
4. Read that module's interface, callers, dependency adapter, and adjacent
   interface-level tests.
5. Read office profile and `workspace/` sources only when the behavior is
   customer- or office-specific.
6. Use [`docs/ops/`](docs/ops/) only for provider setup or operational work.

Do not reconstruct current behavior from old design prose. Read runtime code,
tests, current GitHub issues, and provider evidence.

## Local Development

Requirements:

- Node 22
- pnpm 10.34.3

```bash
corepack enable
corepack prepare pnpm@10.34.3 --activate
pnpm install --frozen-lockfile
```

Checks:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

The runtime does not automatically load `.env` files. LiveKit Cloud supplies
production worker variables. For local runs, export the required values before
starting the worker:

```bash
pnpm dev
```

See [`.env.example`](.env.example) for the supported variables. The main groups
are LiveKit and LiveKit Inference, AssemblyAI, Rime, owned middleware, portal
delivery, call-center handoff, and prompt workspace configuration.
`LIVEKIT_FORWARD_SYNC_SECRET` is the preferred portal-delivery secret;
`WEBHOOK_SECRET` remains a legacy fallback.

Real call testing requires LiveKit Cloud credentials and a configured SIP
trunk. See [`docs/ops/telnyx-setup.md`](docs/ops/telnyx-setup.md).

## Documentation

[`docs/README.md`](docs/README.md) maps the small set of retained agent,
operations, and sanitized history documents. Architecture decisions and feature
specifications belong in GitHub Issues so implementation status and discussion
stay together.
