# LiveKit-Native Tools Cleanup Spec

Status: cleanup complete for the custom flow harness. The live path is direct
LiveKit tools plus typed `session.userData`.

Last verified against LiveKit docs: 2026-05-29

## Current Runtime

```txt
AgentSession<CallState>
  -> pre-call phone lookup
  -> session.userData as the call state
  -> llm.tool definitions
  -> tool handlers enforce prerequisites and write state
  -> Agent.onUserTurnCompleted records latest transcript for observability
```

Current live code should not contain:

- `src/flow/**`
- planner command packets
- reducer events
- `record_turn_understanding`
- planner-owned `allowedTools`
- flow-harness activation flags
- historical flow replay scripts

## LiveKit Basis

- Model-callable tools should be focused `llm.tool()` definitions with clear
  descriptions, schemas, and `execute` handlers.
  Source: https://docs.livekit.io/agents/logic/tools/definition/
- Keep each tool's description, schema, and execute handler together. Shared
  helper files are allowed only when they remove real duplication or keep
  backend-only details out of the model-facing definition.
- Keep the model-facing tool set small because the model chooses from that list
  on every turn.
  Source: https://docs.livekit.io/agents/logic/tools/design/#focus-the-toolset
- Put correctness in code with tool prerequisites and actionable errors.
  Source: https://docs.livekit.io/agents/logic/tools/design/#control-the-loop-from-code
- Use typed session state through `userData` / `userdata` and access it from
  tools through the run context.
  Source: https://docs.livekit.io/agents/logic/agents-handoffs/#passing-state
- Use `onUserTurnCompleted` only for backend bookkeeping when possible; avoid
  recurring model-context injection unless a tool result cannot carry the
  needed information.
  Source: https://docs.livekit.io/agents/logic/nodes/#on-user-turn-completed

## Keep

- `session.userData` as the single runtime state container.
- Pre-call lookup hydration into the same patient state used by tools.
- Private backend handles for patient IDs, cancel tokens, and booking tokens.
- Compact availability and appointment state for model-safe tool responses.
- Transfer locks for SIP handoff.
- Focused tests around state mutation, tool guards, prompts, and routing.

## Acceptance

- Runtime code has no custom flow harness imports or state fields.
- Root docs and package scripts do not reference deleted harness paths.
- `pnpm run typecheck` and `pnpm test` pass.
- Strict unused TypeScript check passes with
  `pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters`.
