// A folder whose whole ancestry passes the verifier's protected-directory rule (packages/verifier/src/application-runtime-cli.ts checkProtectedDirectory): every
// folder from it up to "/" is a real directory (no link), owned by root or by this test's account, and not writable by its group or others.
//
// Where such a folder is depends on the machine: on a GitHub runner the checkout qualifies (/home/runner/work/... is the runner's own), on a laptop the home
// folder does (a checkout under /tmp does not: /tmp is world-writable), and in an AWS CodeBuild container the build's own folders above the checkout are writable
// by others, so neither the checkout nor /tmp qualifies there. A test that needs such a folder takes the first that qualifies and skips, saying why, when none does.
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";

function protectedAncestry(path: string, uid: number): boolean {
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) return false;
    if (dirname(current) === current) return true;
  }
}

/** The first of the checkout, the home folder and the temporary folder that this account can write in and whose ancestry is protected; undefined when none is. */
export function protectedBaseDirectory(): string | undefined {
  if (typeof process.getuid !== "function") return undefined;
  const uid = process.getuid();
  for (const candidate of [process.cwd(), homedir(), tmpdir()]) {
    try {
      const path = realpathSync(candidate);
      accessSync(path, constants.W_OK);
      if (protectedAncestry(path, uid)) return path;
    } catch { /* not there, not writable or not readable: the next one */ }
  }
  return undefined;
}

export const NO_PROTECTED_DIRECTORY = "no folder on this machine that this account can write in has an ancestry the protected-directory rule accepts";
