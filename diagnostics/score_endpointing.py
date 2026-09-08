"""Score the known synthetic fixtures. Do not infer correctness on unlabeled calls."""
import itertools
import json
import re
import statistics
import sys
from pathlib import Path


def compact(text):
    text = text.lower()
    text = text.replace('nineteen eighty six', '1986').replace('fourth', '4')
    text = re.sub(r'\b4th\b', '4', text)
    for word, digit in [('eight', '8'), ('five', '5'), ('two', '2'),
                        ('nine', '9'), ('zero', '0'), ('one', '1')]:
        text = re.sub(r'\b' + word + r'\b', digit, text)
    return re.sub(r'[^a-z0-9]', '', text)


def has_value(kind, text, reference):
    value = compact(text)
    if kind == 'name':
        return value.removeprefix('mynameis') == 'alexmartin'
    if kind == 'schedule':
        return value.removeprefix('iwouldliketocomeinon') == 'tuesdaymorninginsteadofwednesdayafternoon'
    if kind == 'member':
        return value.removeprefix('mymembernumberis') == '852901'
    if kind == 'dob':
        return value.removeprefix('mydateofbirthis') in ['june41986', '641986', '06041986', '6041986']
    if kind == 'spelling':
        return value.removeprefix('mylastnameisspelled') == 'martin'
    if kind == 'email':
        email = text.lower().replace(' dot ', '.').replace(' at ', '@')
        email = re.sub(r'^my email is\s+', '', email)
        return re.sub(r'\s+', '', email).rstrip('.?!') == 'alex.martin@example.com'
    if kind == 'insurance':
        return value.removeprefix('myinsuranceis') == 'aetnabetterhealthofflorida'
    if kind.startswith('holdout-'):
        return value == compact(reference)
    raise ValueError('Unknown labeled fixture kind')


def validate_pairing(results):
    seen, clips, arms, configs = set(), {}, {}, {}
    def without_context(value):
        if isinstance(value, dict):
            return {k: without_context(v) for k, v in value.items() if k not in ['agentContext', 'agent_context']}
        if isinstance(value, list):
            return [without_context(v) for v in value]
        return value
    for result in results:
        clip, arm = result['clip'], result['arm']['name']
        if (clip, arm) in seen:
            raise ValueError('Duplicate clip/arm result')
        seen.add((clip, arm))
        fixture = result['fixture']
        identity = (result['sha256'], fixture['kind'], fixture['reference'], fixture['targetEndMs'])
        if clip in clips and clips[clip] != identity:
            raise ValueError('Mismatched audio or labels for paired clip')
        clips[clip] = identity
        arms.setdefault(arm, set()).add(clip)
        key = (arm, fixture['profile'])
        config = json.dumps(without_context({'arm': result['arm'], 'stt': result['sttOptions']}), sort_keys=True)
        if key in configs and configs[key] != config:
            raise ValueError('Inconsistent options within an arm/profile')
        configs[key] = config
    if any(coverage != set(clips) for coverage in arms.values()):
        raise ValueError('Arms do not cover identical clips')


def score(result):
    fixture = result['fixture']
    events = result['events']
    commits = [e for e in events if e['type'] == 'commit' and e['text'].strip()]
    finals = [e['text'] for e in events if e['type'] == 'stt_final']
    one = len(commits) == 1
    complete = one and has_value(fixture['kind'], commits[0]['text'], fixture['reference'])
    coverage = compact(' '.join(finals)) == compact(' '.join(e['text'] for e in commits))
    # Includes commits after source end: a late prefix/suffix split still fails.
    premature = any(e['atMs'] < fixture['targetEndMs'] - 100 for e in commits)
    accepted = not result['errors'] and one and complete and coverage and not premature
    return {
        'clip': result['clip'], 'arm': result['arm']['name'],
        'executionValid': not result['errors'], 'commitCount': len(commits),
        'wholeValueInOneCommit': complete, 'allFinalTextCommitted': coverage,
        'prematureCommit': premature, 'accepted': accepted,
        'delayMs': round(commits[0]['atMs'] - fixture['targetEndMs']) if one else None,
        'sdkWarnings': len(result['warnings']),
        'transcriptionTimeouts': sum(e['type'] == 'transcription_timeout' for e in events),
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('Usage: score_endpointing.py RESULT.json ...')
    results = [json.loads(Path(p).read_text()) for p in sys.argv[1:]]
    validate_pairing(results)
    rows = [score(result) for result in results]
    arms = {}
    for arm in sorted({r['arm'] for r in rows}):
        selected = [r for r in rows if r['arm'] == arm]
        accepted = [r for r in selected if r['accepted']]
        arms[arm] = {
            'cases': len(selected), 'executionValid': sum(r['executionValid'] for r in selected),
            'accepted': len(accepted),
            'splitAnswers': sum(r['commitCount'] > 1 for r in selected),
            'medianAcceptedDelayMs': statistics.median(r['delayMs'] for r in accepted) if accepted else None,
            'sdkWarnings': sum(r['sdkWarnings'] for r in selected),
            'transcriptionTimeouts': sum(r['transcriptionTimeouts'] for r in selected),
        }
    comparisons = []
    for first, second in itertools.combinations(arms, 2):
        left = {r['clip']: r for r in rows if r['arm'] == first and r['accepted']}
        right = {r['clip']: r for r in rows if r['arm'] == second and r['accepted']}
        matched = sorted(left.keys() & right.keys())
        comparisons.append({'from': first, 'to': second, 'matchedAcceptedCases': len(matched),
            'medianDelayChangeMs': statistics.median(right[c]['delayMs'] - left[c]['delayMs'] for c in matched) if matched else None})
    print(json.dumps({'arms': arms, 'pairedComparisons': comparisons, 'cases': rows}, indent=2))
