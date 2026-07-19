# LiveKit Voice Agent
 
Production phone agent for Abita Eye Group and Eye Radiance. LiveKit Cloud
dispatches the `abita-agent` worker for supported SIP trunks; the worker handles
identity, scheduling, appointment changes, insurance, office FAQ, and human
transfer through the AdvancedMD middleware.

See [CHANGELOG.md](CHANGELOG.md) for dated runtime and dependency changes.

## Current Shape

The runtime is intentionally small:

```txt
LiveKit AgentSession<CallState>
  -> pre-call phone lookup
  -> session.userData as typed call state
  -> direct tool() definitions
  -> business tools record scheduling lane when needed
  -> get_current_datetime returns clinic-local time on demand
  -> business tools read/write state and call middleware
```

There is no custom flow harness, planner, reducer, `record_turn_understanding`
tool, standalone context-recording tool, or historical replay path in the live
code.

## Stack

| Layer | Provider | Runtime path |
| --- | --- | --- |
| Telephony | Twilio + Telnyx SIP into LiveKit Cloud | inbound SIP room dispatch |
| Agent runtime | `@livekit/agents` on Node 22 | `src/main.ts` |
| STT | AssemblyAI plugin | `src/stt-config.ts` |
| LLM | Baseten with fallback adapter | `src/model-config.ts` |
| TTS | Rime plugin | `src/tts-config.ts` |
| VAD/turns | Silero + LiveKit turn handling | `src/session-options.ts` |
| Backend | AdvancedMD middleware | `src/clients/advancedmd-client.ts` |
| Analytics | webhook payload on shutdown | `src/main.ts`, `src/call-observability.ts` |

## Runtime Flow

1. `src/main.ts` connects to the LiveKit room and waits for the SIP caller.
2. `loadPreCallBootstrap()` resolves the office and runs phone lookup.
3. `session.userData` is initialized with `createCanonicalCallState()`.
4. `Agent` starts with office-appropriate tools from `buildToolsForTrunk()`.
5. Tools enforce prerequisites, delegate state transitions, and call AdvancedMD
   middleware.
6. `onUserTurnCompleted()` records the latest caller transcript for backend
   observability without injecting backend state into the model context.
7. Shutdown posts analytics and deletes the LiveKit room.

## Backend Tool Handlers

The current broad office tool set is:

- `get_current_datetime`
- `resolve_patient`
- `add_patient`
- `update_insurance`
- `get_availability`
- `cancel_appointment`
- `reschedule_appointment`
- `book_appointment`
- `check_insurance`
- `lookup_knowledge`
- `transfer_call`

For new scheduling, `get_availability` takes `appointmentLane` directly once the
medical-versus-routine lane is clear. `add_patient` takes the same lane because
chart creation needs the same medical-versus-routine guard. `book_appointment`
does not repeat the lane; it uses the private booking token and routing cached
from the caller-confirmed availability slot. The final side effect is not
considered complete until the tool succeeds.

`get_current_datetime` is read-only and returns clinic-local grounding, such as
`Today is Sunday, May 31st, 2026 at 10:42 AM Eastern time.`, when the caller
uses relative date or time language for scheduling, availability, booking, or
appointment changes. If the caller gives a supported phrase such as
`next Wednesday`, the tool also returns a natural-language interpretation with
the exact `YYYY-MM-DD` date for availability lookup.

Pre-call phone lookup data stays in backend state and can be promoted from
caller-provided first-name evidence. `resolve_patient` handles preloaded
first-name matches, patient switching, backend lookup by first name, last name,
and date of birth, and explicit new-chart state marking before `add_patient`.

## Local Development

Use Node 22 and pnpm 10.

```bash
corepack enable
corepack prepare pnpm@10.34.3 --activate
pnpm install --frozen-lockfile
```

Useful checks:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

The runtime does not auto-load `.env`, `.env.local`, or other env files. LiveKit
Cloud supplies production worker environment variables. If you run the worker
manually, provide the required variables through the process environment.

Real call testing requires LiveKit Cloud credentials and a configured SIP trunk.
See `docs/ops/telnyx-setup.md`.

## Environment

Important variables:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `BASETEN_API_KEY`
- `ASSEMBLYAI_API_KEY`
- `RIME_API_KEY`
- `AMD_API_URL`
- `AMD_API_TOKEN`
- `ANALYTICS_URL`
- `WEBHOOK_SECRET`
- direct Acuity call-center handoff: `ACUITY_HANDOFF_URL` and
  `ACUITY_HANDOFF_SECRET`; both are required for call-center offices and the
  URL must use HTTPS
- optional demo phone handoff override: `DEV_HANDOFF_TARGET`
- `PROMPT_WORKSPACE`, defaulting to `workspace`

## Docs

Start with `docs/README.md`. Runtime code in `src/` remains the source of
truth when docs and implementation disagree.
