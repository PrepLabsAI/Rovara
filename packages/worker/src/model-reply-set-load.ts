// TE-F2 part B (M2, release 0.5.19; DECISIONS 161): where the scripted replies of a task come from, and who decides what they count as. THE WORKER DECIDES, never the sandbox.
//
// A project keeps its reply set in repo files, `.rovara/mocks/model/<family>.json`. Two reads, through a `ReplySetSource` port (one implementation here, `createRepoReplySetSource`):
//   the BASE read  the file as it is in the task's BASE COMMIT, read from the git OBJECT (never the working tree): the throwaway-repository pattern of e2e-candidate-source.ts, which runs no git inside the candidate's own
//                  repository (its config, hooks and attributes are never read). The coding agent can write the working tree and even commit to it; it cannot change the base commit.
//   the CANDIDATE read  the file as the checks will see it (the working tree): what the helper serves. Read without following a symlink, bounded, contained in the repository.
// The decision is the contracts' `decideFromBase(baseFile, candidateFile, origin)` (by CONTENT, `modelReplyEntrySha256` over id, match and response; the result is in BASE order; a base reply the candidate deleted is restored from the
// base), then `stampReplyProvenance(file, decisions)`. A candidate reply is `before_task` only when the base commit's file holds the SAME reply. Anything else (an edited reply, a new one, a reply whose base file is absent,
// unreadable or invalid) is `task_made`: allowed, served, never counted. Never stamped from ids alone. The file form has NO provenance field (the contracts' strict schema refuses one), so a file the agent wrote
// cannot say where its replies came from. `independent` is not reachable from a file: it arrives only through Rovara's own channel (`createRovaraIndependentDecision`; DECISIONS 166: the reply store R1 and the independent
// reply agent R2 are separate lanes). `IndependentReplySource` below is the typed seam where R1 will plug in; with none, nothing is `independent`.
// A family whose candidate file is absent, unreadable or invalid has NO set: every call answers "unmatched" (fail closed).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { decideFromBase, parseModelReplySetFileBytes, stampReplyProvenance, SERVED_MODEL_FAMILIES, MODEL_REPLY_SET_MAX_BYTES, type BeforeTaskOrigin, type IndependentReplyDecision, type ModelReplyFileEntry, type ModelReplySet, type ModelReplySetFile, type ReplyProvenanceDecision, type ServedModelFamily } from "@agentx/contracts";
import { candidateGitEnvironment } from "./e2e-candidate-source.js";

export const MODEL_REPLY_FILE_DIR = ".rovara/mocks/model";
export const modelReplyFilePath = (family: ServedModelFamily): string => `${MODEL_REPLY_FILE_DIR}/${family}.json`;

export type ReplyFileRead = { readonly kind: "file"; readonly bytes: Uint8Array } | { readonly kind: "absent" } | { readonly kind: "unreadable" };
export interface ReplySetSource {
  /** The family's file in the task's BASE COMMIT (a git object). */
  readBase(family: ServedModelFamily, signal: AbortSignal): Promise<ReplyFileRead>;
  /** The family's file as the checks will see it. */
  readCandidate(family: ServedModelFamily, signal: AbortSignal): Promise<ReplyFileRead>;
}

/** The seam for R1 (the reply store) and R2 (the independent reply agent): replies written during the task by the independent agent, delivered through Rovara's own channel, never a file in the sandbox. Each decision MUST come from `createRovaraIndependentDecision` (a plain object is `task_made`). No implementation exists in this lane. */
export interface IndependentReplySource {
  read(family: ServedModelFamily, signal: AbortSignal): Promise<{ readonly replies: readonly ModelReplyFileEntry[]; readonly decisions: ReadonlyMap<string, IndependentReplyDecision> } | undefined>;
}

export const REPLY_FILE_STATUSES = ["loaded", "absent", "unreadable", "invalid"] as const;
export type ReplyFileStatus = (typeof REPLY_FILE_STATUSES)[number];
export interface LoadedFamily {
  readonly family: ServedModelFamily;
  readonly status: ReplyFileStatus;
  readonly counts: { readonly before_task: number; readonly independent: number; readonly task_made: number };
}
export interface LoadedReplySets {
  readonly sets: readonly ModelReplySet[];
  readonly families: readonly LoadedFamily[];
}
export interface LoadOptions {
  /** R1's seam; absent: nothing is `independent`. */
  readonly independent?: IndependentReplySource | undefined;
  /**
   * The sub-origin recorded for a `before_task` reply of a repo file. The file form cannot say who wrote a reply, and a reply merged from an EARLIER task's agent is in the base commit too, so the honest default is
   * `repo_file_at_base`, never `customer_written`. Such a reply counts as `before_task` only because it is in the base commit; until R1's store records the real provenance of merged task-made replies (DECISIONS 166), that
   * is the most this loader can know.
   */
  readonly beforeTaskOrigin?: BeforeTaskOrigin;
}

