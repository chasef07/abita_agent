# Controlled endpointing follow-up

Historical parameter study at the commit below. The current runtime has since
returned to inference and fixed endpointing; see [current configuration](assemblyai.md).

Evaluated September 8, 2026 against draft PR #435 at `ae879ed`. This follow-up
holds provider and endpointing bounds constant to separate questions conflated
in the [earlier comparison](assemblyai-plugin-evaluation.md). Runtime settings
were not changed by this experiment.

## Controls and acceptance

All arms use the direct AssemblyAI 1.8.0 plugin, Universal-3.5 Pro, the full
LiveKit cloud audio turn detector with its calibrated thresholds, identical
input PCM, vocabulary, agent context, VAD settings, and 300/2500 ms LiveKit
endpointing bounds. Order rotates by fixture. Trials run serially at real speed
through `diagnostics/replay-endpointing.ts`; no concurrent audio or build jobs.
Every trial is fresh; no earlier result is counted as a new provider run.

The main matrix has 14 fixtures: six entity answers with 1200 ms internal pauses
(name, member number, DOB, spelling, email, insurance), three scheduling pauses
(600/1200/1800 ms), and five complete replies (affirmative, negative, name, DOB,
insurance). The matrix intentionally screens a subset of the existing 23-case
suite. It does not establish coverage of new speakers or longer entity pauses.

Acceptance requires the exact normalized value in one complete committed turn,
no premature prefix, and no final transcript text left uncommitted. Compare
latency only on matching fixtures accepted by both arms. Input hashes, labels,
arm coverage, and per-profile configuration consistency are checked before
scoring. Full raw results stay private.

