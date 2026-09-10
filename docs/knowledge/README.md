# Controlled office corpus migration

All reusable office knowledge is prepared for Product's existing vector database.
These files are offline migration/evaluation inputs; the Agent runtime must not
read them. `manifest.json` explicitly maps the eight configured OfficeKeys to
archival sources and controlled import manifests. Product routes remain the
authority for tenant/office scope; sharing a Location never implies sharing facts.

The nine original Markdown sources were moved from `workspace/` to `sources/`
byte-for-byte. Every source matches Agent commit
`ad3d57550578096ace95df6600143c66d230189d`, with SHA-256 recorded in the manifest.
`KNOWLEDGE_DERM_DEMO.md` has no configured Agent OfficeKey or verified Product
route; it is archived, not imported. `sweetwater-optical`, `dev`, and
`mental-health-demo` are not additional active OfficeKeys. No office is inferred
from an alias or another office's Location.

Generate or check the seven new import candidates offline:

```sh
node scripts/generate-knowledge-imports.mjs
node scripts/generate-knowledge-imports.mjs --check
corepack pnpm@10.34.3 exec vitest run scripts/knowledge-evaluation.test.mjs
```

The generator uses explicit, reviewed editorial transformations, not an LLM.
Import IDs are deterministic for the source and final section content. The
Practice UUID is deliberately a placeholder; the operator must validate and
substitute the actual Practice for each route before applying the manifest.
The generator never connects to a database or changes published content.
Spring Hill references the previously prepared import unchanged; reuse the
existing current revision when its content matches instead of publishing a new
revision for formatting or metadata changes. Recorded source history is not new
business/clinical approval. The user authorized migration of the existing corpus.

## Facts and qualifications retained

Every source's supplied addresses, contact purposes, hours, provider identities,
age limits, service restrictions, prices, qualifications, and explicit absences
remain in its candidate. Sections remain whole, including exceptions. Numeric
prices and the source's unexplained `$150*` marker are preserved without inventing
a footnote. Retinal-photo fees remain qualified by plan coverage and demo status.
General payment policy does not establish a caller's balance or permit collecting
card data. Readiness policy does not establish a particular order's status.

`legacy-prompt-facts.json` records exact supplementary source text and hashes:
Hollywood/Sweetwater weekend closures and the shared glasses-readiness policy
for Crystal River, Hollywood, Sweetwater, North Miami Beach, and fictional
Clearbrook (from its separate demo role source). These facts
were formerly in prompts and are now in the relevant corpus. No new readiness
fact is added to the existing Spring Hill revision. Holiday dates stay dated;
a historical closure must not become a repeating or current closure.

Demo distinctions remain explicit. Clearbrook and Juniper Ridge are fictional.
New Tampa uses real public practice identity but demo scheduling/insurance and
simulated after-hours notification. Its verified hours, prices, and many optical
facts remain not supplied. No Clearbrook facts are transferred to New Tampa.
New Tampa's public-source URLs and September 6, 2026 verification date remain
in its Source and Demo Limitations section; this migration is not a live refresh.

## Behavior retained at runtime owners

The corpus contains reference facts, never executable tool/prompt commands.
The Agent implementation must retain these safeguards outside the corpus:

| Scope | Removed command / required runtime behavior |
| --- | --- |
| All | True medical emergency: immediate emergency-care guidance; never wait for search, intake, insurance, callback, or demo notification. No diagnosis or personal medication advice. Query only non-patient office questions. |
| Abita eye offices / Clearbrook | New flashes/floaters, sudden vision loss, and other eye emergencies: immediate staff transfer; clarify only genuinely missing urgency details. |
| All with administrative email | Address only for paperwork/requested documents. Medication/clinical/urgent issues follow the established staff/transfer path, never an email promise. |
| Spring Hill | Under-seven routine-vision request uses medical pediatric care with Dr. Bach on his Spring Hill days; cataract visits only Dr. Licht. Current imported facts and existing pilot safeguards remain unchanged. |
| Crystal River | Medical-only, no pediatric ophthalmology/routine vision/contact lenses. Cataracts only Dr. Licht. Do not route routine care there; repair/warranty inspection belongs to Spring Hill. |
| Hollywood | Cataracts with Dr. Bach through medical scheduling. Routine age minima: Farnan 5, Vidal 7, Calero 4; no eligible routine provider means pediatric ophthalmology with Dr. Bach. |
| Sweetwater | Cataracts with Dr. Bach through medical scheduling. Routine age minima: Casas 7, Farnan 5, Calero 4; same pediatric alternative. |
| Hollywood / Sweetwater | Ask whether contact lenses are first-time; first fitting/training before 3 PM Monday–Thursday and before 1 PM Friday. Retina surgery is not offered: PCP/insurer referral to a retina surgeon. |
| North Miami Beach | Optical-only, age 7+. Medical/urgent concerns go to medical staff. No medical insurance checks. Phone payment/order policy is not an Agent payment capability. |
| Routine-vision offices | Proactively explain the supplied retinal-photo charge with its insurance qualification; obtain its exact amount from current knowledge. Do not claim coverage from office policy; `check_insurance` owns participation. |
| Optical offices | Outside prescriptions allowed; patients needing a prescription need the supported optometrist visit. Do not turn that into an appointment requirement for browsing/adjustments where walk-ins are allowed. |
| Offices with self-pay prices | Unaffordable cost: offer staff transfer to discuss options; do not invent discounts. Keep provider/visit class and new/established distinctions. |
| Billing | Route to the supplied billing department/contact or supported staff workflow. No unverified balance, refund, claim, payment, or completion assertion. |
| Hollywood / Sweetwater | At a normal non-urgent close, invite social follow-up only when current retrieval already supplied the Facebook/Instagram details; no mandatory extra close-time search. The handle is corpus data. |
| Clearbrook | Fictional providers, contacts and prices remain fictional; under-seven pediatric medical route; provider/location/eligibility comes from tools/staff. |
| New Tampa | Similar surnames Fridman/Friedman require first-name clarification for medical/unclear purpose. Routine exams go to Smur with caller agreement; retina needs medical triage. Existing demo helper owns after-hours script/notification/transfer, never the corpus. Urgent conditions cannot be treated as resolved by distant slots. |
| Rheumatology | Emergency and clinical-urgency routing remains in the rheumatology role. Infusions, injections, imaging, labs and procedures require staff/clinical review; routine medication requests are staff work, personal changes/doses/interactions/holds go to clinicians. General drug education retains all qualifications. |

These rules are an implementation handoff inventory, not a second runtime policy
source. The Agent worker verifies each against the owning prompt/tool/module.
Do not activate all-office retrieval while removed safety behavior lacks an owner.

## Evaluation and evidence

`semantic-cases.json` defines fixed non-patient questions per office, including
Spanish, indirect hours, service restrictions, prices/unknowns, missing facts,
and irrelevant input. Run real Google evaluation against all final candidates:

```sh
GOOGLE_CLOUD_PROJECT=acuity-health-prod node scripts/evaluate-all-office-knowledge.mjs
```

It writes `semantic-evaluation.json`: corpus hashes, model/dimensions, top sections,
expected-section coverage under the initial 0.52/four-passage policy, and honest
abstention cases. Embeddings are not saved. Questions remain fixed and PHI-free.
The evaluator ranks separately within each office; that is not proof of HTTP
scope isolation. Product authorization/DB tests and authenticated per-office
retrieval must prove the deployed route and revision separately. Similarity is
not proof that a passage answers a question. Real model consumption, supported
answers, and voice latency remain distinct evidence.

Observed all-office calibration on the final candidates: **54/56 factual target
cases** retrieved their required sections; **16 missing/irrelevant cases** are
recorded separately for model abstention and are not counted as retrieval passes.
The two misses remain visible: “What address and public office phone are
supplied?” did not retrieve Location and Contact in the top four for North Miami
Beach or rheumatology. Both natural “What is your office address and phone
number?” and “What is the office address?” retrieved the target for all eight
offices. No corpus fact, backend phrase rule, passage limit, or threshold was
changed to erase these failures. The complete 72 cases remain in the artifact.

Evaluation selection uses unrounded cosine scores for ordering, threshold, and
passage limits; only exported diagnostic scores are rounded. The threshold-edge
regression proves that display rounding cannot admit an excluded passage or
reverse two closely ranked candidates.
