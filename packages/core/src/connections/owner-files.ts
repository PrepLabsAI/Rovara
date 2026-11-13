// The owner-only file primitives (port lane L4), apart from the rest of the local state folder: a private folder, a file only its owner may read, and a file written with
// mode 0600 from the start. They need nothing of the laptop app, and the per-org connection secrets (`connections/local-secrets.ts`) use them, so they live in core and
// `local/state-directory.ts` re-exports them. Files are opened once with O_NOFOLLOW and checked and read through that one handle, so a link or a swap between the check and
// the read cannot lead somewhere else. Errors say nothing about the content of a file.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";

export class LocalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStateError";
  }
}

const hasModes = process.platform !== "win32";
const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/**
 * Makes a private folder (mode 0700) or checks the one that is there: a real folder (not a link), owned by this user, that no
 * one else can enter or write (mode 0700 or tighter). Returns the folder's real path.
 */
export async function ensurePrivateDirectory(path: string): Promise<string> {
  const target = resolve(path);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const details = await lstat(target);
  if (details.isSymbolicLink() || !details.isDirectory()) throw new LocalStateError(`${target} must be a plain folder, not a link`);
  const uid = currentUid();
  if (hasModes && uid !== undefined && details.uid !== uid) throw new LocalStateError(`${target} must belong to you`);
  if (hasModes && (details.mode & 0o077) !== 0) throw new LocalStateError(`${target} must be private to you (chmod 700 ${target})`);
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
