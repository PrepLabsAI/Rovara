import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The variable the worker's verified base read takes the directory of its empty git directories from (packages/worker/src/trusted-base-objects.ts). */
export const EMPTY_GIT_DIRECTORY_ROOT_VARIABLE = "AGENTX_EMPTY_GIT_DIRECTORY_ROOT";

/** Makes `empty-sha1.git` and `empty-sha256.git` under `root`: empty bare repositories with nothing writable, as the worker image carries them. */
export function createEmptyGitDirectories(root: string): void {
  mkdirSync(root, { recursive: true });
  for (const format of ["sha1", "sha256"]) {
    execFileSync("git", ["init", "--bare", "--quiet", "--template=", `--object-format=${format}`, join(root, `empty-${format}.git`)], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  }
  makeReadOnly(root);
}

function makeReadOnly(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) for (const name of readdirSync(path)) makeReadOnly(join(path, name));
  chmodSync(path, stat.isDirectory() ? 0o555 : 0o444);
}

function makeWritable(path: string): void {
  const stat = lstatSync(path);
  chmodSync(path, 0o755);
  if (stat.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
}

/** Removes what {@link createEmptyGitDirectories} made. */
export function removeEmptyGitDirectories(root: string): void {
  try {
    makeWritable(root);
  } catch { /* already gone */ }
  rmSync(root, { recursive: true, force: true });
}
