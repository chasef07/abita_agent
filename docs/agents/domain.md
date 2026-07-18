# Domain Docs

How engineering skills should consume this repo's domain documentation.

## Before exploring

Read these when they exist:

- `CONTEXT.md` at the repo root.
- Relevant ADRs under `docs/adr/`.

If they don't exist, proceed silently. The domain-modeling workflow creates
them lazily when terminology or decisions are resolved.

## Layout

This is a single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When naming a domain concept in an issue, proposal, test, or implementation,
use the term defined in `CONTEXT.md`. Avoid synonyms the glossary explicitly
rejects.

If a needed concept is missing, reconsider whether it belongs to the domain or
note the gap for domain modeling.

## Flag ADR conflicts

If work contradicts an existing ADR, surface the conflict explicitly instead
of silently overriding the decision.
