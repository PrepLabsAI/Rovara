// Lane P5a (DEC 435 delta D4.1): the file side of the static package-key check. It reads the few config files that say where a repository's packages come from, from the repository's working copy
// at the recorded commit, and hands their text to the pure detector in @agentx/contracts. Nothing here runs a command, installs, reads Secrets Manager or returns a token: a token value written in
// a committed file is reported by the detector as file, line and host only.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { detectStaticPackageKeys, type HasCompanyToken, type PackageKeyFile, type StaticPackageKeyResult } from "@agentx/contracts";

/** Repository-root files the detector reads. A file that is not there, is a link, or is not a regular file is skipped (a link could point outside the repository). */
export const PACKAGE_KEY_FILE_NAMES = [".npmrc", ".yarnrc.yml", ".yarnrc", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"] as const;
/** A config file is small; a lockfile may be large. A file over its bound is skipped, never read in part. */
export const PACKAGE_KEY_FILE_MAX_BYTES = { config: 64 * 1024, lockfile: 24 * 1024 * 1024 } as const;
const isLockfile = (name: string): boolean => name.endsWith(".lock") || name.endsWith(".json") || name === "pnpm-lock.yaml";

async function readOne(repositoryRoot: string, name: string): Promise<PackageKeyFile | undefined> {
  const path = join(repositoryRoot, name);
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  if (info.size > (isLockfile(name) ? PACKAGE_KEY_FILE_MAX_BYTES.lockfile : PACKAGE_KEY_FILE_MAX_BYTES.config)) return undefined;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    return { path: name, text: await handle.readFile({ encoding: "utf8" }) };
  } finally {
    await handle.close();
  }
}

export async function readPackageKeyFiles(repositoryRoot: string): Promise<PackageKeyFile[]> {
  const files = await Promise.all(PACKAGE_KEY_FILE_NAMES.map((name) => readOne(repositoryRoot, name)));
  return files.filter((file): file is PackageKeyFile => file !== undefined);
}

/**
 * The wiring point for the setup run: call it for each repository BEFORE any install. When the result carries `untested`, the repository is `untested: needs_package_key` and no install command may be
 * run for it. `hasCompanyToken` answers only set / not set.
 */
export async function detectRepositoryPackageKeys(input: { repositoryRoot: string; repo: string; hasCompanyToken: HasCompanyToken }): Promise<StaticPackageKeyResult> {
  return detectStaticPackageKeys({ repo: input.repo, files: await readPackageKeyFiles(input.repositoryRoot), hasCompanyToken: input.hasCompanyToken });
}
