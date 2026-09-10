# Patient-resolution cleanup: revised policy and local proof

## Delivered behavior

Chase revised the policy after the initial cleanup: a volunteered surname must
not block a unique phone/first-name match, the next lookup must accept first name
and DOB without surname, and callers should be asked to spell names.

1. Pre-call phone lookup supplies private candidates. Try the supplied first
   name using the existing whole-name fuzzy/phonetic matcher. One qualifying
   phone match resolves even if a volunteered surname conflicts. Any supplied
   DOB must still match. Existing verified records can activate locally;
   lightweight records require verified patient-ID hydration.
2. If unresolved, ask for the spelled first name and confirmed DOB. Send only
   `{firstName, dob}` to the existing middleware endpoint. A volunteered surname
   stays in pending evidence but is excluded from this retrieval query.
3. Middleware retrieves a first-name-prefix candidate set and returns
   `status: candidates`, `source: first_name`, `complete`, and `matches`.
   It never hydrates this search's singleton and adds no fuzzy matching policy.
4. The agent requires a complete candidate set, matches normalized exact first
   name and DOB, then hydrates the selected patient ID internally. A unique match
   ignores volunteered surname. Multiple matching charts require surname
   spelling or staff assistance. Surname disambiguation reuses the candidate set.
5. Hydration checks receipt completeness, selected patient ID, the first-name
   matching rule for that source, supplied DOB, and any surname actually needed
   for disambiguation. A candidate-only result is never an active chart.

Phone matching retains the existing 0.85 whole-name similarity threshold, or
0.65 plus a matching Double Metaphone code, after name normalization. These are
matching scores, not probabilities of correct identity. The bounded surname
matcher from PR #451 remains only for phone-candidate ambiguity with matching
DOB. Practice-wide first-name/DOB matching uses normalized equality.

## State, failure, and registration safeguards

- Missing fields preserve pending evidence; corrections replace only supplied
  fields. Explicit first-name correction preserves the intended patient's other
  details. An otherwise changed first name conservatively clears pending facts.
- `different_patient` clears pending evidence, candidate-search cache, active
  chart, registration draft, and patient-scoped work. It retains the previous
  chart ID as a guard against immediately reactivating it for a different person.
- Operation/transition guards prevent stale reads from activating a later patient.
  Candidate search and hydration share the selected office context.
- Identical input reuses the current decision, including definitive misses,
  ambiguity, and exhausted failures. Candidate sets survive surname clarification
  but are scoped to intended patient, first name, DOB, and office.
- The agent HTTP client owns one retry for retryable middleware reads. A failure
  remains failed, and incomplete candidates remain unresolved. Neither becomes
  an assertion that an existing patient is new.
- Creation still requires full identity, explicit new-patient intent, applicable
  insurance evidence, and its existing verified creation receipt. A first-name/
  DOB-only miss never produces the full-registration eligibility receipt.

## Provider completeness and evidence

Read-only AMD DEV probes returned these prefix-search results:

| Query | Rows | Page | Page count | Item count |
| --- | --- | --- | --- | --- |
| CODEX | 3 | 1 | 1 | 3 |
| COD | 3 | 1 | 1 | 3 |
| Jane | 4 | 1 | 1 | 4 |
| John | 2 | 1 | 1 | 2 |
| Nonexistent-first-name control | 0 | 1 | 0 | 0 |

Returned IDs were distinct and first names satisfied the requested prefix. No
raw records, credentials, or patient identifiers were retained in this report.
The new parser requires explicit page/count metadata and valid distinct records.
It fails closed on missing metadata, additional pages, inconsistent counts,
contradictory empty lists, missing demographics, or duplicate IDs. AMD's
first-and-middle field is parsed consistently with phone bootstrap; two charts
that differ only by middle name remain two candidates.

These probes establish the observed DEV response shape, not production
completeness, spelling sensitivity, or a production patient-recovery rate. No
production request, mutation, or deployment was performed in this revision.

## Before/after and cross-repository proof

Before changing the prior implementation, the new nine-case policy fixture had
**7 failures and 2 passes**. All nine pass after the revision. A further matrix now covers all 11 surname
pairs from PR #451 (including formerly rejected pairs), with and without DOB
and through both preloaded and ID-hydration paths. Explicit first-only, first/last,
and hyphenated/spaced spelling combinations also pass through phone and fallback
paths, with negative first-name/DOB controls. The final focused policy, recovery, and identity run passes
75 tests. Cases cover unique
phone matches with volunteered conflicting surname, phone hydration, first-name/
DOB search and internal hydration, spelled-letter normalization, collision and
surname-cache reuse, incomplete empty/singleton lists, and rejection of unrelated
practice-wide prefix matches.

