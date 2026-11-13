// TE-F8 phase A (design te-f1 section 6, DECISIONS 163b D6): the task-scoped recording store on disk. Files live under ONE directory the caller gives (the task's run directory on a worker, the task's state folder on a laptop) and
// nowhere else: mode 0600 for files and 0700 for directories, removed with the run directory and at task end (`deleteTask`), and swept for what a crash left (`sweep`). Nothing is sent to S3, the broker or the PR; a laptop's file
// is never uploaded.
//
// Layout: <root>/<sha256("company:" + companyId)>/<sha256("task:" + taskId)>/<key>.rec. Names are lower-case hex only (no id ever becomes a path part, and a case-insensitive file system cannot merge two of them), so company B
// can never name company A's directory, and the same task id under two companies is two directories.
//
// This file names no port or adapter type: it stores `RecordingEntry` values from the contracts and nothing else. Every method is scoped by company; an entry whose own header names another company or task than its path is a
// miss. A file that is a link, is not a regular file, has group or world permission bits, is too large, or does not parse as exactly an entry is removed and is a miss. An expired entry is removed and is a miss.
import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  RECORDING_ANSWER_BYTES_MAX, RECORDING_STORE_TASK_CACHE, RECORDING_TASK_ENTRIES_MAX, checkRecordingEntry, checkRecordingScope, entryFromFileText, entryToFile, indexRowOf, type RecordingEntry, type RecordingIndexRow, type RecordingScope,
  type RecordingStore, type RecordingStoreWord,
} from "@agentx/contracts";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/** A file is at most the answer limit as base64 plus its fixed fields. */
const FILE_BYTES_MAX = Math.ceil((RECORDING_ANSWER_BYTES_MAX * 4) / 3) + 64 * 1024;
const ENTRY_NAME = /^[a-f0-9]{64}\.rec$/u;
const TEMP_NAME = /^[a-f0-9]{64}\.rec\.[a-f0-9]{16}\.tmp$/u;
const DIR_NAME = /^[a-f0-9]{64}$/u;
/** A temp file older than this is a crash leftover; a younger one may be a write in progress. */
const TEMP_MAX_AGE_MS = 60_000;

const hex = (label: string, value: string): string => createHash("sha256").update(`${label}:${value}`).digest("hex");
export const recordingCompanyDirName = (companyId: string): string => hex("company", companyId);
export const recordingTaskDirName = (taskId: string): string => hex("task", taskId);

export interface TaskRecordingStoreOptions {
  /** The directory every recording lives under (created 0700 when missing). It should be inside the task's run directory. */
  readonly root: string;
  readonly now: () => number;
  readonly word?: RecordingStoreWord;
}

/** True when the file belongs to the user running this process (always true where the platform has no user ids). */
function ownedByUs(info: Pick<Stats, "uid">): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined || info.uid === uid;
}

async function safeStat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

/** Creates a directory (and no other) with mode 0700 whatever the umask; never follows a link in the last part. */
async function ensureDir(path: string): Promise<void> {
  const held = await safeStat(path);
  if (held !== undefined) {
    // A directory we did not make (a link, or one owned by someone else) is not a place to put a recording.
    if (!held.isDirectory() || !ownedByUs(held)) throw new Error("the recording store path is not a directory of ours");
    return;
  }
  await mkdir(path, { mode: DIR_MODE });
  await chmod(path, DIR_MODE);
}

