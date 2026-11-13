// N9 (INTG2) fix round 1 (B2, S1): the guard that keeps a registry token out of everything the agent can read.
//
// After EVERY command of a preparation that holds a registry token (a setup step or a readiness check, whether it succeeded or failed), the workspace is searched for the token:
//   - the whole workspace root, not only the repositories: gitignored files (`.env.local`, `node_modules/.cache`), `.agentx-python`, a folder at the root: anything the agent's file
//     tools can read. Skipped: Rovara's own private folders (the config folder of this session, `.agentx`, `agent-sessions`, Docker's data root, the verifier's runtime backing) and
//     `.git/objects` (compressed);
//   - for the tokens of THIS session in every spelling a tool could write them (the same forms the scrubber knows), and for every token EVER issued for this workspace by its hashes.
//     The hashes are kept in the worker's private state for the workspace's life (`.agentx/registry-issued-tokens.json`, mode 0600, hidden from the task sandbox). A hash record holds the
//     first and last four characters, the length and the SHA-256 of the raw token and of its percent-encoded form: enough to recognise a copy, not to rebuild the token;
//   - only files whose inode changed since the session opened are read again (ctime cannot be set by `cp -p` or `tar`), except at the start, when a retry reads everything for the old tokens.
// A hit, or a scan that cannot finish (too many files, too many bytes, too long, an unreadable folder) is a leak: the preparation stops and the workspace is TAINTED (prepare.ts), so
// no later attempt resumes it. The next attempt starts from a fresh clone.
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { REGISTRY_TOKEN_MIN_LENGTH, e2eSecretSpellings } from "@rovara-code/contracts";
import { DOCKER_DATA_DIRECTORY, RUNTIME_BACKING_DIRECTORY } from "./devcontainer-policy.js";

export const ISSUED_TOKENS_PATH = ".agentx/registry-issued-tokens.json";
/** Worker-private folders of the workspace root: never scanned (the worker's own state), never wiped with a tainted workspace. */
export const PRIVATE_ROOT_FOLDERS: readonly string[] = [".agentx", "agent-sessions", DOCKER_DATA_DIRECTORY, RUNTIME_BACKING_DIRECTORY, "lost+found"];

export class RegistryTokenLeakError extends Error {
  constructor(message = "A setup step left a package registry token where the agent can read it, so the preparation was stopped and the workspace will be set up again from a fresh clone") {
    super(message);
    this.name = "RegistryTokenLeakError";
  }
}

export const SCAN_LIMITS = { files: 600_000, bytes: 6 * 1024 ** 3, milliseconds: 180_000 } as const;
const CHUNK_BYTES = 4 * 1024 * 1024;

export interface IssuedTokenRecord { length: number; head: string; tail: string; sha256: string }
const sha = (text: string): string => createHash("sha256").update(text, "latin1").digest("hex");
const recordOf = (text: string): IssuedTokenRecord => ({ length: text.length, head: text.slice(0, 4), tail: text.slice(-4), sha256: sha(text) });
/** The records of one token: its raw form and its percent-encoded form (what a pip.conf carries). */
export const issuedRecordsOf = (token: string): IssuedTokenRecord[] => {
  const encoded = encodeURIComponent(token);
  return encoded === token ? [recordOf(token)] : [recordOf(token), recordOf(encoded)];
};

export async function readIssuedTokens(rootPath: string): Promise<IssuedTokenRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(resolve(rootPath), ISSUED_TOKENS_PATH), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is IssuedTokenRecord => typeof item === "object" && item !== null && typeof (item as IssuedTokenRecord).length === "number" && typeof (item as IssuedTokenRecord).sha256 === "string"
      && typeof (item as IssuedTokenRecord).head === "string" && typeof (item as IssuedTokenRecord).tail === "string");
  } catch {
    return [];
  }
}

