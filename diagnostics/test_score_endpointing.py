import copy
import unittest
from score_endpointing import has_value, score, validate_pairing


def result():
    return {
        'clip': 'member', 'arm': {'name': 'baseline'}, 'sha256': 'audio-a',
        'sttOptions': {'minTurnSilence': 1500},
        'fixture': {'kind': 'member', 'profile': 'memberId',
                    'reference': 'My member number is eight five two nine zero one.',
                    'targetEndMs': 4000},
        'errors': [], 'warnings': [],
        'events': [{'type': 'stt_final', 'text': 'My member number is 852901.'},
                   {'type': 'commit', 'text': 'My member number is 852901.', 'atMs': 4500}],
    }


class ScoringTests(unittest.TestCase):
    def test_exact_values_allow_formatting_but_reject_extended_values(self):
        for kind, correct, wrong in [
            ('member', 'My member number is 852-901.', 'My member number is 852901A.'),
            ('dob', 'My date of birth is June 4th, 1986.', 'My date of birth is June 4th, 19860.'),
            ('email', 'My email is alex dot martin at example dot com.', 'My email is alex.martin@example.com.invalid'),
            ('insurance', 'My insurance is Aetna Better Health of Florida.', 'My insurance is Aetna Better Health of Florida Extra.'),
            ('spelling', 'My last name is spelled M-A-R-T-I-N.', 'My last name is spelled M-A-R-T-I-N-X.'),
        ]:
            with self.subTest(kind=kind):
                self.assertTrue(has_value(kind, correct, ''))
                self.assertFalse(has_value(kind, wrong, ''))

    def test_late_prefix_suffix_split_is_not_an_accepted_answer(self):
        complete = result()
        self.assertTrue(score(complete)['accepted'])
        split = copy.deepcopy(complete)
        split['events'] = [complete['events'][0],
                           {'type': 'commit', 'text': 'My member number is 852', 'atMs': 4500},
                           {'type': 'commit', 'text': '901.', 'atMs': 5000}]
        self.assertFalse(score(split)['accepted'])
        uncommitted = copy.deepcopy(complete)
        uncommitted['events'].append({'type': 'stt_final', 'text': 'Extra tail.'})
        self.assertFalse(score(uncommitted)['accepted'])

    def test_pairing_rejects_duplicates_mismatches_and_incomplete_coverage(self):
        baseline = result()
        candidate = copy.deepcopy(baseline)
        candidate['arm']['name'] = 'candidate'
        validate_pairing([baseline, candidate])
        with self.assertRaises(ValueError):
            validate_pairing([baseline, baseline])
        changed_audio = copy.deepcopy(candidate)
        changed_audio['sha256'] = 'different-audio'
        with self.assertRaises(ValueError):
            validate_pairing([baseline, changed_audio])
        extra = copy.deepcopy(baseline)
        extra['clip'] = 'another-clip'
        with self.assertRaises(ValueError):
            validate_pairing([baseline, candidate, extra])
        extra['sttOptions']['minTurnSilence'] = 100
        with self.assertRaises(ValueError):
            validate_pairing([baseline, extra])


if __name__ == '__main__':
    unittest.main()