export function createTaskRecordingStore(options: TaskRecordingStoreOptions): RecordingStore {
  const { root, now } = options;
  const dirsOf = (scope: RecordingScope): { company: string; task: string } => {
    const company = join(root, recordingCompanyDirName(scope.companyId));
    return { company, task: join(company, recordingTaskDirName(scope.taskId)) };
  };
  const checked = (scope: RecordingScope): RecordingScope => {
    const held = checkRecordingScope(scope);
    if (held === undefined) throw new Error("the recording scope is not usable");
    return held;
  };
  const validKey = (key: string): boolean => /^[a-f0-9]{64}$/u.test(key);

  async function readEntry(scope: RecordingScope, key: string, remove: boolean): Promise<RecordingEntry | undefined> {
    const path = join(dirsOf(scope).task, `${key}.rec`);
    const drop = async (): Promise<undefined> => {
      if (remove) await rm(path, { force: true });
      return undefined;
    };
    // Open without following a link, then judge the OPEN file (not the path, which can change between a look and a read) and read from the same handle.
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return code === "ELOOP" || code === "EMLINK" ? drop() : undefined;
    }
    let text: string | undefined;
    let trusted: boolean;
    try {
      const info = await handle.stat();
      trusted = info.isFile() && (info.mode & 0o077) === 0 && info.size <= FILE_BYTES_MAX && ownedByUs(info);
      if (trusted) text = await handle.readFile("utf8");
    } catch {
      return undefined;
    } finally {
      await handle.close().catch(() => undefined);
    }
    // A link, a directory, a world-readable file, someone else's file or a huge one is not ours: remove it.
    if (!trusted || text === undefined) return drop();
    const parsed = entryFromFileText(text);
    if (parsed === undefined || parsed.scope.companyId !== scope.companyId || parsed.scope.taskId !== scope.taskId || parsed.entry.key !== key) return drop();
    if (parsed.entry.expiresAtMs <= now()) return drop();
    return parsed.entry;
  }

  /** Writes a temp file through its own handle (mode set on the handle, never on a path), then renames it into place. With `create` false a missing task directory is a failure, so a deleted task is never brought back. */
  async function writeEntry(scope: RecordingScope, entry: RecordingEntry, create: boolean): Promise<void> {
    const { company, task } = dirsOf(scope);
    if (create) {
      await ensureDir(root);
      await ensureDir(company);
      await ensureDir(task);
    }
    const final = join(task, `${entry.key}.rec`);
    const temp = `${final}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    try {
      await handle.chmod(FILE_MODE);
      await handle.writeFile(JSON.stringify(entryToFile(scope, entry)));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temp, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await rename(temp, final);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async function readSweepEntry(path: string, info: Stats): Promise<ReturnType<typeof entryFromFileText>> {
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > FILE_BYTES_MAX) return undefined;
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return undefined;
    }
    try {
      const held = await handle.stat();
      return held.isFile() && (held.mode & 0o077) === 0 && held.size <= FILE_BYTES_MAX && ownedByUs(held) ? entryFromFileText(await handle.readFile("utf8")) : undefined;
    } catch {
      return undefined;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function entryNames(taskDir: string): Promise<string[]> {
    try {
      return (await readdir(taskDir)).filter((name) => ENTRY_NAME.test(name)).sort();
    } catch {
      return [];
    }
  }

  async function countFiles(path: string): Promise<number> {
    let total = 0;
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (DIR_NAME.test(name)) total += await countFiles(join(path, name));
      else if (ENTRY_NAME.test(name)) total += 1;
    }
    return total;
  }

  return {
    word: options.word ?? RECORDING_STORE_TASK_CACHE,
    async get(scopeValue, key) {
      const scope = checked(scopeValue);
      return validKey(key) ? readEntry(scope, key, true) : undefined;
    },
    async put(scopeValue, entry) {
      const scope = checked(scopeValue);
      const refused = checkRecordingEntry(entry, now());
      if (refused !== undefined) throw new Error(`recording refused: ${refused}`);
      const held = await entryNames(dirsOf(scope).task);
      if (!held.includes(`${entry.key}.rec`) && held.length >= RECORDING_TASK_ENTRIES_MAX) throw new Error("recording refused: too_many");
      await writeEntry(scope, entry, true);
    },
    async list(scopeValue) {
      const scope = checked(scopeValue);
      const rows: RecordingIndexRow[] = [];
      for (const name of await entryNames(dirsOf(scope).task)) {
        const entry = await readEntry(scope, name.slice(0, 64), true);
        if (entry !== undefined) rows.push(indexRowOf(entry));
      }
      return rows;
    },
    async markReplayed(scopeValue, key) {
      const scope = checked(scopeValue);
      if (!validKey(key)) return 0;
      const entry = await readEntry(scope, key, true);
      if (entry === undefined) return 0;
      try {
        // Never brings a deleted task back: a missing directory is a failure, and the count stays 0.
        await writeEntry(scope, { ...entry, replayCount: entry.replayCount + 1 }, false);
      } catch {
        return 0;
      }
      return entry.replayCount + 1;
    },
    async deleteTask(scopeValue) {
      const scope = checked(scopeValue);
      const { task } = dirsOf(scope);
      const count = await countFiles(task);
      await rm(task, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
      return count;
    },
    async eraseCompany(companyId) {
      const scope = checkRecordingScope({ companyId, taskId: "erase" });
      if (scope === undefined) throw new Error("the recording scope is not usable");
      const { company } = dirsOf(scope);
      const count = await countFiles(company);
      await rm(company, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
      return count;
    },
    async sweep() {
      let removed = 0;
      let companies: string[];
      try {
        companies = (await readdir(root)).filter((name) => DIR_NAME.test(name)).sort();
      } catch {
        return 0;
      }
      for (const companyName of companies) {
        const companyDir = join(root, companyName);
        let tasks: string[];
        try {
          tasks = (await readdir(companyDir)).filter((name) => DIR_NAME.test(name)).sort();
        } catch {
          continue;
        }
        for (const taskName of tasks) {
          const taskDir = join(companyDir, taskName);
          let names: string[];
          try {
            names = (await readdir(taskDir)).sort();
          } catch {
            continue;
          }
          for (const name of names) {
            const path = join(taskDir, name);
            const info = await safeStat(path);
            if (info === undefined) continue;
            if (TEMP_NAME.test(name)) {
              if (now() - info.mtimeMs > TEMP_MAX_AGE_MS) {
                await rm(path, { force: true });
                removed += 1;
              }
            } else if (ENTRY_NAME.test(name)) {
              const parsed = await readSweepEntry(path, info);
              if (parsed === undefined || parsed.entry.expiresAtMs <= now()) {
                await rm(path, { force: true });
                removed += 1;
              }
            }
          }
          // Non-recursive: a directory that is not empty (a write began meanwhile, or a file that is not ours) stays.
          await rmdir(taskDir).catch(() => undefined);
        }
        await rmdir(companyDir).catch(() => undefined);
      }
      return removed;
    },
  };
}