function parseFile(read: ReplyFileRead, family: ServedModelFamily): { status: ReplyFileStatus; file?: ModelReplySetFile } {
  if (read.kind === "absent") return { status: "absent" };
  if (read.kind === "unreadable") return { status: "unreadable" };
  const parsed = parseModelReplySetFileBytes(read.bytes);
  return parsed.ok && parsed.set.family === family ? { status: "loaded", file: parsed.set } : { status: "invalid" };
}

/** The resolved reply sets of a task: the candidate's files, each reply stamped with the provenance the worker decided from the BASE commit's file. Never throws for a file it cannot read. */
export async function loadModelReplySets(source: ReplySetSource, signal: AbortSignal, options: LoadOptions = {}): Promise<LoadedReplySets> {
  const origin = options.beforeTaskOrigin ?? "repo_file_at_base";
  const sets: ModelReplySet[] = [];
  const families: LoadedFamily[] = [];
  for (const family of SERVED_MODEL_FAMILIES) {
    const candidate = parseFile(await source.readCandidate(family, signal).catch((): ReplyFileRead => ({ kind: "unreadable" })), family);
    if (candidate.file === undefined) {
      families.push({ family, status: candidate.status, counts: { before_task: 0, independent: 0, task_made: 0 } });
      continue;
    }
    const base = parseFile(await source.readBase(family, signal).catch((): ReplyFileRead => ({ kind: "unreadable" })), family);
    const decided = decideFromBase(base.file, candidate.file, origin);
    let file = decided.file;
    const decisions = new Map<string, ReplyProvenanceDecision | IndependentReplyDecision>(decided.decisions);
    // R1's seam: replies of the independent agent, delivered by Rovara. An id the file already has is never replaced by one.
    const extra = await options.independent?.read(family, signal).catch(() => undefined);
    if (extra !== undefined) {
      const known = new Set(file.replies.map((reply) => reply.id));
      const added = extra.replies.filter((reply) => !known.has(reply.id));
      file = { version: file.version, family: file.family, replies: [...file.replies, ...added] };
      for (const reply of added) {
        const decision = extra.decisions.get(reply.id);
        if (decision !== undefined) decisions.set(reply.id, decision);
      }
    }
    const set = stampReplyProvenance(file, decisions);
    const counts = { before_task: 0, independent: 0, task_made: 0 };
    for (const reply of set.replies) counts[reply.provenance] += 1;
    sets.push(set);
    families.push({ family, status: "loaded", counts });
  }
  return { sets, families };
}

// ---- the repo implementation

const SHA1 = /^[a-f0-9]{40}$/u;
const NOT_PLAIN = "repository is not a plain git directory";

async function plainDirectory(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) throw new Error(NOT_PLAIN);
}

function runGit(args: readonly string[], options: { cwd: string; signal: AbortSignal; maxBytes: number; input?: Buffer }): Promise<Buffer> {
  return new Promise<Buffer>((resolveGit, rejectGit) => {
    if (options.signal.aborted) {
      rejectGit(new Error("git was cancelled"));
      return;
    }
    const child = spawn("git", ["-c", "core.attributesFile=/dev/null", ...args], { cwd: options.cwd, env: candidateGitEnvironment(), stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        child.kill("SIGKILL");
        rejectGit(error);
      } else resolveGit(value as Buffer);
    };
    const onAbort = (): void => finish(new Error("git was cancelled"));
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > options.maxBytes) finish(new Error("git output is past its bound"));
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => undefined);
    child.once("error", () => finish(new Error("could not run git")));
    child.once("close", (code) => (code === 0 ? finish(undefined, Buffer.concat(chunks)) : finish(new Error("git failed"))));
    child.stdin.end(options.input);
  });
}

