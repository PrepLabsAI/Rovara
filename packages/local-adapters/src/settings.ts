// Port lane L3: reading a plug-in's block of the config file (`PluginContext.settings`). The config is owner-controlled, but a typo in
// it should be named, not ignored, so unknown settings are refused. No secret is ever read here.
import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { PluginRegistryError, type JsonObject, type JsonValue } from "@agentx/contracts";

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export function allowOnly(settings: JsonObject, allowed: readonly string[]): void {
  for (const key of Object.keys(settings)) if (!allowed.includes(key)) throw new SettingsError(`unknown setting ${JSON.stringify(key).slice(0, 40)}`);
}

export function optionalNumber(settings: JsonObject, key: string, minimum: number, maximum: number): number | undefined {
  const value: JsonValue | undefined = settings[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new SettingsError(`${key} is a whole number from ${minimum} to ${maximum}`);
  return value;
}

/** The fixed part of the refusal of a store path inside a git work tree (TE-D10a). The sentence also names the path and the state folder. */
export const STORE_PATH_IN_REPOSITORY_SENTENCE = "is inside a git repository, which a commit or a push could publish; choose a path outside any git repository, or a bare file name such as \"state.db\", which is kept in the state folder";

export interface DatabasePathOptions {
  /** The install's own folder (`PluginContext.stateDirectory`). A relative path is kept under it. Absent: `~/.rovara`. */
  stateDirectory?: string;
}

/**
 * The database file. A relative path is kept under the state folder (`~/.rovara` by default), not the folder the process runs in, so a
 * documented `state.db` can never put the database inside a repository. An absolute path is kept as it is. A path inside a git work
 * tree is refused. `:memory:` is refused: a configured store keeps its data.
 *
 * Moving from the old rule: if a relative path would now point somewhere else, a SQLite database is still where the old rule put it
 * and nothing is at the new place, the start is refused with what to move. Quietly opening an empty database would look like lost data.
 * Nothing is moved or deleted here.
 */
export function databasePath(settings: JsonObject, options: DatabasePathOptions = {}): string {
  const value = settings.path;
  if (typeof value !== "string" || value === "" || value.includes("\u0000")) throw new SettingsError("path is the database file, as text");
  if (value === ":memory:" || value.startsWith("file:")) throw new SettingsError("path is a file path (not :memory: or a file: URL)");
  const stateDirectory = resolve(options.stateDirectory ?? join(homedir(), ".rovara"));
  const path = isAbsolute(value) ? value : resolve(stateDirectory, value);
  assertOutsideGitWorkTree(path, stateDirectory);
  if (!isAbsolute(value)) {
    const old = resolve(value);
    if (old !== path && isSqliteFile(old) && !exists(path)) {
      throw new PluginRegistryError("create_failed", `Rovara's database moved: stop Rovara, then move ${old} and its -wal and -shm files to ${path} (or delete them on purpose), or give an absolute path outside any repository.`);
    }
  }
  return path;
}

/** True when the file starts with the SQLite header, "SQLite format 3" and a NUL. Anything that cannot be read is not counted. */
function isSqliteFile(path: string): boolean {
  let handle: number | undefined;
  try {
    handle = openSync(path, "r");
    const header = Buffer.alloc(16);
    return readSync(handle, header, 0, 16, 0) === 16 && header.equals(Buffer.from("SQLite format 3\u0000", "latin1"));
  } catch {
    return false;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** The real path of `path`, whether or not the file or its folders exist yet. A link that leads nowhere, or anything unreadable, throws. */
function realPathOfNearest(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Nothing there: if even the name itself is a (dangling) link, where it leads is unknown, so fail closed.
  try {
    lstatSync(path);
    throw new Error("dangling link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  if (parent === path) throw new Error("no folder to start from");
  return join(realPathOfNearest(parent), basename(path));
}

/**
 * Refuses a store path whose real location (links resolved) has a `.git` file or folder in any folder above it: a work tree, a linked
 * work tree and a submodule all have one. It reads the folders itself instead of asking `git`, so inherited `GIT_DIR`, `GIT_WORK_TREE`
 * or pathspec variables cannot change the answer. The state folder is vetted by the install, so the walk stops there (a home folder that
 * is itself a repository, as with dotfiles, does not make `~/.rovara` unusable). Anything that cannot be read is refused.
 */
function assertOutsideGitWorkTree(path: string, stateDirectory: string): void {
  const shown = JSON.stringify(path.slice(0, 300));
  let real: string;
  let realState: string | undefined;
  try {
    real = realPathOfNearest(path);
    realState = (() => {
      try {
        return realPathOfNearest(stateDirectory);
      } catch {
        return undefined;
      }
    })();
  } catch {
    throw new PluginRegistryError("create_failed", `the database path ${shown} could not be checked, so it is refused; choose a path outside any git repository, or a bare file name such as "state.db", which is kept in the state folder`);
  }
  try {
    for (let folder = dirname(real); ; folder = dirname(folder)) {
      if (folder === realState) return;
      let found = true;
      try {
        lstatSync(join(folder, ".git"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        found = false;
      }
      if (found) throw new PluginRegistryError("create_failed", `the database path ${shown} ${STORE_PATH_IN_REPOSITORY_SENTENCE} (${JSON.stringify(stateDirectory.slice(0, 300))})`);
      if (dirname(folder) === folder) return;
    }
  } catch (error) {
    if (error instanceof PluginRegistryError) throw error;
    throw new PluginRegistryError("create_failed", `the database path ${shown} could not be checked, so it is refused; choose a path outside any git repository, or a bare file name such as "state.db", which is kept in the state folder`);
  }
}

export function synchronousSetting(settings: JsonObject): "FULL" | "NORMAL" | undefined {
  const value = settings.synchronous;
  if (value === undefined) return undefined;
  if (value !== "FULL" && value !== "NORMAL") throw new SettingsError("synchronous is FULL or NORMAL");
  return value;
}
