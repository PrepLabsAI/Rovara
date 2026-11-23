"""The manual proof must attribute a kill to its named refusal, not an unrelated failure."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('retention_grid', ROOT / 'scripts/linux-mutation-grid.py')
grid = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grid)


class GridTests(unittest.TestCase):
    def test_every_row_matches_captured_nested_failure_formats_only(self):
        guards = json.loads((ROOT / 'scripts/linux-mutation-grid.json').read_text())
        # Formats captured from real nested Vitest stderr and unittest stderr; refusal
        # names are literal producer messages, independent of the matcher expressions.
        samples = json.loads((ROOT / 'tests/support/close-retention-grid-failures.json').read_text())
        self.assertEqual({(row['file'], row['source']) for row in guards}, {(row['file'], row['source']) for row in samples})
        for row, sample in zip(guards, samples):
            with self.subTest(file=row['file'], line=row['line']), tempfile.TemporaryDirectory() as temporary:
                report = Path(temporary) / 'report.json'
                for message, expected in [(sample['failure'], True), ('command/source: ' + sample['failure'], False), ('AssertionError: unrelated disk assertion', False)]:
                    report.write_text(json.dumps({'testResults': [{'assertionResults': [{'fullName': 'boot v2 proof', 'status': 'failed', 'failureMessages': [message]}]}]}))
                    with patch.object(grid, 'run', side_effect=subprocess.CalledProcessError(1, ['proof'], output=sample['failure'])):
                        passed, killed, excerpt = grid.result(ROOT, 'image', 'boot v2', report, row['expectedFailure'])
                    self.assertFalse(passed)
                    self.assertEqual(killed, expected, sample['failure'])
                    self.assertEqual(excerpt.startswith('TARGETED FAILURE:'), expected)

    def test_plan_refuses_wrong_counts_and_missing_target(self):
        guards = json.loads((ROOT / 'scripts/linux-mutation-grid.json').read_text())
        read_text = Path.read_text
        for rows, message in [(guards[:-1], 'expected 29 Python'), (guards + [guards[-1]], 'expected 29 Python'), ([{k: v for k, v in row.items() if k != 'expectedFailure'} for row in guards], 'targeted expected failure')]:
            def read(path, *args, **kwargs):
                return json.dumps(rows) if path == ROOT / 'scripts/linux-mutation-grid.json' else read_text(path, *args, **kwargs)
            with patch.object(Path, 'read_text', read):
                with self.assertRaisesRegex(RuntimeError, message): grid.plan(ROOT)

    def test_only_targeted_assertion_failure_kills_the_mutant(self):
        with tempfile.TemporaryDirectory(prefix='close-retention-b1bis-report-') as temporary:
            report = Path(temporary) / 'report.json'
            for failure, killed in [('unrelated disk assertion', False), ('assert.equal(state, true, \"gateway running at worker start\")\nAssertionError: unrelated disk assertion', False), ('AssertionError: gateway running at worker start', True)]:
                report.write_text(json.dumps({'testResults': [{'assertionResults': [{'fullName': 'boot v2 proof', 'status': 'failed', 'failureMessages': [failure]}]}]}))
                # stdout can include the command/source containing a target; that is not a kill.
                with patch.object(grid, 'run', side_effect=subprocess.CalledProcessError(1, ['proof'], output='gateway running at worker start')):
                    passed, actual, excerpt = grid.result(ROOT, 'image', 'boot v2', report, r'^AssertionError[^\n]*gateway running at worker start')
                self.assertFalse(passed)
                self.assertEqual(actual, killed, 'unrelated assertion must not count as targeted kill')
                self.assertEqual(excerpt.startswith('TARGETED FAILURE:'), killed)


if __name__ == '__main__':
    unittest.main()
