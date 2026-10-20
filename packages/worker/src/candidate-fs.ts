import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { agentXError } from "@agentx/contracts";

// The worker writes a handful of files in the agent's repository itself: refs, HEAD, the index, locks, and the objects it creates. The agent can rename or replace
// any directory of that repository at any moment, so a path checked a moment ago can lead somewhere else by the time it is written. On Linux each directory is
// opened once with O_NOFOLLOW|O_DIRECTORY, from `/` down, and every later operation names the file through that open descriptor (`/proc/self/fd/<n>/<name>`, which
// the kernel resolves to the directory that was opened, whatever its path became). Nothing the agent does to the path afterwards reaches the write. Elsewhere
// (macOS, for development) the same calls check with lstat and realpath, which narrows the window and does not close it.

const OPEN_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const NAME = /^[^/\0]+$/u;
const DESCRIPTOR_PATHS = process.platform === "linux";

/** For tests: called with the name of a step of a write, between its checks and its effect. */
let hook: ((step: string) => Promise<void>) | undefined;
export function setCandidateWriteHookForTests(next: ((step: string) => Promise<void>) | undefined): void {
  hook = next;
}
export async function candidateWriteStep(step: string): Promise<void> {
  await hook?.(step);
}

function plainName(name: string): string {
  if (!NAME.test(name) || name === "." || name === "..") throw new Error(`candidate repository path component ${JSON.stringify(name)} is not a plain name`);
  return name;
}

export interface HeldDirectory {
  /** The path the directory was opened as, for messages. */
  readonly path: string;
  /** A path for `name` inside this very directory (not whatever the directory's path leads to later). */
  entry(name: string): string;
  /** A held directory for the subdirectory `name` (never through a symlink), made first when `create` is set; `undefined` when it is missing and `create` is not. */
  subdirectory(name: string, create: boolean): Promise<HeldDirectory | undefined>;
  close(): Promise<void>;
}

function notPlain(path: string, cause?: unknown): Error {
  return new Error(`candidate repository has a symlink or a file where the directory ${path} should be`, cause === undefined ? undefined : { cause });
}

async function openDescriptorDirectory(parent: string, name: string, path: string): Promise<{ handle: Awaited<ReturnType<typeof open>>; path: string }> {
  try {
    return { handle: await open(`${parent}/${plainName(name)}`, OPEN_DIRECTORY), path };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") throw notPlain(path, error);
    throw error;
  }
}

function held(handle: Awaited<ReturnType<typeof open>>, path: string): HeldDirectory {
  const base = `/proc/self/fd/${handle.fd}`;
  return {
    path,
    entry: (name) => `${base}/${plainName(name)}`,
    subdirectory: async (name, create) => {
      const childPath = join(path, name);
      try {
        return held((await openDescriptorDirectory(base, name, childPath)).handle, childPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!create) return undefined;
      }
      await mkdir(`${base}/${plainName(name)}`, { mode: 0o777 });
      return held((await openDescriptorDirectory(base, name, childPath)).handle, childPath);
    },
    close: () => handle.close(),
  };
}

function checked(path: string): HeldDirectory {
  return {
    path,
    entry: (name) => join(path, plainName(name)),
    subdirectory: async (name, create) => {
      const childPath = join(path, plainName(name));
      let stat = await lstat(childPath).catch(() => undefined);
      if (stat === undefined) {
        if (!create) return undefined;
        await mkdir(childPath, { mode: 0o777 });
        stat = await lstat(childPath);
      }
      if (!stat.isDirectory() || (await realpath(childPath)) !== childPath) throw notPlain(childPath);
      return checked(childPath);
    },
    close: async () => undefined,
  };
}

/** The directory at the absolute, already real path `absolute`, held open: every component is opened without following a symlink. */
export async function openDirectory(absolute: string): Promise<HeldDirectory> {
  if (!DESCRIPTOR_PATHS) {
    const stat = await lstat(absolute).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory() || (await realpath(absolute)) !== absolute) throw notPlain(absolute);
    return checked(absolute);
  }
  let current = await open("/", OPEN_DIRECTORY);
  let path = "";
  try {
    for (const name of absolute.split(sep).filter((part) => part !== "")) {
      path = `${path}/${name}`;
      const next = await openDescriptorDirectory(`/proc/self/fd/${current.fd}`, name, path);
      await current.close();
      current = next.handle;
    }
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
  return held(current, absolute);
}

/** Reads the small regular file `name` of `directory` (no symlink at its path, a size limit); `undefined` when absent. */
export async function readFileIn(directory: HeldDirectory, name: string, limit: number): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(directory.entry(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw notPlain(join(directory.path, name), error);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw notPlain(join(directory.path, name));
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** What `name` is in `directory` (without following a symlink): a file, a directory, something else, or `undefined` when it is absent. */
export async function kindIn(directory: HeldDirectory, name: string): Promise<"file" | "directory" | "other" | undefined> {
  const stat = await lstat(directory.entry(name)).catch(() => undefined);
  if (stat === undefined) return undefined;
  return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
}

export type DirectoryLock = { directory: HeldDirectory; name: string; handle: Awaited<ReturnType<typeof open>>; released: boolean };

/** Creates `<name>.lock` in `directory` exclusively, as Git takes a lock; one that is already there is another Git process's, or a crash's, and is named. */
export async function lockIn(directory: HeldDirectory, name: string): Promise<DirectoryLock> {
  await candidateWriteStep(`lock ${name}`);
  try {
    return { directory, name, handle: await open(directory.entry(`${name}.lock`), "wx", 0o666), released: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw agentXError("OPERATION_INTERRUPTED", `the repository is locked by ${join(directory.path, `${name}.lock`)}: another Git process is using it, or a crash left the file behind. Remove it if no Git process is running, then try again.`);
    }
    throw error;
  }
}

/** Writes `contents` to the lock file and renames it over its target, in the directory it was created in. */
export async function commitLock(lock: DirectoryLock, contents: string | Buffer, times?: { atime: Date; mtime: Date }): Promise<void> {
  await lock.handle.writeFile(contents);
  await lock.handle.sync();
  if (times !== undefined) await lock.handle.utimes(times.atime, times.mtime);
  await lock.handle.close();
  await candidateWriteStep(`rename ${lock.name}`);
  await rename(lock.directory.entry(`${lock.name}.lock`), lock.directory.entry(lock.name));
  lock.released = true;
}

/** Gives the lock back without changing the target (or after the caller removed the target itself). */
export async function releaseLock(lock: DirectoryLock): Promise<void> {
  if (lock.released) return;
  lock.released = true;
  await lock.handle.close().catch(() => undefined);
  await unlink(lock.directory.entry(`${lock.name}.lock`)).catch(() => undefined);
}

/** Removes the file `name` of `directory`. */
export async function removeIn(directory: HeldDirectory, name: string): Promise<void> {
  await candidateWriteStep(`remove ${name}`);
  await unlink(directory.entry(name));
}
