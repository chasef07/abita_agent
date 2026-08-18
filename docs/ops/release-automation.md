# Release and production automation

Release Please owns future semantic versions, `package.json` version updates,
changelog entries, tags, and GitHub Releases. A newly created Release Please
release is the only event that deploys to LiveKit Cloud.

## Release flow

1. A normal pull request is squash-merged to `main` with a Conventional Commit
   title.
2. CI verifies the exact `main` commit.
3. After successful CI, Release Please reads the commit and opens or updates one
   release pull request. No production deployment occurs.
4. Merging the release pull request updates `package.json`, the version
   manifest, and this changelog.
5. CI verifies that release commit, then Release Please creates the matching tag
   and GitHub Release.
6. The release workflow re-verifies the exact published release SHA before
   deploying it.

The bootstrap commit is the published `4.0.0` tag. That tag established the
current tag shape without a `v` prefix, so future tags remain
`MAJOR.MINOR.PATCH`.

## Production flow

The release workflow runs after successful CI on a push to `main`. Release
Please reports whether that commit created a release. Normal application merges
only open or update the release pull request, so their `release_created` output
is false and deployment is skipped.

When merging the release pull request creates a release, the workflow checks out
and re-verifies the exact SHA reported by Release Please. It then verifies the
pinned LiveKit CLI archive and deploys that same SHA with
`lk agent deploy --yes`.

The deploy job owns the GitHub `production` environment. A successful job is
both GitHub's deployment record and proof that LiveKit reported a new agent
version as `Running` or `Sleeping`. The workflow fails on a terminal LiveKit
status or if the new version does not become healthy within five minutes.
Unlike the middleware's external Cloud Build trigger, the status check lives in
the deployment job instead of a separate polling workflow.

The release SHA is the production source of truth. The workflow does not deploy
the triggering branch head implicitly, and no independent `main`-push deployment
workflow exists.

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