/**
 * The object directory of a repository: a plain `.git` directory, or a LINKED WORKTREE (`.git` is a file `gitdir: <path>`, whose `commondir` names the main repository's git directory, where the objects live). Every directory
 * on the way must be a real directory (no symlink). Undefined when it is neither.
 *
 * Following a `.git` file's `gitdir` and `commondir` into a place the agent controls is acceptable ONLY because every object read from there is hash-verified (`readFileAtCommit` recomputes the id of the commit, every tree on
 * the path and the blob): an agent-controlled object store can withhold an object (the file is then unreadable) but cannot make a different one pass as the base commit's.
 */
async function objectsDirectoryOf(repositoryRoot: string): Promise<string | undefined> {
  const realRepository = await realpath(repositoryRoot);
  const dotGit = join(realRepository, ".git");
  const stat = await lstat(dotGit);
  let gitDirectory = dotGit;
  if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096) {
    const match = /^gitdir: (.+)\n?$/u.exec(await readFile(dotGit, "utf8"));
    if (match === null || (match[1] as string).includes("\0")) return undefined;
    gitDirectory = await realpath(resolve(realRepository, match[1] as string));
    await plainDirectory(gitDirectory);
    const common = await readFile(join(gitDirectory, "commondir"), "utf8").then((text) => text.trim(), () => undefined);
    if (common !== undefined) {
      if (common === "" || common.includes("\0")) return undefined;
      gitDirectory = await realpath(isAbsolute(common) ? common : resolve(gitDirectory, common));
    }
  }
  const objects = join(gitDirectory, "objects");
  await plainDirectory(gitDirectory);
  await plainDirectory(objects);
  return objects.includes("\n") ? undefined : objects;
}

/**
 * One entry of a raw tree object (`<mode> <name>\0<20 raw bytes>`, repeated), found by name. The WHOLE tree is parsed and held to git's own rules: names are unique and entries are in git's order (by name, a folder as if it had a
 * trailing `/`), so an object that lists a name twice (first match would win) or out of order is `malformed`, never read. Undefined when the name is not there.
 */
function findTreeEntry(tree: Buffer, name: string): { mode: string; id: string } | "malformed" | undefined {
  let at = 0;
  let found: { mode: string; id: string } | undefined;
  let previous: Buffer | undefined;
  const names = new Set<string>();
  while (at < tree.length) {
    const space = tree.indexOf(0x20, at);
    const nul = space < 0 ? -1 : tree.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > tree.length) return "malformed";
    const mode = tree.subarray(at, space).toString("latin1");
    const nameBytes = tree.subarray(space + 1, nul);
    const entryName = nameBytes.toString("latin1");
    if (!/^\d{5,6}$/u.test(mode) || entryName === "" || names.has(entryName)) return "malformed";
    names.add(entryName);
    const key = Buffer.concat([nameBytes, Buffer.from(mode === "40000" ? "/" : "")]);
    if (previous !== undefined && Buffer.compare(previous, key) >= 0) return "malformed";
    previous = key;
    if (entryName === name) found = { mode, id: tree.subarray(nul + 1, nul + 21).toString("hex") };
    at = nul + 21;
  }
  return found;
}

/**
 * One file of a commit, read from the git OBJECT in a throwaway bare repository this worker owns (empty template, no refs, `objects/info/alternates` naming only the repository's object directory): nothing of the repository
 * except its objects is read by git. A path that is not a regular file in the commit's tree (a symlink, a directory, a submodule) is `unreadable`; a path that is not in the tree is `absent`.
 */
