# Release and production automation

Release Please owns future semantic versions, `package.json` version updates,
changelog entries, tags, and GitHub Releases. Production deployment remains
independent: every successfully verified `main` commit deploys to LiveKit Cloud.

## Release flow

1. A normal pull request is squash-merged to `main` with a Conventional Commit
   title.
2. Release Please reads the resulting commit and opens or updates one release
   pull request.
3. Merging the release pull request updates `package.json`, the version
   manifest, and this changelog.
4. The next Release Please run creates the matching tag and GitHub Release.

The bootstrap commit is the published `4.0.0` tag. That tag established the
current tag shape without a `v` prefix, so future tags remain
`MAJOR.MINOR.PATCH`.

## Production flow

The production workflow runs on every push to `main`. It installs the pinned
Node and pnpm toolchain, runs the repository's format, lint, type, and unit
checks, verifies the pinned LiveKit CLI archive, then deploys the exact commit
with `lk agent deploy --yes`.

The deploy job owns the GitHub `production` environment. A successful job is
both GitHub's deployment record and proof that LiveKit reported a new agent
version as `Running` or `Sleeping`. The workflow fails on a terminal LiveKit
status or if the new version does not become healthy within five minutes.
Unlike the middleware's external Cloud Build trigger, the status check lives in
the deployment job instead of a separate polling workflow.

Release creation does not select a special production artifact. A release pull
request merge is an ordinary `main` commit and follows the same commit-based
deployment path.

## GitHub configuration

Release automation uses the same dedicated GitHub App pattern as
`Data-Buddies-Solutions/amd_middleware`. The App must be installed on this
repository with repository permissions for:

- Contents: read and write
- Issues: read and write
- Pull requests: read and write

Configure its client ID as the Actions variable
`RELEASE_PLEASE_APP_CLIENT_ID` and its private key PEM as the Actions secret
`RELEASE_PLEASE_APP_PRIVATE_KEY`. No App credential belongs in the repository.

Keep squash merge enabled with the pull request title as the squash commit
title. Disable merge commits and rebase merges so the Conventional Commit pull
request title remains the single release input on `main`.
