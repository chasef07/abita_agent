# Production Cutover

This branch is the production candidate for the task/state scheduling agent. It is not live until the architecture is re-applied onto `main` and pushed, because deploys run only from `main`.

## Current Branch Situation

- `origin/main` currently contains a revert of the earlier task-state PR.
- `task-state-rewrite-plan` contains the state/task architecture plus hardening work.
- A normal PR from the old task branch can understate the real production diff because most of the architecture was already merged once and then reverted.

## Recommended Merge Path

1. Start from latest `main`.
2. Create a fresh production branch.
3. Revert the revert commit on `main`, or cherry-pick the task-state architecture commits onto the fresh branch.
4. Apply the latest hardening changes from `task-state-rewrite-plan`.
5. Confirm production build and lint pass.
6. Merge to `main`; GitHub Actions deploys via `.github/workflows/deploy.yml`.

## Required Runtime Secrets

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `ASSEMBLYAI_API_KEY`
- `BASETEN_API_KEY`
- `ELEVENLABS_API_KEY`
- `AMD_API_TOKEN`

## Optional But Production-Recommended

- `AMD_API_URL`
- `ANALYTICS_URL`
- `WEBHOOK_SECRET`

## Production Smoke Call

After deploy, make one real SIP call per office number and verify:

1. The greeting uses the right office.
2. Caller phone lookup does not block the first turn.
3. A quick FAQ uses `lookup_knowledge`.
4. A scheduling intent enters the schedule workflow instead of collecting everything at router level.
5. A transfer request plays the required transfer message before `transfer_call`.
6. The room is deleted and analytics are posted on hangup.