export async function readFileAtCommit(input: { repositoryRoot: string; commitSha: string; path: string; scratchRoot: string; maxBytes: number; signal: AbortSignal }): Promise<ReplyFileRead> {
  if (!SHA1.test(input.commitSha)) return { kind: "unreadable" };
  try {
    const objects = await objectsDirectoryOf(input.repositoryRoot);
    if (objects === undefined) return { kind: "unreadable" };
    await mkdir(input.scratchRoot, { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(input.scratchRoot, "git-"));
    try {
      const gitDir = join(work, "borrowed.git");
      await runGit(["init", "--bare", "--quiet", "--template=", gitDir], { cwd: work, signal: input.signal, maxBytes: 4096 });
      await mkdir(join(gitDir, "objects", "info"), { recursive: true });
      await writeFile(join(gitDir, "objects", "info", "alternates"), `${objects}\n`, { mode: 0o600 });
      // THE WHOLE CHAIN IS VERIFIED, not read from `ls-tree`: git checks the hash of the object a command names, but not of the subtrees it walks into, so a tree swapped in under its id (loose or packed) would point the path at
      // another valid blob. Every object on the way (the commit, the root tree, each subtree, then the blob) is read RAW with `cat-file` and its id RECOMPUTED here; the tree entries are parsed here too.
      const verified = async (type: "commit" | "tree" | "blob", id: string, limit: number): Promise<Buffer | undefined> => {
        const bytes = await runGit([`--git-dir=${gitDir}`, "cat-file", type, id], { cwd: work, signal: input.signal, maxBytes: limit });
        return createHash("sha1").update(Buffer.concat([Buffer.from(`${type} ${String(bytes.length)}\0`), bytes])).digest("hex") === id ? bytes : undefined;
      };
      const commit = await verified("commit", input.commitSha, 65_536);
      const rootId = commit === undefined ? null : /^tree ([0-9a-f]{40})\n/u.exec(commit.toString("latin1"))?.[1];
      if (rootId === null || rootId === undefined) return { kind: "unreadable" };
      let treeId = rootId;
      const parts = input.path.split("/");
      for (const [index, part] of parts.entries()) {
        const tree = await verified("tree", treeId, 1024 * 1024);
        if (tree === undefined) return { kind: "unreadable" };
        const entry = findTreeEntry(tree, part);
        if (entry === "malformed") return { kind: "unreadable" };
        if (entry === undefined) return { kind: "absent" };
        const last = index === parts.length - 1;
        // a folder on the way is a tree; the leaf is a regular file (a symlink, a submodule or a folder is not)
        if (last ? entry.mode !== "100644" && entry.mode !== "100755" : entry.mode !== "40000") return { kind: "unreadable" };
        treeId = entry.id;
      }
      const bytes = await verified("blob", treeId, input.maxBytes);
      if (bytes === undefined) return { kind: "unreadable" };
      return { kind: "file", bytes };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  } catch {
    return { kind: "unreadable" };
  }
}

/** One file of the working tree, without following a symlink (not the file, not any folder on the way), contained in the root, at most `maxBytes`. */
export async function readFileInWorkingTree(root: string, path: string, maxBytes: number, hooks: { readonly beforeOpen?: () => void | Promise<void> } = {}): Promise<ReplyFileRead> {
  try {
    let current = await realpath(root);
    const parts = path.split("/");
    let leaf: Awaited<ReturnType<typeof lstat>> | undefined;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" || error.code === "ENOTDIR" ? undefined : null));
      if (stat === null) return { kind: "unreadable" };
      if (stat === undefined) return { kind: "absent" };
      if (stat.isSymbolicLink()) return { kind: "unreadable" };
      if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.size > maxBytes) return { kind: "unreadable" };
      leaf = stat;
    }
    // Read through the descriptor of the file that was checked: opened without following a link, and the same inode as the one lstat saw (a swap between the check and the open is refused).
    await hooks.beforeOpen?.();
    const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > maxBytes || leaf === undefined || opened.ino !== leaf.ino || opened.dev !== leaf.dev) return { kind: "unreadable" };
      const bytes = Buffer.alloc(opened.size);
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return read === bytes.length ? { kind: "file", bytes } : { kind: "unreadable" };
    } finally {
      await handle.close();
    }
  } catch {
    return { kind: "unreadable" };
  }
}

export interface RepoReplySetSourceInput {
  /** The repository whose `.git` holds the base commit. */
  readonly repositoryRoot: string;
  /** The task's BASE commit (full lowercase hex), pinned by the broker, never the agent's head. */
  readonly baseCommit: string;
  /** Where the checks run: the working tree the helper's replies come from. */
  readonly workingRoot: string;
  /** A worker-owned scratch directory for the throwaway repository. */
  readonly scratchRoot: string;
}
/** The one `ReplySetSource`: repo files, the base side from the base commit's git object, the candidate side from the working tree. */
export function createRepoReplySetSource(input: RepoReplySetSourceInput): ReplySetSource {
  return {
    readBase: (family, signal) => readFileAtCommit({ repositoryRoot: input.repositoryRoot, commitSha: input.baseCommit, path: modelReplyFilePath(family), scratchRoot: input.scratchRoot, maxBytes: MODEL_REPLY_SET_MAX_BYTES, signal }),
    readCandidate: (family) => readFileInWorkingTree(input.workingRoot, modelReplyFilePath(family), MODEL_REPLY_SET_MAX_BYTES),
  };
}
