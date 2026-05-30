# LiveKit Voice Agent

Production phone agent for Abita Eye Group and Eye Radiance. LiveKit Cloud
dispatches the `abita-agent` worker for supported SIP trunks; the worker handles
identity, scheduling, appointment changes, insurance, office FAQ, and human
transfer through the AdvancedMD middleware.

## Current Shape

The runtime is intentionally small:

```txt
LiveKit AgentSession<CallState>
  -> pre-call phone lookup
  -> session.userData as typed call state
  -> llm.tool definitions
  -> tool handlers read/write state and call middleware
  -> Agent.onUserTurnCompleted injects a compact <call_state> message
```

There is no custom flow harness, planner, reducer, `record_turn_understanding`
tool, or historical replay path in the live code.

## Stack

| Layer | Provider | Runtime path |
| --- | --- | --- |
| Telephony | Twilio + Telnyx SIP into LiveKit Cloud | inbound SIP room dispatch |
| Agent runtime | `@livekit/agents` on Node 22 | `src/main.ts` |
| STT | AssemblyAI plugin | `src/stt-config.ts` |
| LLM | Baseten with fallback adapter | `src/model-config.ts` |
| TTS | Cartesia plugin | `src/tts-config.ts` |
| VAD/turns | Silero + LiveKit turn handling | `src/session-options.ts` |
| Backend | AdvancedMD middleware | `src/clients/advancedmd-client.ts` |
| Analytics | webhook payload on shutdown | `src/main.ts`, `src/call-observability.ts` |

## Runtime Flow

1. `src/main.ts` connects to the LiveKit room and waits for the SIP caller.
2. `loadPreCallBootstrap()` resolves the office and runs phone lookup.
3. `session.userData` is initialized with `createCanonicalCallState()`.
4. `Agent` starts with office-appropriate tools from `buildToolsForTrunk()`.
5. Tools in `src/tools/*.ts` mutate `CallState`, enforce prerequisites, and
   call AdvancedMD middleware.
6. `onUserTurnCompleted()` records the latest caller transcript and injects a
   compact `<call_state>` block before the next LLM response.
7. Shutdown posts analytics and deletes the LiveKit room.

## Repo Layout

```txt
src/
  main.ts                 LiveKit worker/session setup and analytics shutdown
  agent.ts                Agent class, greeting, STT hook, call-state injection
  prompt.ts               Static prompt assembly plus pre-call context
  state/
    call-state.ts         Typed session state and state selectors
  clients/
    advancedmd-client.ts  Middleware client and response normalization
  runtime/
    precall-bootstrap.ts  Pre-call phone lookup hydration
    tool-registry.ts      Office-specific LiveKit tool registry
  tools/
    add-patient.ts        add_patient definition, schema, execute body
    book-appt.ts          book_appt definition, schema, execute body
    cancel-appt.ts        cancel_appt definition, schema, execute body
    check-insurance.ts    check_insurance definition, schema, execute body
    get-availability.ts   get_availability definition, schema, execute body
    verify-patient.ts     verify_patient definition, schema, execute body
    session.ts            LiveKit RunContext state access and write interruption guard
    scheduling.ts         Office routing and availability routing helpers
    patient-state.ts      Patient lookup and patient-state mutation helpers
    availability-slots.ts Availability slot cache and model-safe responses
    appointment-state.ts  Appointment/cancel-token helpers
    handoff.ts            SIP transfer helper
    knowledge.ts          Office knowledge lookup
  customers/abita/        Office registry, trunk routing, greetings, handoffs
  __tests__/              Vitest coverage for runtime behavior

workspace/                Runtime prompt and office data files
docs/                     Current architecture, ops, and historical notes
```

## Model-Facing Tools

The current broad office tool set is:

- `verify_patient`
- `add_patient`
- `update_insurance`
- `get_availability`
- `cancel_appt`
- `book_appt`
- `check_insurance`
- `lookup_knowledge`
- `route_to_spring_hill` for Crystal River trunks only
- `transfer_call`

State-changing tools read and write `session.userData` directly. The final side
effect is not considered complete until the tool succeeds.

## Local Development

Use Node 22.

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Useful checks:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Real call testing requires LiveKit Cloud credentials and a configured SIP trunk.
See `docs/ops/telnyx-setup.md`.

## Environment

Important variables:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `BASETEN_API_KEY`
- `ASSEMBLYAI_API_KEY`
- `CARTESIA_API_KEY`
- `AMD_API_URL`
- `AMD_API_TOKEN`
- `ANALYTICS_URL`
- `WEBHOOK_SECRET`
- optional handoff overrides: `SPRING_HILL_HANDOFF_TARGET`,
  `TELNYX_VOICE_API_HANDOFF_TARGET`, `HOLLYWOOD_HANDOFF_TARGET`,
  `SWEETWATER_HANDOFF_TARGET`
- `PROMPT_WORKSPACE`, defaulting to `workspace`

## Docs

Start with `docs/README.md`. Runtime code in `src/` remains the source of
truth when docs and implementation disagree.
