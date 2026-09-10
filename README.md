# Abita Voice Agent

TypeScript LiveKit voice receptionist. One worker job owns one call; owned
middleware handles patient and scheduling operations.

Product vision and principles: [AGENTS.md](AGENTS.md).
Work tracking: [GitHub Issues](https://github.com/chasef07/abita_agent/issues).

## Development

Use Node 22 and pnpm 10.34.3.

```sh
corepack enable
corepack prepare pnpm@10.34.3 --activate
pnpm install --frozen-lockfile
```

Use [.env.example](.env.example) for configuration. Export variables from a secure
local source before starting; the worker does not automatically load env files.
Connected calls require LiveKit credentials, a SIP trunk, speech-provider
credentials, and reachable middleware and Product services.

```sh
pnpm dev
```

Checks:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

## Source entry points

- [src/main.ts](src/main.ts): job composition and lifecycle.
- [src/agent.ts](src/agent.ts): conversation and turn hooks.
- [src/customers/abita/profile.ts](src/customers/abita/profile.ts): Office Profiles.
- [src/state/](src/state/): Call State.
- [src/identity/](src/identity/): patient resolution and promotion.
- [src/scheduling/](src/scheduling/): appointment workflows.
- [src/clients/](src/clients/): middleware and service adapters.
- [src/runtime/](src/runtime/): startup, speech, and closeout.
- [src/tools/](src/tools/): model-facing tools.
- [Tests](src/__tests__/): behavior and contract tests.
- [workspace/](workspace/): live prompts and office knowledge.

Read the owning module, its callers, and tests for current behavior.

## Supporting workflows

- [Simulations](evals/README.md): text scenarios with sandbox effects.
- [Packaged greetings](assets/greetings/README.md): generate and verify audio assets.
- [CI](.github/workflows/ci.yml) and [verification](.github/workflows/verify.yml).
- [Release and deployment](.github/workflows/release.yml).
- [Prompt snapshots](.github/workflows/prompt-release.yml).
- [Release history](CHANGELOG.md).
