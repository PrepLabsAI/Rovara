// Run only in a disposable Linux container as root, with no network or secrets:
// node scripts/check-candidate-ownership.mjs
// Reproduces Git's real ownership check; no mocked Git or model calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chown, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateGit } from '../packages/worker/dist/candidate.js';

assert.equal(process.platform, 'linux', 'requires disposable Linux container');
assert.equal(process.getuid(), 0, 'requires container root to create another-owner fixture');
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'candidate-ownership-'));
const env = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
try {
  const repo = join(root, 'repo');
  await mkdir(repo);
  await exec('git', ['init', repo], { env });
  await exec('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/demo.git'], { env });
  await chown(repo, 1000, 1000);
  await chown(join(repo, '.git'), 1000, 1000);
  const untrustedRead = () => exec('git', ['-C', repo, 'remote', 'get-url', 'origin'], { env });
  await assert.rejects(untrustedRead, /dubious ownership/);
  assert.equal((await candidateGit(repo, ['remote', 'get-url', 'origin'])).trim(), 'https://github.com/example/demo.git');
  // The exception must be command-local, not a global security relaxation.
  await assert.rejects(untrustedRead, /dubious ownership/);
  console.log('PASS: candidate Git handles one exact repository without changing global trust');
} finally {
  await chown(join(root, 'repo'), 0, 0);
  await chown(join(root, 'repo/.git'), 0, 0);
  await rm(root, { recursive: true, force: true });
}