The local cross-repository check used the agent's real `HttpOwnedMiddleware`
client, the Go HTTP handler and Patient module, and synthetic provider records.

| Scenario | Resolver invocations | Agent → middleware HTTP requests | Result |
| --- | --- | --- | --- |
| Unique first-name/DOB, conflicting volunteered surname | 1 | 2 | Verified after ID hydration |
| Two first-name/DOB matching charts | 1 | 1 | Ambiguous; ask surname spelling |
| Incomplete singleton candidate set | 1 | 1 | Lookup failed; no activation |
| Complete empty candidate set | 1 | 1 | Not found; no registration receipt from partial identity |

Repeating unresolved inputs added no requests. Across these four cases the Go
provider adapter observed **4 candidate searches, 1 demographic read, and 1
appointment read**. The temporary local test server was stopped and removed.
These are deterministic tool/HTTP counts, not live LLM invocations, spoken
question counts, or AMD-internal production traffic measurements.

Regression coverage also preserves explicit new-patient creation, late creation
and lookup races, different-patient resets, previous-chart guards, invalid and
mismatched hydration receipts, first-name corrections, office cache validity,
strict tool schemas, preemptive tool commitment, and subsequent patient-context
projection. Old surname-blocking expectations were removed because the user
explicitly superseded that policy. The obsolete stage-one replay script was
removed rather than retaining an inaccurate contract fixture.

## Changed files

Agent runtime:

- `src/identity/patient-identity.ts`, `name-matcher.ts`, and `candidate.ts`
- `src/clients/owned-middleware.ts` and `owned-middleware-patient.ts`
- `src/state/call-state.ts`, `src/runtime/precall-bootstrap.ts`, and
  `src/tools/resolve-patient.ts`

Agent conversation and proof: `workspace/SOUL.md`, all three `SOUL_*_DEMO.md`
prompts, `README.md`, this report, the new `patient-resolution-policy.test.ts`
and recovery test, and adjacent identity, middleware, call-tool, stable-catalog,
preemptive, and prompt/schema fixtures.

Middleware:

- `internal/clients/advancedmd_xmlrpc.go` and tests
- `internal/advancedmd/advancedmd.go`, `adapter.go`, and the deterministic adapter
- `internal/domain/patient.go`
- `internal/patient/patient.go` and tests
- `internal/http/handlers.go` and tests
- `README.md` and `docs/patient-resolve-and-appointments-spec.md`

The cleanup removes duplicated recovery/normalization/retry branches, the
patient-ID-only hydration promise map, duplicated switched-patient reply, the
agent's old full-name fallback, and superseded surname-blocking tests. No second
identity framework or legacy schema compatibility path was introduced.

The final simplification makes chart hydration accept a patient ID directly,
without constructing a synthetic phone candidate. The decision cache key contains
only identity and lookup context rather than full chart, appointment, insurance,
and office state. Three additional regression tests prove that irrelevant chart
changes preserve cached decisions while candidate DOB and appointment-reload
changes invalidate them. The provider parser now returns patient records and
completeness together from one envelope decode, shared by legacy lookups and the
new candidate-only lookup.

## Review and checks

The code-review skill's Standards and Spec axes reviewed both repositories
against the latest user instruction. Earlier findings about patient switching
and retry ownership remain fixed. The new Standards finding—middle names
causing false not-found—was accepted, fixed at the provider parsing boundary,
and independently reviewed. Final Standards and Spec reviews found no remaining
actionable code findings. The Standards documentation finding about stale base,
delivery status, and check counts was accepted and corrected. No rejected findings.

Agent checks use Node 22.22.1 and pnpm 10.34.3. The agent suite passes **1,147
tests across 54 files** after replacing superseded tests. Required format, lint, and typecheck pass. The Office Knowledge benchmark passes
its 250 ms budget. All middleware packages pass `go test ./...` and `go vet ./...`;
Go formatting and both diffs are clean.

## PR delivery and remaining limits

Agent worktree: `codex/patient-resolution-cleanup`, based on
`341d8d5`.
Middleware worktree: `codex/patient-first-name-dob`, based on
`46b769f`, isolated from the dirty primary middleware checkout.

Prepared for user-authorized PRs to main in both repositories; no merge or
deployment. PR #451 remains open at review time. Its focused matcher is included
here, limited to phone-candidate surname disambiguation under the revised policy.
The agent PR must call out this overlap; #451 is not modified or closed by this work.

Release the new middleware contract before the agent: an older middleware
rejects first-name/DOB input. Multipage/unknown-completeness searches deliberately
remain unresolved; pagination traversal is not implemented. A production
read-only smoke check is still needed before rollout. Name spelling, DOB
read-back, and truthful correction/switch intent remain conversation duties;
code validates inputs and receipts, not what the caller actually said.
