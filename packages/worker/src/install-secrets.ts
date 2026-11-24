// Private packages P2a: the host folder the install container's token file lives in, and the rules around it.
//
// The token of the company's package registry exists in ONE place on the machine for the length of the install step: a file in `/run/rovara-install/<operation>/` on a host tmpfs (never the workspace
// volume, never EBS, never `/tmp` of the worker container, which is an overlay on disk), mode 0600 in a 0700 folder, mounted read-only into the install container alone.
// This module owns the folder's rules:
//   - `assertSecureInstallTmpfs`: the step refuses unless the root IS a mountpoint of type tmpfs, owned by the worker, mode 0700;
//   - `openInstallDirectory`: the per-operation folder, files made exclusively with mode 0600, and a removal that is ASSERTED (the folder must be gone afterwards, or the workspace is tainted);
//   - `assertNoInstallSecrets`: the central guard every sandbox start path calls; it refuses while ANY entry exists under the root (one workspace per VM, so host-wide is correct and simplest);
//   - `sweepInstallSecrets`: at worker start, what a crashed step left.
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { agentXError } from "@agentx/contracts";
import { RegistryTokenLeakError, removeTree } from "./registry-guard.js";

/** Where the host's tmpfs is mounted (boot.sh), at the same path on the host and in the worker container, so the host daemon's bind source is the very same tmpfs. */
export const INSTALL_SECRETS_ROOT = "/run/rovara-install";
/** The `f_type` of tmpfs (linux/magic.h TMPFS_MAGIC). */
export const TMPFS_MAGIC = 0x01021994;
export const INSTALL_SECRETS_PRESENT = "Rovara did not start a sandbox because a package token file is still on this machine; the install step has to remove it first";

/** The root is not a safe place for a token: not a tmpfs mountpoint of its own, not the worker's, or not private. Fixed words, no path. */
export class InstallTmpfsRefused extends Error {
  constructor() {
    super("Rovara has no private memory-only folder on this machine for the package token, so it did not install private packages");
    this.name = "InstallTmpfsRefused";
  }
}

export interface InstallFsSeams {
  statfs?: (path: string) => Promise<{ type: number }>;
  lstat?: (path: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number; dev: number }>;
  uid?: number | undefined;
}

/** Refuses (InstallTmpfsRefused) unless `root` is a real directory, its own mountpoint, of type tmpfs, owned by the worker, mode 0700. */
export async function assertSecureInstallTmpfs(root: string = INSTALL_SECRETS_ROOT, seams: InstallFsSeams = {}): Promise<void> {
  const stat = seams.lstat ?? ((path: string) => lstat(path));
  const fsType = seams.statfs ?? ((path: string) => statfs(path));
  try {
    const info = await stat(root);
    const parent = await stat(dirname(resolve(root)));
    const uid = seams.uid ?? process.getuid?.();
    const safe = info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && info.uid === uid && info.dev !== parent.dev && (await fsType(root)).type === TMPFS_MAGIC;
    if (safe) return;
  } catch { /* an unreadable root is not a safe one */ }
  throw new InstallTmpfsRefused();
}

/**
 * The guard of every sandbox start path (a task sandbox, a setup sandbox, a dev container, test services, the saved-image build and the prove sandbox): throws while anything is under the root. A root that does not
 * exist (a laptop, a test) has nothing in it; a root that cannot be read is treated as holding a secret.
 */
export async function assertNoInstallSecrets(root: string = INSTALL_SECRETS_ROOT): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw agentXError("RUNTIME_UNAVAILABLE", INSTALL_SECRETS_PRESENT);
  }
  if (entries.length > 0) throw agentXError("RUNTIME_UNAVAILABLE", INSTALL_SECRETS_PRESENT);
}

/** Removes whatever a crashed step left under the root (the mountpoint itself stays) and checks the root is empty after. Answers how many entries went. Throws RegistryTokenLeakError when something stays. */
export async function sweepInstallSecrets(root: string = INSTALL_SECRETS_ROOT): Promise<number> {
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw new RegistryTokenLeakError("Rovara could not read the package token folder at start, so it will not run sandboxes until it is cleared");
  });
  for (const name of names) await removeTree(join(root, name)).catch(() => undefined);
  if ((await readdir(root).catch(() => [] as string[])).length > 0) throw new RegistryTokenLeakError("Rovara could not clear the package token folder at start, so it will not run sandboxes until it is cleared");
  return names.length;
}

/** The folder name of an operation: a hash, so no id reaches a path or a docker option. */
export const installDirectoryName = (operationId: string): string => createHash("sha256").update(`rovara-install\0${operationId}`).digest("hex").slice(0, 16);

export interface InstallDirectory {
  /** The host path of the folder (also the bind source of the container's read-only mount). */
  readonly directory: string;
  /** Writes one file, exclusively, mode 0600. Returns its path. */
  write(name: string, content: string): Promise<string>;
  /** Removes the folder and checks that it is gone. Throws RegistryTokenLeakError when it is not (fail closed). */
  remove(): Promise<void>;
}

/** Makes the operation's folder (0700; one left by an earlier attempt of the same operation is removed first). */
export async function openInstallDirectory(root: string, operationId: string): Promise<InstallDirectory> {
  const directory = join(resolve(root), installDirectoryName(operationId));
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { mode: 0o700 });
  return {
    directory,
    async write(name, content) {
      const path = join(directory, name);
      await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return path;
    },
    async remove() {
      try {
        await removeTree(directory);
        await lstat(directory).then(
          () => { throw new Error("still there"); },
          (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
        );
      } catch {
        throw new RegistryTokenLeakError("Rovara could not remove the package token file at the end of the install step, so the workspace was set aside and will be set up again from a fresh clone");
      }
    },
  };
}
