# Documentation Map

Start here when you need context beyond the runtime code.

## Current Architecture

- `architecture/livekit-native-dynamic-tools-cleanup-spec.md` — current runtime shape: LiveKit agent, tools, session state, prompts, and optional native dynamic tool updates.
- `architecture/reschedule-appointment-tool-spec.md` — deterministic reschedule tool design: one model-callable tool that books the new slot, cancels the old appointment, and preserves New Patient status.
- `architecture/inline-scheduling-lane-spec.md` — current scheduling-lane contract: lane is passed to availability and chart-creation tools instead of using a standalone context-recording tool.

## Operations

- `ops/assemblyai.md` — active AssemblyAI STT setup notes.
- `ops/telnyx-setup.md` — SIP trunk setup and call testing notes.

## History

These are retained for audit/debug context, not first-pass implementation context.
They should not be used as current runtime guidance.

- `history/incident-2026-04-09-concurrent-dispatch.md`

Runtime prompt and customer knowledge files stay in `../workspace/`.
