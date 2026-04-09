# Incident: Missed Inbound Call — Concurrent Dispatch Bug

**Date:** 2026-04-09 09:31 AM EDT (13:31 UTC)
**Severity:** High — silent missed calls, no error surfaced
**Fix commit:** `1bb8c8a`
**Upstream fix:** [livekit/agents-js#1214](https://github.com/livekit/agents-js/pull/1214)

## What happened

Caller `+19789675279` dialed in. The room was created, the caller joined, and then sat in silence for 60 seconds before hanging up. The agent never arrived during the call.

The agent dispatched at **09:32:55 — 39 seconds after the caller had already left** (`CLIENT_INITIATED` disconnect). It joined an empty room and stayed there until `ROOM_CLOSED` at 09:36:16.

From LiveKit's event log for room `RM_a4ZmN5oe4PKq`:

| Time (EDT) | Event |
|---|---|
| 09:31:16 | Room created, caller `sip_+19789675279` joins |
| 09:32:16 | Caller leaves (CLIENT_INITIATED) — hung up after 60s |
| 09:32:55 | Agent `AJ_nAmMRTLR7NFi` joins (empty room) |
| 09:36:16 | Agent leaves (ROOM_CLOSED) |
| 09:36:37 | Room ended |

## Root cause

`@livekit/agents@1.2.3` had a concurrency bug in `ProcPool` (`agents/src/ipc/proc_pool.ts`).

The pool holds `initMutex` while warming a child process. In 1.2.3, that mutex was released in the outer `finally` block — **after** `await proc.join()`. Because child job procs are strictly one-shot (`JobProcExecutor.launchJob` throws on a second job; the child calls `process.exit(0)` after one job), `proc.join()` blocks until the child exits, which only happens when the active call ends.

The effect: `initMutex` was held for the entire lifetime of every running job. Since warming a replacement proc also requires `initMutex`, **no new proc could initialize until the current call finished**. The pool was effectively serialized to **1 concurrent call per replica**, regardless of `numIdleProcesses` (default `3` in production).

The fix releases `initMutex` immediately after `warmedProcQueue.put()` succeeds, before `await proc.join()`. See livekit/agents-js#1214.

## Timeline of the incident call

- **09:30:49** — Call 1 (`+18137862344`) arrives. Worker has a warmed proc. Agent joins in 1s.
- **09:30:49 onwards** — Call 1 running. `initMutex` held by the owning `procWatchTask`. No replacement proc can initialize.
- **09:31:16** — Call 2 (`+19789675279`) arrives. `warmedProcQueue` is empty. Cloud cannot dispatch to the worker. Call 2 sits silent in the dispatch queue.
- **09:32:16** — Caller 2 hangs up after 60s of silence.
- **09:32:53** — Call 1 ends, child proc exits, `initMutex` released.
- **09:32:55** — New proc initialized, Call 2 dispatched (~2s matches the worker's 2.5s `UPDATE_LOAD_INTERVAL` for load reports to Cloud).
- **09:36:16** — Empty-room timeout closes the room.

## Why it appeared intermittent

This bug affected **every** call that overlapped with another on the same replica — but the visible failure mode depended on the second caller's patience relative to how long the first call ran.

- **Short overlap + patient caller** → agent joins 10–30s late, call "works" but caller experienced dead air at the start
- **Long overlap or impatient caller** → caller hangs up before dispatch, missed call, `ROOM_CLOSED` with no session

This is why the logs initially looked like concurrency worked. For example, on 2026-04-09 around 11:02 EDT:

- 11:01:57 — Call A `received job request`
- 11:02:46 — Call B `received job request` (49s later)
- 11:03:19 — Call A session report uploaded (proc A exits)
- ~11:03:2X — Call B's proc finally initializes and picks up the call
- 11:04:40 — Call B session report uploaded

Call B's caller silently waited ~30 seconds listening to nothing before the agent spoke. They were patient enough not to hang up, so it recorded as a completed call. The 09:31 caller wasn't. **Every overlapping call was degraded; only some were visible as missed calls.**

### Contributing factors

- **Single replica** (`Replicas: 1 / 1 / 8`). With min=1, every restart or overlap hit the same pod. Cloud autoscaling is too slow (~1–2 min pod cold start) to rescue a call that's already ringing.
- **Package was out of date by 4 hours.** `@livekit/agents@1.2.4` (containing the fix) was published at 2026-04-08 21:47 UTC. Our last deploy was at 2026-04-09 01:48 UTC. The `^1.2.3` range in `package.json` combined with a pinned lockfile kept us on 1.2.3.

## Fix

Bumped to `@livekit/agents@1.2.4` and sibling plugins. Also bumped `@livekit/rtc-node` to `0.13.25` to satisfy the new peer dep.

Verified the fix is present in `node_modules/@livekit/agents/dist/ipc/proc_pool.js`: `unlock()` now runs immediately after `warmedProcQueue.put()`, before `await proc.join()`.

Shipped via `1bb8c8a` → GitHub Actions deploy workflow.

## Prevention

1. **Stay current on `@livekit/agents` patch versions.** The fix existed for 4 hours before the incident. Consider Renovate/Dependabot for LiveKit packages, or a `pnpm outdated` check in CI.
2. **Monitor for the canary signal:** any session where the agent's `Participant joining` timestamp is more than ~2 seconds after the caller's `Participant joining`. Those are degraded calls (agent late) or outright missed calls (agent never). Worth alerting on.
3. **Consider `min_replicas: 2`** if the plan supports it. Even with this bug fixed, a single replica can't survive a pod restart or hardware event mid-call. Two replicas gives graceful failover.
4. **Audit recent calls** for degraded-start cases (agent joining 10+ seconds late). Listen to recordings to gauge how bad the dead-air experience was for callers who waited it out.
