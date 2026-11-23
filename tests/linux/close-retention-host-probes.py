"""Root filesystem probes for the deferred embedded-Python guards; manual disposable Linux only."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

sys.dont_write_bytecode = True
if sys.platform != 'linux' or os.getuid() != 0 or os.environ.get('CODE_CI_LINUX') != '1':
    raise RuntimeError('root Linux manual proof only')
HELPER = Path(__file__).resolve().parents[2] / 'packages/worker/ec2/close-retention.sh'
SOURCE = HELPER.read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]


class HostProbes(unittest.TestCase):
    def setUp(self):
        self.ns = {}
        exec(SOURCE[:SOURCE.rindex('\nif sys.argv[1]')], self.ns)
        self.temp = tempfile.TemporaryDirectory(prefix='close-retention-root-probes-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.control = self.root / '.agentx-control'
        self.control.mkdir(mode=0o755)
        self.journal = self.control / 'journal/.agentx/operations'
        self.journal.mkdir(parents=True, mode=0o700)
        self.data = self.root / 'data'
        self.data.mkdir()
        self.ns.update(ROOT=str(self.root), CONTROL=str(self.control), CURRENT=str(self.control / 'current.json'),
                       JOURNAL=str(self.journal), DATA=str(self.data), RUN=str(self.root / 'run'), VIEW=str(self.root / 'run/view'))
        self.ns['journal_records'].__defaults__ = (str(self.journal), None)
        self.addCleanup(self.close_cache)

    def close_cache(self):
        if self.ns['CONTROL_FD'] is not None: os.close(self.ns['CONTROL_FD'])

    def refuses(self, call):
        with self.assertRaises((ValueError, OSError)): call()

    def test_directory_owners_modes_and_device_are_checked(self):
        child = self.control / 'child'
        for uid, mode in [(1001, 0o700), (0, 0o777)]:
            child.mkdir(mode=mode); child.chmod(mode); os.chown(child, uid, uid)
            self.refuses(lambda: self.ns['ensure_dir'](str(child)))
            child.rmdir()
        child.mkdir()
        subprocess.run(['mount', '-t', 'tmpfs', 'tmpfs', str(child)], check=True)
        try: self.refuses(lambda: self.ns['ensure_dir'](str(child)))
        finally: subprocess.run(['umount', str(child)], check=True)
        child.rmdir()
        self.ns['ensure_dir'](str(child)); self.assertEqual(child.stat().st_mode & 0o777, 0o700)

    def test_data_directory_rejects_a_foreign_owner(self):
        os.chown(self.data, 1001, 1001)
        self.refuses(self.ns['data_directory'])
        os.chown(self.data, 1000, 1000); self.ns['data_directory']()

    def test_runtime_is_created_idempotently_and_rejects_bad_state(self):
        self.ns['prepare_run'](); self.ns['prepare_run']()
        run = self.root / 'run'
        for uid, mode in [(1001, 0o750), (0, 0o777)]:
            os.chown(run, uid, uid); run.chmod(mode)
            self.refuses(self.ns['prepare_run'])
            os.chown(run, 0, 1000); run.chmod(0o750)
        journal = run / 'journal'
        journal.rmdir(); journal.symlink_to(self.data, target_is_directory=True)
        self.refuses(self.ns['prepare_run'])
        journal.unlink()

    def test_copy_closes_both_file_descriptors(self):
        source, destination = self.control / 'source', self.control / 'destination'
        source.write_bytes(b'proof'); source.chmod(0o600)
        self.ns['copy_regular'](str(source), str(destination))
        self.assertEqual(destination.read_bytes(), b'proof')
        for fd in Path('/proc/self/fd').iterdir():
            try: target = os.readlink(fd)
            except FileNotFoundError: continue
            self.assertNotIn(target, [str(source), str(destination)], 'copy leaked an open generation fd')

    def test_restore_rejects_untrusted_image_before_any_mount_command(self):
        gen = dict(sessionGeneration=3, instanceId='i-0123456789abcdef0', volumeId='vol-0123456789abcdef0', dataGeneration=str(uuid.uuid4()))
        value = dict(schemaVersion=1, workspaceId=str(uuid.uuid4()), filesystemId=str(uuid.uuid4()), generation=gen)
        self.ns['save'](self.ns['CURRENT'], value)
        backing = self.control / 'generations' / (gen['dataGeneration'] + '.ext4')
        backing.parent.mkdir(); backing.write_bytes(b'not a filesystem'); backing.chmod(0o666)
        calls = []
        def observe(*args):
            calls.append(args)
            raise AssertionError('untrusted image reached an external mount command')
        self.ns['run'] = observe
        self.refuses(self.ns['restore']); self.assertEqual(calls, [])

    def test_identity_validators_refuse_before_any_docker_or_control_writes(self):
        args = [str(uuid.uuid4()), '3', 'i-0123456789abcdef0', 'vol-0123456789abcdef0']
        for index, bad in [(0, '../escape'), (1, '0'), (1, '9007199254740992'), (2, 'i-../escape'), (3, 'vol-invalid')]:
            value = list(args); value[index] = bad
            calls = []
            run = self.ns['run']
            def observe(*argv):
                calls.append(argv)
                return run(*argv)
            self.ns['run'] = observe
            self.refuses(lambda: self.ns['migrate'](*value)); self.assertEqual(calls, [])
            self.ns['run'] = run


if __name__ == '__main__':
    unittest.main()
