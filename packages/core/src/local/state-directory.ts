// Port lane L4: the local state folder (`~/.rovara`) and the owner-only files in it.
//
// Everything `rovara up` keeps (the plug-in config, the model keys, the session token, the key that signs worker invocations,
// the workspaces) lives in one folder that only the machine's owner can enter. Files in it are opened once with O_NOFOLLOW and
// checked and read through that one handle, so a link or a swap between the check and the read cannot lead somewhere else.
// Errors say nothing about the content of a file.
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalStateError, ensurePrivateDirectory, readOwnerFile, writeOwnerFile } from "../connections/owner-files.js";

export { LocalStateError, ensurePrivateDirectory, readOwnerFile, writeOwnerFile, type OwnerFile } from "../connections/owner-files.js";

export const STATE_DIRECTORY_NAME = ".rovara";
export const CONFIG_FILE_NAME = "config.json";
export const KEYS_FILE_NAME = "keys.json";
export const SESSION_TOKEN_FILE_NAME = "session-token";
export const INVOKE_KEY_FILE_NAME = "invoke-key.pem";
/** The key the callback capabilities and repository grants are signed with (lane L9-wire). */
/** The SQLite file the default storage and queue keep everything in (lane L9-wire). */
export const STATE_DB_FILE_NAME = "state.db";
/** The append-only audit log (port lane P6, item L2): its own SQLite file, apart from the task records. */
export const AUDIT_DB_FILE_NAME = "audit.db";
/** Where a running `rovara up` says where it listens, for `rovara open` (removed when it stops). */
/** The lock a running `rovara up` holds on the state folder (its pid). */
export const STATE_LOCK_FILE_NAME = "up.lock";
export const SERVER_FILE_NAME = "server.json";
export const CALLBACK_KEY_FILE_NAME = "callback-key";
export const WORKSPACES_DIRECTORY_NAME = "workspaces";

export function defaultStateDirectory(home: string): string {
  return join(home, STATE_DIRECTORY_NAME);
}

/**
 * The state folder: private, and not inside the folder the owner is standing in or inside any git work tree below the home folder.
 * A repository can carry a folder with a config in it, and a config can run code; naming one by `--state-dir` must not be enough.
 */
export async function ensureStateDirectory(path: string, options: { cwd: string; home?: string }): Promise<string> {
  const target = resolve(path);
  await assertStateDirectoryLocation(target, options);
  return ensurePrivateDirectory(target);
}

/** Where the state folder may be (see `ensureStateDirectory`); makes nothing. */
export async function assertStateDirectoryLocation(target: string, options: { cwd: string; home?: string }): Promise<void> {
  const cwd = resolve(options.cwd);
  if (target === resolve(defaultStateDirectory(options.home ?? homedir()))) return;
  if (isInside(cwd, target) || target === cwd) {
    throw new LocalStateError(`the state folder ${target} lies inside the folder you are in; it can hold a config that runs code, so keep it in ${defaultStateDirectory(options.home ?? homedir())} (never in a repository)`);
  }
  const home = resolve(options.home ?? homedir());
  for (let folder = target; ; folder = dirname(folder)) {
    if (folder === home || dirname(folder) === folder) break;
    if (await lstat(join(folder, ".git")).then(() => true, () => false)) {
      throw new LocalStateError(`the state folder ${target} lies inside a git work tree (${folder}); keep it in ${defaultStateDirectory(home)}`);
    }
  }
}

/** The config a first run writes: no plug-ins, so the built-in defaults run. */
export const FIRST_RUN_CONFIG = `${JSON.stringify({ version: 1, plugins: [] }, null, 2)}\n`;

export interface ConfigLocation {
  path: string;
  /** True when the path is the default inside the state folder, which `up` may create on first run. */
  isDefault: boolean;
}

/**
 * Where the plug-in config may come from. It is owner-controlled: naming a module runs its code in the broker. So it is read only
 * from the state folder or from a path the owner typed (`--config`), never found by searching, and never from inside the project
 * the owner is standing in (`cwd`), which may hold files a repository (or a pull request) supplied.
 */
export function resolveConfigLocation(input: { stateDirectory: string; configPath?: string | undefined; cwd: string }): ConfigLocation {
  const state = resolve(input.stateDirectory);
  const path = input.configPath === undefined ? join(state, CONFIG_FILE_NAME) : resolve(input.cwd, input.configPath);
  const isDefault = input.configPath === undefined;
  const insideState = isInside(state, path);
  // Tasks write into the workspaces; nothing there is the owner's.
  if (isInside(join(state, WORKSPACES_DIRECTORY_NAME), path)) {
    throw new LocalStateError(`the plug-in config ${path} lies inside a task workspace; a config can run code, so keep it in ${state}`);
  }
  if (!insideState && isInside(resolve(input.cwd), path)) {
    throw new LocalStateError(`the plug-in config ${path} lies inside the folder you are in; a config can run code, so keep it in ${state} (never in a repository)`);
  }
  return { path, isDefault };
}

export function isInside(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference !== "" && !difference.startsWith("..") && !isAbsolute(difference) && !difference.startsWith(`..${sep}`);
}

/** Reads the config text, making the first-run file when the default is missing. */
export async function readConfigText(location: ConfigLocation): Promise<string> {
  let file = await readOwnerFile(location.path, { private: false, label: "plug-in config" });
  if (file === undefined) {
    if (!location.isDefault) throw new LocalStateError(`the plug-in config ${location.path} does not exist`);
    await writeOwnerFile(location.path, FIRST_RUN_CONFIG, { exclusive: true });
    file = await readOwnerFile(location.path, { private: false, label: "plug-in config" });
    if (file === undefined) throw new LocalStateError("the plug-in config could not be created");
  }
  return file.text;
}
