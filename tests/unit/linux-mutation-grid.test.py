"""Local orchestration checks. These do not claim kernel/Docker mutation proof."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('linux_mutation_grid', ROOT / 'scripts/linux-mutation-grid.py')
grid = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grid)


class GridTests(unittest.TestCase):
    def test_inventory_is_complete_and_every_mutant_parses(self):
        rows = grid.plan(ROOT)
        self.assertEqual(len(rows), 165)
        self.assertEqual(sum(row['kind'] != 'shell' for row in rows), 87)
        self.assertEqual(sum(row['kind'] == 'shell' for row in rows), 78)
        self.assertEqual({row['mutation'] for row in rows}, {'remove', 'loosen', 'invert'})
        self.assertEqual(len({(row['file'], row['line'], row['kind'], row['mutation']) for row in rows}), 165)
        self.assertTrue(all(row['diff'] and row['replacementSha256'] for row in rows))

    def test_inventory_refuses_stale_or_missing_guards(self):
        guards = json.loads((ROOT / 'scripts/linux-mutation-grid.json').read_text())
        for change in ('missing', 'stale', 'wrong-kind'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / 'scripts').mkdir()
                (root / 'packages/worker/ec2').mkdir(parents=True)
                for path in (grid.HELPER, grid.BOOT):
                    (root / path).write_text((ROOT / path).read_text())
                altered = json.loads(json.dumps(guards))
                if change == 'missing':
                    altered.pop()
                elif change == 'stale':
                    altered[0]['source'] = 'stale'
                else:
                    altered[0]['kind'] = 'wrong-kind'
                (root / 'scripts/linux-mutation-grid.json').write_text(json.dumps(altered))
                with self.assertRaises(RuntimeError):
                    grid.plan(root)

    def test_mutation_generation_refuses_a_missing_or_ambiguous_target(self):
        rows = json.loads((ROOT / 'scripts/linux-mutation-grid.json').read_text())
        python = rows[0]
        for mutation in ('remove', 'loosen', 'invert'):
            with self.assertRaises(RuntimeError):
                grid.python_mutation((ROOT / python['file']).read_text(), {**python, 'line': 10000}, mutation)
        shell = next(row for row in rows if row['kind'] == 'shell')
        with self.assertRaises(RuntimeError):
            grid.shell_mutation((ROOT / shell['file']).read_text() + shell['source'], shell, 'remove')
        with patch.object(grid, 'shell_mutation', side_effect=lambda source, *unused: source):
            with self.assertRaisesRegex(RuntimeError, 'unchanged mutant'):
                grid.plan(ROOT)

    def test_decision_mutants_only_change_the_selected_assignment(self):
        source = "#!/bin/bash\n<<'PY'\nrunning=True\ntarget=False\nlegacy_only=target\nsentinel=7\nPY\n"
        for mutation, expected in [('remove', False), ('loosen', True), ('invert', True)]:
            changed = grid.python_mutation(source, {'line': 5, 'kind': 'decision'}, mutation)
            ns = {}
            exec(changed.split("<<'PY'\n")[1].rsplit('\nPY', 1)[0], ns)
            self.assertIs(ns['legacy_only'], expected)
            self.assertIs(ns['running'], True)
            self.assertIs(ns['target'], False)
            self.assertEqual(ns['sentinel'], 7)

    def test_execution_refuses_a_missing_tagged_external_or_invalid_image(self):
        for image in ['', 'localhost:50123/close-retention:tag', 'example.invalid/worker@sha256:' + 'a'*64, 'localhost:50123/close-retention@sha256:abc']:
            with patch.object(grid, 'check_manual'), patch.dict(os.environ, {'CLOSE_RETENTION_TEST_IMAGE': image}), patch.object(grid, 'result') as result:
                with self.assertRaises(RuntimeError):
                    grid.execute(ROOT, Path('/unused'))
                result.assert_not_called()

    def test_only_complete_green_baselines_and_all_kills_pass(self):
        good = {'baselineBefore': True, 'baselineAfter': True, 'mutants': [{'killed': True}, {'killed': True}]}
        grid.verify_document(good, 2)
        for document in [{**good, 'baselineBefore': False}, {**good, 'baselineAfter': False}, {**good, 'mutants': []}, {**good, 'mutants': [{'killed': True}, {'killed': False}]}]:
            with self.assertRaises(RuntimeError):
                grid.verify_document(document, 2)

    def test_only_documented_equivalence_can_replace_an_execution(self):
        good = {'baselineBefore': True, 'baselineAfter': True, 'mutants': [
            {'killed': False, 'equivalent': True, 'equivalence': 'duplicate validation before the same effect'}]}
        grid.verify_document(good, 1)
        for change in [{'equivalent': False}, {'equivalent': 'yes'}, {'equivalence': ''}, {'equivalence': None}]:
            with self.assertRaises(RuntimeError):
                grid.verify_document({**good, 'mutants': [{**good['mutants'][0], **change}]}, 1)
        rows = grid.plan(ROOT)
        self.assertEqual(sum(bool(row.get('equivalence')) for row in rows), 9)
        self.assertTrue(all(row['mutation'] != 'invert' for row in rows if row.get('equivalence')))

    def test_execution_requires_linux_and_explicit_manual_environment(self):
        for platform, enabled in [('darwin', '1'), ('linux', ''), ('linux', '0')]:
            with patch.object(sys, 'platform', platform), patch.dict(os.environ, {'CODE_CI_LINUX': enabled}):
                with self.assertRaises(RuntimeError):
                    grid.check_manual()
        with patch.object(sys, 'platform', 'linux'), patch.dict(os.environ, {'CODE_CI_LINUX': '1'}):
            grid.check_manual()

    def test_both_cli_execution_paths_refuse_before_docker_without_manual_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            docker = directory / 'docker'
            docker.write_text('#!/bin/sh\nprintf hit > "$CLOSE_RETENTION_DOCKER_MARKER"\nexit 9\n')
            docker.chmod(0o700)
            marker = directory / 'called'
            for enabled in (None, '0'):
                for args in ([], ['--prepare-image']):
                    env = {**os.environ, 'PATH': str(directory), 'CLOSE_RETENTION_DOCKER_MARKER': str(marker)}
                    env.pop('CODE_CI_LINUX', None)
                    if enabled is not None: env['CODE_CI_LINUX'] = enabled
                    result = subprocess.run([sys.executable, str(ROOT / 'scripts/linux-mutation-grid.py'), *args], env=env, text=True, capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('execution requires Linux and CODE_CI_LINUX=1', result.stderr)
                    self.assertFalse(marker.exists())

    def test_authorized_cli_entries_reach_work_without_real_docker(self):
        with patch.object(sys, 'platform', 'linux'), patch.dict(os.environ, {'CODE_CI_LINUX': '1', 'CLOSE_RETENTION_TEST_IMAGE': 'localhost:50123/close-retention@sha256:' + 'a'*64}):
            with patch.object(grid, 'plan', side_effect=RuntimeError('authorized grid')):
                with self.assertRaisesRegex(RuntimeError, 'authorized grid'):
                    grid.execute(ROOT, Path('/unused'))
            with patch.object(sys, 'argv', ['linux-mutation-grid.py', '--prepare-image']), patch.object(grid, 'run', side_effect=RuntimeError('authorized image build')):
                with self.assertRaisesRegex(RuntimeError, 'authorized image build'):
                    grid.main()

    def test_only_a_completed_failed_target_is_a_kill(self):
        for statuses, code, valid, killed in [
            (['passed'], 0, True, False), (['failed'], 1, False, True),
            (['pending'], 0, False, False), ([], 1, False, False),
            (['passed'], 1, False, False), (['failed'], 0, False, False),
            (['failed', 'failed'], 1, False, False),
        ]:
            with self.subTest(statuses=statuses, code=code), tempfile.TemporaryDirectory() as temporary:
                report = Path(temporary) / 'report.json'
                report.write_text(json.dumps({'testResults': [{'assertionResults': [
                    {'fullName': 'boot v2 fixture', 'status': status} for status in statuses
                ]}]}))
                outcome = ('trace' if code == 0 else subprocess.CalledProcessError(code, ['vitest'], output='trace'))
                with patch.object(grid, 'run', return_value=outcome if code == 0 else None,
                                  side_effect=None if code == 0 else outcome):
                    self.assertEqual(grid.result(ROOT, 'image', 'boot v2', report), (valid, killed, 'trace'))

    def test_crash_and_timeout_are_not_kills(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = Path(temporary) / 'missing.json'
            with patch.object(grid, 'run', side_effect=subprocess.CalledProcessError(1, ['vitest'], output='crash')):
                with self.assertRaises(FileNotFoundError):
                    grid.result(ROOT, 'image', '', report)
            with patch.object(grid, 'run', side_effect=subprocess.TimeoutExpired(['vitest'], 540)):
                with self.assertRaises(subprocess.TimeoutExpired):
                    grid.result(ROOT, 'image', '', report)

    def test_registry_is_loopback_and_removes_only_its_container_even_on_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            images = grid.Images(ROOT, Path(temporary))
            calls = []
            def fake(args, *unused, **kwargs):
                calls.append(args)
                if args[:2] == ['docker', 'run']:
                    # A first pull's progress arrives on the merged stream before the id: only the last line is the container.
                    return 'Unable to find image \'registry:2\' locally\n2: Pulling from library/registry\nDigest: sha256:' + 'a' * 64 + '\nowned-container\n'
                if args[:2] == ['docker', 'port']:
                    return '127.0.0.1:50123\n'
                if args[:3] == ['docker', 'image', 'inspect']:
                    raise RuntimeError('inspect failed')
                return ''
            with patch.object(grid, 'run', side_effect=fake):
                with self.assertRaisesRegex(RuntimeError, 'inspect failed'):
                    images.digest('local-image')
            self.assertEqual(calls[0], ['docker', 'pull', '--quiet', 'registry:2'])
            self.assertIn('127.0.0.1::5000', calls[1])
            self.assertIn(['docker', 'port', 'owned-container', '5000/tcp'], calls)
            self.assertIn(['docker', 'push', 'localhost:50123/close-retention:proof'], calls)
            self.assertEqual(calls[-1], ['docker', 'rm', '--force', 'owned-container'])

    def fixture(self, temporary):
        root = Path(temporary) / 'input'
        root.mkdir()
        for path in (grid.HELPER, grid.BOOT):
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text((ROOT / path).read_text())
        (root / 'node_modules').mkdir()
        return root

    def test_survivor_fails_and_restores_baseline_and_deletes_scratch(self):
        for before, killed, after in [(True, True, True), (True, False, True), (False, False, True), (True, True, False)]:
            with self.subTest(before=before, killed=killed, after=after), tempfile.TemporaryDirectory() as temporary:
                root = self.fixture(temporary)
                output = Path(temporary) / 'output.json'
                row = next(r for r in grid.plan(ROOT) if r['file'] == grid.BOOT and r.get('guard') == 463)
                calls = []
                def fake_result(scratch, image, selector, report, expected_failure=None):
                    calls.append(scratch)
                    if selector:
                        self.assertNotEqual((scratch / grid.BOOT).read_text(), (root / grid.BOOT).read_text())
                        return False, killed, 'mutant trace'
                    self.assertEqual((scratch / grid.BOOT).read_text(), (root / grid.BOOT).read_text())
                    return (before if len(calls) == 1 else after), False, 'baseline trace'
                with patch.object(grid, 'check_manual'), patch.object(grid, 'plan', return_value=[row]), patch.object(grid, 'result', side_effect=fake_result), patch.dict(os.environ, {'CLOSE_RETENTION_TEST_IMAGE': 'localhost:50123/close-retention@sha256:' + 'a'*64}):
                    if before and killed and after:
                        grid.execute(root, output)
                    else:
                        with self.assertRaises(RuntimeError):
                            grid.execute(root, output)
                data = json.loads(output.read_text())
                self.assertEqual(data['baselineBefore'], before)
                self.assertEqual(data['baselineAfter'], after)
                self.assertEqual(len(data['mutants']), 1 if before else 0)
                self.assertTrue(all(not scratch.exists() for scratch in calls))
                self.assertEqual((root / grid.BOOT).read_text(), (ROOT / grid.BOOT).read_text())

    def test_equivalence_is_recorded_honestly_and_is_not_executed_or_counted_as_a_kill(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.fixture(temporary)
            output = Path(temporary) / 'output.json'
            row = next(r for r in grid.plan(ROOT) if r.get('equivalence'))
            with patch.object(grid, 'check_manual'), patch.object(grid, 'plan', return_value=[row]), patch.object(grid, 'run', side_effect=AssertionError('equivalence attempted Docker')), patch.object(grid, 'result', return_value=(True, False, 'baseline')) as result, patch.dict(os.environ, {'CLOSE_RETENTION_TEST_IMAGE': 'localhost:50123/close-retention@sha256:' + 'a'*64}):
                grid.execute(root, output)
            self.assertEqual(result.call_count, 2)
            recorded = json.loads(output.read_text())['mutants'][0]
            self.assertIs(recorded['equivalent'], True)
            self.assertIs(recorded['killed'], False)
            self.assertEqual(recorded['equivalence'], row['equivalence'])

    def test_equivalence_branch_cannot_skip_a_real_mutant(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.fixture(temporary)
            output = Path(temporary) / 'output.json'
            row = next(r for r in grid.plan(ROOT) if r.get('guard') == 463)
            calls = []
            def result(scratch, image, selector, report, expected_failure=None):
                calls.append(selector)
                return (False, True, 'killed') if selector else (True, False, 'baseline')
            with patch.object(grid, 'check_manual'), patch.object(grid, 'plan', return_value=[row]), patch.object(grid, 'run', side_effect=AssertionError('unexpected Docker')), patch.object(grid, 'result', side_effect=result), patch.dict(os.environ, {'CLOSE_RETENTION_TEST_IMAGE': 'localhost:50123/close-retention@sha256:' + 'a'*64}):
                grid.execute(root, output)
            recorded = json.loads(output.read_text())['mutants'][0]
            self.assertEqual(len(calls), 3)
            self.assertTrue(recorded['killed'])
            self.assertNotIn('equivalent', recorded)


if __name__ == '__main__':
    unittest.main()
