"""Portable migration behavior; Docker/mount/process boundaries are controlled, control files are real."""
import copy
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch
import uuid

HELPER = Path(__file__).resolve().parents[2] / 'packages/worker/ec2/close-retention.sh'


class MigrationTests(unittest.TestCase):
    def setUp(self):
        source = HELPER.read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
        self.ns = {}
        exec(source[:source.rindex('\nif sys.argv[1]')], self.ns)
        self.temporary = tempfile.TemporaryDirectory(prefix='close-retention-b1-')
        self.addCleanup(self.temporary.cleanup)
        root = os.path.realpath(self.temporary.name)
        self.root = Path(root)
        self.control = self.root / '.agentx-control'
        self.control.mkdir(mode=0o755)
        self.journal = self.control / 'journal/.agentx/operations'
        self.legacy = self.root / '.agentx/operations'
        self.legacy.mkdir(parents=True, mode=0o700)
        self.ns.update(ROOT=root, CONTROL=str(self.control), CURRENT=str(self.control / 'current.json'),
                       DATA=root + '/data', JOURNAL=str(self.journal), RUN=root + '/run',
                       HOST_UID=os.getuid(), WORKER_UID=os.getuid())
        self.ns['journal_records'].__defaults__ = (str(self.journal), None)
        self.workspace = str(uuid.uuid4())
        self.args = (self.workspace, '3', 'i-0123456789abcdef0', 'vol-0123456789abcdef0')
        self.record = dict(schemaVersion=1, operationId=str(uuid.uuid4()), workspaceId=self.workspace,
                           fence=9, payloadHash='a'*64, status='RUNNING',
                           acceptedAt='2026-11-22T00:00:00.000Z', updatedAt='2026-11-22T00:00:00.000Z')
        self.containers = ''
        self.running = ''
        self.ns['run'] = self.docker
        self.enter(patch.object(self.ns['glob'], 'glob', return_value=[]))
        # Portable tests do not claim root ownership proof; Linux tests use the real owners.
        chown, fchown = os.chown, os.fchown
        self.enter(patch.object(os, 'chown', side_effect=lambda path, *a: chown(path, os.getuid(), os.getgid())))
        self.enter(patch.object(os, 'fchown', side_effect=lambda fd, *a: fchown(fd, os.getuid(), os.getgid())))

    def enter(self, context):
        context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)

    def docker(self, *args):
        self.assertIn(args, [('docker', 'ps', '--quiet'), ('docker', 'ps', '--all', '--quiet')])
        return self.running if args == ('docker', 'ps', '--quiet') else self.containers

    def save(self, value):
        self.ns['save'](str(self.legacy / (self.record['operationId'] + '.json')), value)

    def assert_legacy(self):
        self.assertEqual(self.ns['migrate'](*self.args), 'legacy')
        self.assertTrue(self.journal.is_dir())
        self.assertTrue((self.root / 'run/journal').is_dir())
        self.assertFalse((self.control / 'current.json').exists())
        self.assertEqual(list((self.control / 'generations').iterdir()), [])

    def test_running_and_stopped_containers_keep_legacy_without_migration(self):
        for state in ('running', 'stopped'):
            with self.subTest(state=state):
                self.containers = 'persisted-devcontainer'
                self.running = self.containers if state == 'running' else ''
                self.assert_legacy()

    def test_active_journal_keeps_legacy_and_preserves_fence_and_record(self):
        self.save(self.record)
        self.assert_legacy()
        self.assertFalse((self.journal / (self.record['operationId'] + '.json')).exists(), 'legacy journal must remain the only record authority')
        self.assertEqual(self.ns['load_control_json'](str(self.legacy / (self.record['operationId'] + '.json')), 4194304, self.ns['ControlJournalV1']), self.record)
        self.assertEqual((self.journal / 'fences' / (self.workspace + '.json')).read_text(), '9')
        self.assertEqual((self.legacy / 'fences' / (self.workspace + '.json')).read_text(), '9', 'legacy worker must see the fence high-water')

    def test_legacy_status_change_reboots_then_migrates_with_latest_record(self):
        self.save(self.record)
        self.containers = 'stopped'
        self.assert_legacy()
        self.record.update(status='SUCCEEDED', updatedAt='2026-11-22T01:00:00.000Z')
        self.save(self.record)
        self.assert_legacy()
        self.assertFalse((self.journal / (self.record['operationId'] + '.json')).exists(), 'legacy boot copied a mutable record')
        self.containers = ''
        self.ns['run'] = lambda *args: '' if args[0] == 'docker' else '/dev/loop-proof' if args[0] == 'losetup' else str(uuid.uuid4()) if args[0] == 'blkid' else ''
        self.ns['publish_view'] = lambda value: None
        with patch.object(self.ns['shutil'], 'disk_usage', return_value=type('Space', (), {'free': 512*1024*1024})()):
            self.assertEqual(self.ns['migrate'](*self.args), 'migrated')
        migrated = self.ns['load_control_json'](str(self.journal / (self.record['operationId'] + '.json')), 4194304, self.ns['ControlJournalV1'])
        self.assertEqual(migrated['status'], 'SUCCEEDED')
        self.assertEqual(migrated['updatedAt'], self.record['updatedAt'])
        self.assertEqual(migrated['layoutMigration']['phase'], 'committed')
        self.assertEqual((self.journal / 'fences' / (self.workspace + '.json')).read_text(), '9')
        self.assertEqual((self.legacy / 'fences' / (self.workspace + '.json')).read_text(), '9', 'legacy worker must see the fence high-water')

    def test_legacy_fence_uses_maximum_of_records_and_both_fence_paths(self):
        self.save(self.record)
        self.assert_legacy()
        self.ns['save'](str(self.journal / 'fences' / (self.workspace + '.json')), 29)
        self.assert_legacy()
        self.assertEqual((self.legacy / 'fences' / (self.workspace + '.json')).read_text(), '29')
        self.ns['save'](str(self.legacy / 'fences' / (self.workspace + '.json')), 39)
        self.assert_legacy()
        self.assertEqual((self.journal / 'fences' / (self.workspace + '.json')).read_text(), '39')
        self.assertEqual((self.legacy / 'fences' / (self.workspace + '.json')).read_text(), '39')

    def test_both_fence_paths_request_worker_ownership(self):
        self.ns['WORKER_UID'] = 1000
        self.save(self.record)
        calls = []
        fchown = os.fchown
        def capture(fd, uid, gid):
            calls.append((os.fstat(fd).st_ino, uid, gid))
            return fchown(fd, uid, gid)
        with patch.object(os, 'fchown', side_effect=capture):
            self.assert_legacy()
        for journal in (self.journal, self.legacy):
            for path in (journal / 'fences', journal / 'fences' / (self.workspace + '.json')):
                self.assertIn((path.stat().st_ino, 1000, 1000), calls, 'fence paths must request worker ownership')

    def test_low_space_status_change_keeps_single_legacy_authority(self):
        self.record['status'] = 'SUCCEEDED'
        self.save(self.record)
        with patch.object(self.ns['shutil'], 'disk_usage', return_value=type('Space', (), {'free': 128*1024*1024})()):
            self.assert_legacy()
            self.record.update(status='FAILED', updatedAt='2026-11-22T02:00:00.000Z')
            self.save(self.record)
            self.assert_legacy()
        self.assertFalse((self.journal / (self.record['operationId'] + '.json')).exists(), 'low-space boot copied a mutable record')

    def test_existing_data_keeps_legacy_and_never_overwrites_repository(self):
        data = self.root / 'data'
        data.mkdir()
        (data / 'work').write_text('unpublished')
        self.assert_legacy()
        self.assertEqual((data / 'work').read_text(), 'unpublished')

    def test_legacy_process_keeps_legacy(self):
        with patch.object(self.ns['glob'], 'glob', return_value=['/proc/123/fd/4']), patch.object(os, 'readlink', return_value=str(self.root / 'repo/open')):
            self.assert_legacy()

    def test_retained_and_destroy_state_refuse_even_with_pure_preconditions(self):
        gen = dict(sessionGeneration=3, instanceId=self.args[2], volumeId=self.args[3], dataGeneration=str(uuid.uuid4()))
        selector = dict(inspectionOperationId=str(uuid.uuid4()), inspectionFence=1, retentionId=str(uuid.uuid4()), contentDigest='b'*64, generation=gen)
        for action in ('retain', 'destroy'):
            with self.subTest(action=action):
                record = copy.deepcopy(self.record)
                command = dict(schemaVersion=1, action=action, **({'target': gen} if action == 'retain' else {'retention': selector, 'effectId': 'close:1', 'machineIds': ['machine']}))
                import hashlib, json
                digest = hashlib.sha256(json.dumps(dict(kind='close', workspaceId=self.workspace, operationId=record['operationId'], fence=9, payload=command), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                record.update(payloadHash=digest, closeRetention=dict(schemaVersion=1, commandHash=digest, generation=gen, command=command, phase='intent'))
                self.save(record)
                self.containers = 'stopped'
                with self.assertRaises(ValueError): self.ns['migrate'](*self.args)
                self.assertFalse(self.journal.exists())

    def test_invalid_journal_and_current_refuse_before_legacy_fallback(self):
        self.containers = 'stopped'
        self.save({**self.record, 'status': 'INVALID'})
        with self.assertRaises(ValueError): self.ns['migrate'](*self.args)
        (self.legacy / (self.record['operationId'] + '.json')).unlink()
        (self.control / 'current.json').write_text('{invalid')
        (self.control / 'current.json').chmod(0o600)
        with self.assertRaises(ValueError): self.ns['migrate'](*self.args)

    def test_current_layout_requires_quiescence_then_restores_without_legacy_fallback(self):
        self.journal.mkdir(parents=True, mode=0o700)
        gen = dict(sessionGeneration=3, instanceId=self.args[2], volumeId=self.args[3], dataGeneration=str(uuid.uuid4()))
        value = dict(schemaVersion=1, workspaceId=self.workspace, filesystemId=str(uuid.uuid4()), generation=gen)
        self.ns['save'](str(self.control / 'current.json'), value)
        restored = []
        self.ns['restore'] = lambda: restored.append(True)
        self.running = 'running'
        with self.assertRaises(ValueError): self.ns['migrate'](*self.args)
        self.assertEqual(restored, [])
        self.running = ''
        self.assertEqual(self.ns['migrate'](*self.args), 'migrated')
        self.assertEqual(restored, [True])
        with self.assertRaises(ValueError): self.ns['migrate'](self.workspace, '4', *self.args[2:])

    # ---- F-A (Opus review 4eda07a26): the helper's rule for an INTENT (a retain never sealed, never answered) must match the worker journal's ----
    def intent_world(self, image_mode=0o600, passed=False, phase='intent', old_generation=False, seal_on_intent=False):
        """A current layout with one retain record at fence 9 (and its image), the journal and the fence file the worker leaves."""
        import hashlib, json
        self.journal.mkdir(parents=True, mode=0o700)
        gen = dict(sessionGeneration=3, instanceId=self.args[2], volumeId=self.args[3], dataGeneration=str(uuid.uuid4()))
        value = dict(schemaVersion=1, workspaceId=self.workspace, filesystemId=str(uuid.uuid4()), generation=gen)
        if old_generation:
            value = dict(value, generation=dict(gen, dataGeneration=str(uuid.uuid4())))
        self.ns['save'](str(self.control / 'current.json'), value)
        (self.control / 'generations').mkdir(mode=0o700, exist_ok=True)
        image = self.control / 'generations' / (value['generation']['dataGeneration'] + '.ext4')
        image.write_bytes(b'x'); image.chmod(image_mode)
        (self.root / 'data').mkdir(mode=0o755, exist_ok=True)
        command = dict(schemaVersion=1, action='retain', target=gen)
        record = copy.deepcopy(self.record)
        digest = hashlib.sha256(json.dumps(dict(kind='close', workspaceId=self.workspace, operationId=record['operationId'], fence=9, payload=command), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        state = dict(schemaVersion=1, commandHash=digest, generation=gen, command=command, phase=phase)
        if phase == 'sealed' or seal_on_intent:
            state['seal'] = dict(filesystemId=value['filesystemId'], backingId='1:1', deviceId='7:1')
        if passed:
            state['supersededBy'] = str(uuid.uuid4())
        record.update(payloadHash=digest, closeRetention=state)
        self.ns['save'](str(self.journal / (record['operationId'] + '.json')), record)
        (self.journal / 'fences').mkdir(mode=0o700)
        self.ns['save'](str(self.journal / 'fences' / (self.workspace + '.json')), 11 if passed else 9)
        return value, record

    def restored_read_only(self, **world):
        self.intent_world(**world)
        calls = []
        def fake(*args):
            calls.append(args)
            if args[:2] == ('losetup', '--find'): return '/dev/loop7'
            return ''
        self.ns['run'] = fake
        self.ns['sealed'] = lambda value: None
        self.ns['publish_view'] = lambda value: None
        self.enter(patch.object(self.ns['os'].path, 'ismount', return_value=False))
        self.ns['restore']()
        mount = next(c for c in calls if c[0] == 'mount')
        return '--read-only' in next(c for c in calls if c[:2] == ('losetup', '--find')), mount

    def test_a_retired_intent_is_valid_journal_state_and_a_sealed_record_with_a_seal_still_is(self):
        _, record = self.intent_world(passed=True)
        self.ns['ControlJournalV1'](record)
        bad = copy.deepcopy(record); bad['closeRetention']['seal'] = dict(filesystemId=str(uuid.uuid4()), backingId='1:1', deviceId='7:1')
        with self.assertRaises(ValueError): self.ns['ControlJournalV1'](bad)

    def test_restore_mounts_read_write_under_an_intent_that_never_started_sealing_and_read_only_otherwise(self):
        for name, world, read_only in [
            ('an unsuperseded intent, image still writable (never sealed)', dict(), False),
            ('an intent retired by newer work', dict(passed=True), False),
            ('an intent whose image the host already made read-only (the seal crashed half way)', dict(image_mode=0o400), True),
            ('an intent that already carries a seal record', dict(seal_on_intent=True), True),
            ('a sealed retention', dict(phase='sealed', image_mode=0o400), True),
        ]:
            with self.subTest(name):
                self.tearDown_world()
                flag, mount = self.restored_read_only(**world)
                self.assertEqual(flag, read_only)
                self.assertEqual('ro,noload,noatime' in mount, read_only)

    def tearDown_world(self):
        import shutil
        for child in list(self.control.iterdir()):
            shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
        data = self.root / 'data'
        if data.exists(): shutil.rmtree(data)

    def test_validate_boot_skips_a_retired_intent_of_an_older_generation_and_refuses_an_unretired_one(self):
        for passed, refused in [(True, False), (False, True)]:
            with self.subTest(passed=passed):
                self.tearDown_world()
                value, record = self.intent_world(passed=passed)
                # The generation rotated since the intent (a confirmed hand-over): the current layout names another.
                rotated = dict(value, generation=dict(value['generation'], dataGeneration=str(uuid.uuid4())))
                self.ns['save'](str(self.control / 'current.json'), rotated)
                if refused:
                    with self.assertRaises(ValueError): self.ns['validate_boot'](*self.args)
                else:
                    self.assertEqual(self.ns['validate_boot'](*self.args), rotated)


if __name__ == '__main__':
    unittest.main()