These are STT/VAD/audio-model/SDK commit replays. They do not generate LLM/TTS
responses, exercise backend tools, or measure audible response latency. They
use automatic STT finalization; external-detector `ForceEndpoint` integration
remains absent. The provider documents that operation separately in
[Turn Detection](https://www.assemblyai.com/docs/streaming/turn-detection).

## Main matrix: 70 fresh trials

Ordinary STT remains 100/100 ms in every row. Only the entity silence windows
change in the final two rows. Alpha changes only the dynamic strategy's learned
minimum; all arms retain the same 2500 ms ceiling.

| LiveKit mode | Entity STT min/max ms | Complete correct answers | Split answers |
|---|---:|---:|---:|
| Fixed | 1500/1500 | 12/14 | 2 |
| Dynamic, alpha .9 | 1500/1500 | 11/14 | 3 |
| Dynamic, alpha .7 | 1500/1500 | 11/14 | 3 |
| Dynamic, alpha .9 | 1000/2000 | 11/14 | 3 |
| Dynamic, alpha .9 | 500/1500 | 10/14 | 4 |

Both longer scheduling pauses split in every arm. The 600 ms scheduling pause
passed only in the fixed trial; that apparent difference requires repeats.
The 500/1500 entity window additionally split the paused name.

On the 11 mutually accepted fixtures, fixed was a median paired **26 ms faster**
than dynamic .9. Alpha .7 versus .9 had **0 ms median paired difference** on the
same 11 fixtures. These small, single-trial differences do not establish a
latency advantage or a preferred alpha.

The unequal 1000/2000 window preserved the same nine entity answers as 1500/1500
but was a median paired **384 ms slower**. The 500/1500 window was **34.5 ms
faster** on eight mutually accepted entity answers, while losing the paused
name. Its complete-name holdout was faster (969 versus 1840 ms), illustrating
the tradeoff between fast complete names and preserving paused names. A faster
median among successful cases does not cancel the additional correctness failure.

There were no execution failures or transcription timeouts in these 70 trials.
Maximum pacing drift was 85 ms, below the harness's 100 ms rejection threshold.
One SDK warning occurred in the 500/1500 arm and remains in private evidence.

## Which component supplied the wait?

For the paused member number, all five arms committed at about 2534–2540 ms
after the known waveform end. Final transcripts arrived after 1764–2221 ms,
but the model's completion probability was about .125, selecting LiveKit's
2500 ms ceiling. Making STT faster alone could not remove the remaining wait.
The complete negative reply likewise took 2527–2528 ms under fixed and both
dynamic alphas, with completion probability about .346.

Other answers were transcript-gated: the dynamic .9 DOB and email cases
committed within 0–1 ms of the final transcript. STT latency matters there.
There is no single bottleneck shared by all answers.

The unfinished scheduling prefix received probability about .892, above the
native .56 threshold, while its effective minimum was still 300 ms. Dynamic
learning cannot retroactively protect that first pause. Later effective minima
did adapt: roughly 381–385 ms with alpha .9 on the 1200 ms pause fixtures.
Fresh single-answer trials remain weak evidence about learning over a call.

## Ordinary STT windows: 15 fresh trials

Five ordinary fixtures (three scheduling pauses and two short replies) were
replayed with dynamic .9 and STT windows 100/100, 128/640, and 128/1280 ms.
Every configuration preserved 2/5 answers and split all three scheduling
continuations. The two mutually accepted replies are too small a latency sample
to select a new default. Increasing only the maximum from 640 to 1280 ms at
minimum 128 ms did not improve correctness in this set.

All 15 executions were valid; maximum pacing drift was 27 ms. There were no
transcription timeouts and one SDK warning, in the 100/100 arm. This is a
comparison of concrete silence parameters, not a test of the provider's full
mode presets, which can also change other options.

## Saved audio: 15 valid trials

Five existing excerpts were replayed under fixed, dynamic .9, and dynamic .7,
with identical 100/100 ms STT settings: two caller-channel recordings, a known
synthetic reference, and one known human reference in clean and noisy versions.
The clean/noisy pair is one speaker, not independent speaker coverage. Existing
preprocessing was reused; no noise-cancellation algorithm changed. Historical
agent-channel activity informs endpointing on the two calls, but is approximate
and does not reproduce live LLM/TTS or interruption behavior.

| Mode | Committed turns across five excerpts | Word errors / known reference words | Transcription timeouts | SDK warnings |
|---|---:|---:|---:|---:|
| Fixed | 14 | 11/130 | 1 | 2 |
| Dynamic .9 | 12 | 11/130 | 1 | 0 |
| Dynamic .7 | 13 | 11/130 | 1 | 1 |

Reference scoring excludes the two private calls, which lack independent
truth labels. Fewer commits are not a correctness improvement, and differently
segmented turns are not interchangeable latency samples. All three modes
reproduced the same early transcription timeout in one recording.

On that recording, fixed committed six turns and both dynamic modes committed
five; all three retained identical normalized concatenated text. The .9 learned
minimum rose through 331/331/461/505/711 ms at commits; .7 rose through
394/394/682/745/936 ms. Fixed remained at 300 ms. On the other recording, every
mode committed three turns; the learned minimum reached only 319 ms with .9 and
357 ms with .7. This verifies active adaptation and greater responsiveness to
recent observed pauses at .7, but does not establish better conversational boundaries.

The fixed synthetic-reference replay was rejected for 141 ms pacing drift.
Its identical input/configuration was rerun in a separate private output
directory and passed. The rejected artifact remains available; it is excluded
from the 15 valid trials above. Maximum drift among accepted saved-audio trials
was 74 ms. The scorer checks the replacement's hash, labels, and full arm
configuration against the rejected trial before accepting the replacement.

## Targeted repetitions: 12 fresh trials

The 600 ms scheduling continuation was repeated three times each under fixed
and dynamic .9 with identical STT. Both configurations split all three repeats.
Including the initial matrix, fixed preserved 1/4 and dynamic preserved 0/4.
The first fixed pass is not a reproducible scheduling fix or a basis for
preferring fixed mode.

The 1200 ms paused name was repeated twice per entity STT window under dynamic
.9. Including the initial trial:

| Entity STT min/max ms | Correct whole names / three trials |
|---|---:|
| 1500/1500 | 3/3 |
| 1000/2000 | 2/3 |
| 500/1500 | 0/3 |

The 1500/1500 name delays were 1780, 1882, and 1714 ms. In the failed 1000/2000
repeat, a prefix final existed before speech ended. The full-answer audio
prediction then committed that earlier text 465 ms after the waveform end;
the remaining final arrived at 1323 ms, followed by a second commit. This
reproduces the previously identified transcript/audio alignment race. It is
not fixed by increasing the STT maximum when its lower minimum still permits
an earlier partial-name final.

All 12 repetitions were execution-valid; maximum pacing drift was 47 ms.
These are repeated trials of the same waveforms, not independent speakers.

## Decision and remaining work

The follow-up completed **112 valid replays**: 70 main-matrix trials, 15 ordinary
STT trials, 15 saved-audio trials, and 12 targeted repetitions. One additional
timing-invalid attempt was retained and excluded. Runtime settings remain
unchanged, and PR #435 remains a draft.

- Retain 1500/1500 ms as the better-supported entity candidate among these
  tested windows. The two unequal ranges do not earn a runtime change: one
  slowed accepted entities and also split a name on repeat; the other repeatedly
  split that name. This is limited evidence, not a universal optimal window.
- Dynamic mode demonstrably learns, but neither dynamic .9 nor .7 establishes
  better correctness or latency than fixed in this experiment. Fixed's initial
  extra pass did not repeat. No new mode or alpha recommendation is justified.
- The three ordinary STT ranges did not solve unfinished scheduling phrases.
  The maximum still delays short low-confidence answers under every tested
  mode. These tests hold LiveKit bounds constant and cannot select optimal bounds.
- External-detector `ForceEndpoint` integration, fresh-final alignment, and
  genuine multi-turn session tests remain separate unfinished work. These
  automatic-finalization trials do not validate that integration or a rollout.

Reproduction uses the existing [replay and scoring tools](../../diagnostics/README.md)
with the fixture subset and arm settings above. Private manifests, full events,
scored reports, and the rejected attempt are retained outside the repository.
The baseline is the current draft's direct plugin configuration, not the older
gateway baseline. Agent context and keyterms are held constant, so these
results do not measure the benefit of the context-lifecycle fix or entity hints.

## Review and checks

Format, lint, typecheck, all 48 application test files / 1019 tests, the office
knowledge benchmark, and three Python scorer regression tests passed after the
audio runs ended. Runtime and diagnostic source code were unchanged.

Standards review found no actionable issues. Spec review verified the counts,
paired comparisons, replacement provenance, and event-timeline explanations;
its alpha wording clarification was accepted. No review finding was rejected.
Both reviews retained the limits above, particularly repeated synthetic voices,
unlabeled call boundaries, and absent ForceEndpoint/session integration.
