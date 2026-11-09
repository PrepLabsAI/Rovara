// Port lane L4: the local state folder (`~/.rovara`) and the owner-only files in it.
//
// Everything `rovara up` keeps (the plug-in config, the model keys, the session token, the key that signs worker invocations,
// the workspaces) lives in one folder that only the machine's owner can enter. Files in it are opened once with O_NOFOLLOW and
// checked and read through that one handle, so a link or a swap between the check and the read cannot lead somewhere else.
// Errors say nothing about the content of a file.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const STATE_DIRECTORY_NAME = ".rovara";
export const CONFIG_FILE_NAME = "config.json";
export const KEYS_FILE_NAME = "keys.json";
export const SESSION_TOKEN_FILE_NAME = "session-token";
export const INVOKE_KEY_FILE_NAME = "invoke-key.pem";
export const WORKSPACES_DIRECTORY_NAME = "workspaces";

export class LocalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStateError";
  }
}

const hasModes = process.platform !== "win32";
const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

export function defaultStateDirectory(home: string): string {
  return join(home, STATE_DIRECTORY_NAME);
}

/**
 * Makes the state folder (mode 0700) or checks the one that is there: a real folder (not a link), owned by this user, that no one
 * else can write to. Returns the folder's real path.
 */
export async function ensureStateDirectory(path: string): Promise<string> {
  const target = resolve(path);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const details = await lstat(target);
  if (details.isSymbolicLink() || !details.isDirectory()) throw new LocalStateError(`${target} must be a plain folder, not a link`);
  const uid = currentUid();
  if (hasModes && uid !== undefined && details.uid !== uid) throw new LocalStateError(`${target} must belong to you`);
  if (hasModes && (details.mode & 0o022) !== 0) throw new LocalStateError(`${target} must not be writable by other users (chmod 700 ${target})`);
  return target;
}

export interface OwnerFile {
  text: string;
}

/**
 * Reads a file only its owner may use: not a link, a plain file, owned by this user, and (when `private` is set) with no access for
 * group or others. Returns undefined when there is no such file.
 */
export async function readOwnerFile(path: string, options: { private: boolean; label: string; maxBytes?: number }): Promise<OwnerFile | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LocalStateError(`the ${options.label} could not be opened (it must be a plain file, not a link)`);
  }
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new LocalStateError(`the ${options.label} must be a plain file`);
    const uid = currentUid();
    if (hasModes && uid !== undefined && details.uid !== uid) throw new LocalStateError(`the ${options.label} must belong to you`);
    if (hasModes && options.private && (details.mode & 0o077) !== 0) throw new LocalStateError(`the ${options.label} must not be readable by other users (chmod 600)`);
    if (hasModes && !options.private && (details.mode & 0o022) !== 0) throw new LocalStateError(`the ${options.label} must not be writable by other users (chmod 600)`);
    if (details.size > (options.maxBytes ?? 1_048_576)) throw new LocalStateError(`the ${options.label} is too large`);
    return { text: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}

/**
 * Writes a file with mode 0600 from the start (never wider, even for a moment) by writing a new file next to it and renaming it
 * into place. `exclusive` refuses to replace an existing file (used for the first-run config).
 */
export async function writeOwnerFile(path: string, text: string, options: { exclusive?: boolean } = {}): Promise<void> {
  const temporary = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    if (options.exclusive === true) {
      // `link` fails if the name exists, so a file made in the meantime is never overwritten.
      await link(temporary, path);
      await rm(temporary, { force: true });
    } else {
      await rename(temporary, path);
    }
  } catch (error) {
    await rm(temporary, { force: true });
    if (options.exclusive === true && (error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  if (hasModes) await chmod(path, 0o600);
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
  if (!insideState && isInside(resolve(input.cwd), path)) {
    throw new LocalStateError(`the plug-in config ${path} lies inside the folder you are in; a config can run code, so keep it in ${state} (never in a repository)`);
  }
  return { path, isDefault };
}

function isInside(parent: string, child: string): boolean {
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
