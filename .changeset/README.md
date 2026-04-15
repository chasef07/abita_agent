This repo uses Changesets to batch releases through a `Version Packages` pull request instead of creating a release on every push to `main`.

For a user-facing change, add a changeset in your feature branch before merging:

```bash
pnpm dlx @changesets/cli add
```
