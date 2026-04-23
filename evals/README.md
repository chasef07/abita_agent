# Transcript Eval Cases

This folder is for transcript-derived local evals.

Use:

```bash
pnpm extract:transcript-evals --limit 25 --issue transfer
```

The extractor reads `DATABASE_URL` from the environment or `.env.local`, redacts
obvious PII, and writes generated cases under `evals/cases/extracted/`.

Generated case files are intentionally gitignored. Promote only reviewed,
sanitized cases into a committed eval folder.
