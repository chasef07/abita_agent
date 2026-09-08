"""Create synthetic pause labels from separate known phrases, without inferred word timestamps."""
from pathlib import Path
import subprocess
import json
import sys
import av
import numpy as np
from scipy.signal import butter, sosfilt, resample_poly

if len(sys.argv) != 2:
    raise SystemExit('Usage: prepare-endpointing-fixtures.py PRIVATE_OUTPUT_DIR')
ROOT = Path(sys.argv[1]).resolve()
repo = Path(__file__).resolve().parent.parent
if ROOT == repo or repo in ROOT.parents:
    raise SystemExit('Store generated audio outside the repository')
ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
ROOT.chmod(0o700)
PHRASES = {
    'name-prefix': 'Alex',
    'name-suffix': 'Martin.',
    'schedule-prefix': 'I would like to come in on',
    'schedule-suffix': 'Tuesday morning instead of Wednesday afternoon.',
    'member-prefix': 'My member number is eight five two',
    'member-suffix': 'nine zero one.',
    'dob-prefix': 'My date of birth is June fourth',
    'dob-suffix': 'nineteen eighty six.',
    'spelling-prefix': 'My last name is spelled M, A,',
    'spelling-suffix': 'R, T, I, N.',
    'email-prefix': 'My email is alex dot martin',
    'email-suffix': 'at example dot com.',
    'insurance-prefix': 'My insurance is Aetna Better',
    'insurance-suffix': 'Health of Florida.',
}
def synthesize(name, text):
    p = ROOT / f'{name}.aiff'
    subprocess.run(['/usr/bin/say', '-v', 'Samantha', '-r', '165', '-o', str(p), text], check=True)
    with av.open(str(p)) as container:
        stream = container.streams.audio[0]
        frames = [f.to_ndarray().reshape(-1).astype(np.float64) for f in container.decode(stream)]
        x = np.concatenate(frames)
        x = resample_poly(x, 16000, stream.codec_context.sample_rate)
    x /= max(abs(x).max(), 1)
    x = sosfilt(butter(5, [300, 3400], btype='bandpass', fs=16000, output='sos'), x)
    # Trim TTS padding to 30 ms outside the audible waveform; preserve phonemes.
    active = np.flatnonzero(abs(x) >= 10 ** (-40 / 20))
    assert len(active)
    x = x[max(0, active[0]-480):min(len(x), active[-1]+481)]
    x = x / max(abs(x).max(), 1e-12) * .5
    return np.rint(np.clip(x, -1, 1) * 32767).astype('<i2')

audio = {name: synthesize(name, text) for name, text in PHRASES.items()}

references = []
profiles = {'name': 'intake', 'schedule': 'default', 'member': 'memberId', 'dob': 'intake',
            'spelling': 'intake', 'email': 'email', 'insurance': 'insurance'}
questions = {'name': 'What is your first and last name?', 'schedule': 'When would you like to come in?',
             'member': 'Please read your entire member number, including all digits.',
             'dob': 'What is your complete date of birth, including the year?',
             'spelling': 'Please spell your entire last name, letter by letter.',
             'email': 'What is your complete email address?',
             'insurance': 'What is the full name of your insurance plan?'}
for kind in profiles:
    for pause in ([600, 1200, 1800] if kind=='schedule' else [600, 1200]):
        prefix, suffix = audio[kind+'-prefix'], audio[kind+'-suffix']
        x = np.concatenate([np.zeros(8000, dtype='<i2'), prefix,
            np.zeros(pause*16, dtype='<i2'), suffix, np.zeros(48000, dtype='<i2')])
        name = f'labeled-{kind}-{pause}'
        p = ROOT / (name + '.pcm')
        x.tofile(p)
        p.chmod(0o600)
        references.append({'id': name, 'file': str(p), 'folder': ROOT.name,
            'seconds': len(x)/16000, 'profile': profiles[kind], 'kind': kind,
            'agentContext': questions[kind],
            'reference': PHRASES[kind+'-prefix']+' '+PHRASES[kind+'-suffix'],
            'gapStartMs': 500+len(prefix)/16, 'gapEndMs': 500+len(prefix)/16+pause,
            'targetEndMs': 500+len(prefix)/16+pause+len(suffix)/16,
            'processing': 'Known synthetic Mac speech, phone-band filtered; same audio across arms, no added Krisp.'})
for name, text, profile, question in [
    ('yes', 'Yes.', 'default', 'Does Tuesday morning work?'),
    ('no', 'No.', 'default', 'Do you wear contact lenses?'),
    ('tomorrow', 'Tomorrow morning.', 'default', 'When would you like to come in?'),
    ('name', 'Alex Martin.', 'intake', 'What is your first and last name?'),
    ('dob', 'June fourth, nineteen eighty six.', 'intake', 'What is your date of birth?'),
    ('insurance', 'Aetna Better Health of Florida.', 'insurance', 'What insurance plan do you have?'),
    ('correct', 'That is correct.', 'default', 'Is that right?'),
    ('thanks', 'Thank you.', 'default', 'You are all set.'),
]:
    samples = synthesize('holdout-' + name, text)
    x = np.concatenate([np.zeros(8000, dtype='<i2'), samples, np.zeros(48000, dtype='<i2')])
    name = 'holdout-' + name
    p = ROOT / (name + '.pcm')
    x.tofile(p)
    p.chmod(0o600)
    references.append({'id': name, 'file': str(p), 'seconds': len(x)/16000,
        'profile': profile, 'kind': name, 'agentContext': question, 'reference': text,
        'targetEndMs': 500+len(samples)/16,
        'processing': 'Complete synthetic Mac utterance, phone-band filtered, no added Krisp.'})
manifest = ROOT / 'labeled-references.json'
manifest.write_text(json.dumps(references, indent=2))
manifest.chmod(0o600)
print('Prepared',len(references),'known-reference pause and complete-answer fixtures.')
