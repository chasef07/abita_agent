# Changelog

Notable runtime, dependency, and operational changes for the Abita LiveKit
voice agent.

## 2026-07-02

### Added

- Added LiveKit's native `end_call` tool for caller-ended conversations; room
  deletion remains owned by the session-close path.
- Added async availability lookup behavior using `ctx.update()`, `ctx.filler()`,
  and middleware abort signals.

### Changed

- Upgraded the LiveKit Agents JS package family from `1.4.11` to `1.5.0`.
- Switched tools to direct `tool()` imports with explicit names and flat tool
  arrays.
- Replaced the custom `Agent` subclass with `Agent.create()`.
- Replaced direct interruption flag mutation in write and transfer tools with
  `ctx.disallowInterruptions()`.
- Updated architecture docs and README wording for LiveKit 1.5 direct imports.

### Removed

- Removed the local AssemblyAI plugin patch because upstream now includes the
  needed `universal-3-5-pro`, `inactivityTimeout`, and language confidence
  behavior.
- Removed the hand-rolled availability status reply timer in favor of LiveKit's
  native async tool progress/filler APIs.
- Removed stale LiveKit `1.4.11` patch entries and patch files.

### Kept

- Kept a re-keyed Rime `1.5.0` patch because the app still depends on the
  documented `language` websocket query parameter for Coda voices.
