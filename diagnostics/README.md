# Local endpointing replays

These diagnostics replay 16 kHz, mono, signed 16-bit little-endian PCM at real
speed through paid AssemblyAI/LiveKit APIs. They exercise STT, local VAD, full
cloud audio turn prediction, and SDK user-turn commits. They do not call an LLM,
synthesize agent responses, connect to a room, or invoke application tools.

Use Node 22, the repository's pnpm version, installed dependencies, and existing
LiveKit credentials plus `ASSEMBLYAI_API_KEY` in `.env.local`. The current runtime
and generated candidate use the direct AssemblyAI plugin. Provider calls cost
money. Keep fixtures, manifests, raw results, and transcripts in a private folder
outside the repository. The replay rejects output inside this checkout and
writes private directories/files with 0700/0600 permissions.

## Known synthetic regression suite

On macOS, use Python with `av`, `numpy`, and `scipy` installed in a dedicated
virtual environment. The generator uses the installed Samantha `say` voice and
outputs exact pause labels plus complete short-answer holdouts. Run from the
repository root; replace the example private path with your own:

```sh
python diagnostics/prepare-endpointing-fixtures.py /tmp/endpointing-private
pnpm exec tsx diagnostics/prepare-endpointing-manifest.ts /tmp/endpointing-private/labeled-references.json
node --env-file=.env.local --import tsx diagnostics/replay-endpointing.ts /tmp/endpointing-private/manifest.json /tmp/endpointing-private/results
python diagnostics/score_endpointing.py /tmp/endpointing-private/results/labeled-*.json /tmp/endpointing-private/results/holdout-*.json
```

The manifest pairs the frozen pre-change timing baseline with this checkout's
actual exported settings. Inspect it before running. Node's `--env-file` does
not override existing shell environment variables; make sure a stale exported
provider key is not shadowing the intended local key.

Each case runs serially. Avoid builds, test suites, or concurrent audio jobs
while replaying: playback drift above 100 ms invalidates timing. Re-run invalid
cases in a fresh output directory; do not count failed trials as successful
measurements. A successful replay is execution validity only. The separate
scorer verifies paired input hashes, matching clip coverage, and stable arm/profile
options before it rejects split answers, wrong or missing entity values, prematurely
committed prefixes, and uncommitted recognized text. Compare delay only among
correct answers, ideally paired by the same fixture and repeated.

Scorer regression checks run without credentials:

```sh
python3 -B -m unittest discover -s diagnostics -p 'test_*.py'
```

## Existing recordings or additional settings

The replay consumes a JSON object with a `cases` array. Every case contains:

- `clip`: `id`, PCM `file`, `seconds`, and a description in `processing`. Known
  synthetic fixtures also include `kind`, `reference`, and `targetEndMs`.
- `arm`: `name`, SDK `endpointing` options, optional `unlikelyThreshold`, and
  `stt: { provider: "assemblyai" | "inference", options: ... }`. Options use the
  selected provider's actual constructor field names; credentials stay in env.
- Optional `clip.agentMarkers`: chronological `{ type: "start" | "end", atMs }`
  markers from the recorded agent channel, used only for endpointing learning.

Copy a generated manifest to compare additional min/max/alpha settings. Natural
calls have no automatic ground truth: the synthetic scorer intentionally rejects
unknown fixture kinds. Use independent labels before asserting cutoff rates or
transcription accuracy on real recordings. Only the caller channel belongs in
`clip.file`; retain and identify any preprocessing rather than applying an
unrecorded second noise filter.

Private results record the input hash and complete event timeline. SDK warnings
are captured privately, not discarded or printed with transcript text. Every
run adds five seconds of silence for drainage, then closes recognition before
freezing events. Exclude commits after a truncated natural source's end from
latency comparisons; retain all events when checking correctness of complete
labeled answers.

The harness deliberately imports pinned SDK internals to observe the real
pipeline. Re-audit those imports/contracts before changing the Agents version.
Its historical-agent markers approximate endpointing learning; they do not
reproduce full interactive interruption state. Full application behavior still
needs session integration tests and a live conversational pilot.