/** Adds the records of `tokens` to the workspace's list (kept for its life). The file is private to the worker. */
export async function recordIssuedTokens(rootPath: string, tokens: readonly string[]): Promise<void> {
  const root = resolve(rootPath);
  const known = await readIssuedTokens(root);
  const seen = new Set(known.map((record) => record.sha256));
  const next = [...known, ...tokens.flatMap(issuedRecordsOf).filter((record) => !seen.has(record.sha256))];
  const directory = join(root, ".agentx");
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `registry-issued-tokens.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, join(root, ISSUED_TOKENS_PATH));
}

/** Whether `text` holds a token recorded in `records`: a window of the record's length starting at its head and ending in its tail, with the recorded hash. */
function hasRecordedToken(text: string, records: readonly IssuedTokenRecord[]): boolean {
  for (const record of records) {
    let from = text.indexOf(record.head);
    while (from !== -1) {
      const end = from + record.length;
      if (end <= text.length && text.endsWith(record.tail, end) && sha(text.slice(from, end)) === record.sha256) return true;
      from = text.indexOf(record.head, from + 1);
    }
  }
  return false;
}

export interface ScanInput {
  rootPath: string;
  /** Absolute folders not read (this session's config folder). The worker-private root folders are always skipped. */
  skip: readonly string[];
  /** The tokens of this session, as text. */
  secrets: readonly string[];
  /** The records of tokens issued for this workspace before. */
  issued: readonly IssuedTokenRecord[];
  /** Only files whose inode changed at or after this time (ms) are read; 0 reads everything. */
  changedSinceMs: number;
  /** Where an unfinished scan says why (a fixed code). Default: the worker's log. */
  log?: (event: Record<string, unknown>) => void;
}

/** True when a token is anywhere the agent can read; throws RegistryTokenLeakError when the search cannot finish (an unfinished search is not a clean one). */
export async function workspaceHoldsToken(input: ScanInput): Promise<boolean> {
  const root = resolve(input.rootPath);
  const forms = [...new Set(input.secrets.filter((secret) => secret.length >= REGISTRY_TOKEN_MIN_LENGTH).flatMap((secret) => e2eSecretSpellings(secret)).filter((form) => form.length >= 6))].map((form) => Buffer.from(form));
  if (forms.length === 0 && input.issued.length === 0) return false;
  const overlap = Math.max(1, ...forms.map((form) => form.length), ...input.issued.map((record) => record.length)) - 1;
  const skipped = new Set([...PRIVATE_ROOT_FOLDERS.map((name) => join(root, name)), ...input.skip.map((path) => resolve(path))]);
  const started = Date.now();
  let files = 0;
  let bytes = 0;
  // The reason is a fixed code (never a path): it is logged so an admin can see why a very large tree keeps being cloned again.
  const unfinished = (reason: "files" | "bytes" | "time" | "unreadable"): never => {
    (input.log ?? ((event) => { console.log(JSON.stringify({ component: "worker", ...event })); }))({ event: "registry.scan_unfinished", reason });
    throw new RegistryTokenLeakError("Rovara could not finish checking that no package registry token was left in the workspace, so the preparation was stopped and the workspace will be set up again from a fresh clone");
  };

  const chunkHolds = (chunk: Buffer): boolean => forms.some((form) => chunk.includes(form)) || (input.issued.length > 0 && hasRecordedToken(chunk.toString("latin1"), input.issued));

  const fileHolds = async (path: string, size: number): Promise<boolean> => {
    if (size === 0) return false;
    bytes += size;
    if (bytes > SCAN_LIMITS.bytes) unfinished("bytes");
    // A file that cannot be opened (a mode of 000, a read error) could hold the token: an unread file is an unfinished scan. Only a file that vanished meanwhile is skipped.
    const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : unfinished("unreadable"));
    if (handle === undefined) return false;
    try {
      let carry: Buffer = Buffer.alloc(0);
      for (let position = 0; position < size;) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position).catch(() => unfinished("unreadable"));
        if (bytesRead === 0) break;
        position += bytesRead;
        const chunk = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
        if (chunkHolds(chunk)) return true;
        carry = chunk.subarray(Math.max(0, chunk.length - overlap));
      }
      return false;
    } finally {
      await handle.close();
    }
  };

  const walk = async (directory: string): Promise<boolean> => {
    if (Date.now() - started > SCAN_LIMITS.milliseconds) unfinished("time");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return unfinished("unreadable");
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (skipped.has(path)) continue;
      // `.git/objects` holds compressed objects; a copy of a token appears in the working tree first.
      if (entry.name === "objects" && directory.endsWith(`${"/"}.git`)) continue;
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : unfinished("unreadable"));
      if (info === undefined) continue;
      if (info.isDirectory()) {
        if (await walk(path)) return true;
      } else if (info.isFile()) {
        files += 1;
        if (files > SCAN_LIMITS.files) unfinished("files");
        if (info.ctimeMs >= input.changedSinceMs && await fileHolds(path, info.size)) return true;
      }
      // A link is not followed (what it points at is read where it lives, or is outside the workspace).
    }
    return false;
  };
  return walk(root);
}

/**
 * A tainted workspace is never resumed: everything the project's code made is removed, leaving the worker's private state, and the next attempt clones again. The files are made
 * writable first (a setup step may have made a folder read-only to keep a copy alive).
 */
export async function wipeWorkspaceForTaint(rootPath: string): Promise<void> {
  const root = resolve(rootPath);
  const keep = new Set(PRIVATE_ROOT_FOLDERS);
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (keep.has(name)) continue;
    await removeTree(join(root, name));
  }
}

/** `rm -rf`, after making every folder of the tree writable and searchable; a tree that still cannot be removed throws. */
export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  if (await lstat(path).then(() => false, () => true)) return;
  const open = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700).catch(() => undefined);
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await open(join(directory, entry.name));
    }
  };
  await open(path);
  await rm(path, { recursive: true, force: true });
  if (!(await lstat(path).then(() => false, () => true))) throw new Error("a folder could not be removed");
}

// ---- .git (the objects are compressed, so a committed, stashed or hashed token is not found by the walk above)

/**
 * A digest of each `.git` folder's history and objects: HEAD, packed-refs, every file under refs/ (branches, tags, the stash), the loose object ids and the pack names. Index and worktree
 * files are not part of it (the walk reads those). A `.git` that is a file (a worktree or submodule link) is its text. Folders named `node_modules` and the worker's private ones are not entered.
 * After a setup or readiness command, any difference from the digests taken before the first command (a new commit, ref, stash or object, a new or removed repository) taints the workspace:
 * a token committed or stashed would otherwise ride into a pull request inside compressed objects. Not covered: a repository created under `node_modules`, and archives (documented).
 */
export async function gitStates(rootPath: string): Promise<Map<string, string>> {
  const root = resolve(rootPath);
  const states = new Map<string, string>();
  const skip = new Set(PRIVATE_ROOT_FOLDERS.map((name) => join(root, name)));
  const digestOf = async (gitDir: string): Promise<string> => {
    const hash = createHash("sha256");
    const read = async (path: string): Promise<string> => readFile(path, "utf8").catch(() => "");
    hash.update(`HEAD\0${await read(join(gitDir, "HEAD"))}\0packed\0${await read(join(gitDir, "packed-refs"))}\0`);
    const refs: string[] = [];
    const walkRefs = async (directory: string): Promise<void> => {
      for (const entry of (await readdir(directory, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walkRefs(path);
        else if (entry.isFile()) refs.push(`${path.slice(gitDir.length)}=${await read(path)}`);
      }
    };
    await walkRefs(join(gitDir, "refs"));
    hash.update(`${refs.join("\n")}\0objects\0`);
    const objects: string[] = [];
    for (const entry of await readdir(join(gitDir, "objects"), { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name)) objects.push(...(await readdir(join(gitDir, "objects", entry.name)).catch(() => [])).map((id) => `${entry.name}${id}`));
      else if (entry.isDirectory() && entry.name === "pack") objects.push(...(await readdir(join(gitDir, "objects", "pack")).catch(() => [])).map((name) => `pack/${name}`));
    }
    hash.update(objects.sort().join("\n"));
    return hash.digest("hex");
  };
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (skip.has(path) || entry.name === "node_modules") continue;
      if (entry.name === ".git") {
        const relative = path.slice(root.length);
        if (entry.isDirectory()) states.set(relative, await digestOf(path));
        else if (entry.isFile()) states.set(relative, `file:${createHash("sha256").update(await readFile(path, "utf8").catch(() => "")).digest("hex")}`);
        continue;
      }
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return states;
}

/** True when the repositories' history or objects differ from `before`: a changed digest, a new `.git`, or a removed one. */
export function gitStatesDiffer(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): boolean {
  if (before.size !== after.size) return true;
  for (const [path, digest] of before) if (after.get(path) !== digest) return true;
  return false;
}

export const GIT_CHANGED_MESSAGE = "A setup step changed a repository's history or objects (a commit, branch, tag, stash or object), where a package registry token could ride into a pull request, so the preparation was stopped and the workspace will be set up again from a fresh clone";
