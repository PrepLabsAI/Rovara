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
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decideFromBase, parseModelReplySetFileBytes, stampReplyProvenance, SERVED_MODEL_FAMILIES, MODEL_REPLY_SET_MAX_BYTES, type IndependentReplyDecision, type ModelReplyFileEntry, type ModelReplySet, type ModelReplySetFile, type ReplyProvenanceDecision, type ServedModelFamily } from "@agentx/contracts";
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
  /** The sub-origin recorded for a `before_task` reply of a repo file (the file form cannot say; default `customer_written`). */
  readonly beforeTaskOrigin?: "customer_written" | "setup_agent_from_fakes" | "real_recording_capped" | "prompt_and_expected_shape";
}

function parseFile(read: ReplyFileRead, family: ServedModelFamily): { status: ReplyFileStatus; file?: ModelReplySetFile } {
  if (read.kind === "absent") return { status: "absent" };
  if (read.kind === "unreadable") return { status: "unreadable" };
  const parsed = parseModelReplySetFileBytes(read.bytes);
  return parsed.ok && parsed.set.family === family ? { status: "loaded", file: parsed.set } : { status: "invalid" };
}

/** The resolved reply sets of a task: the candidate's files, each reply stamped with the provenance the worker decided from the BASE commit's file. Never throws for a file it cannot read. */
export async function loadModelReplySets(source: ReplySetSource, signal: AbortSignal, options: LoadOptions = {}): Promise<LoadedReplySets> {
  const origin = options.beforeTaskOrigin ?? "customer_written";
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
 * One file of a commit, read from the git OBJECT in a throwaway bare repository this worker owns (empty template, no refs, `objects/info/alternates` naming only the repository's object directory): nothing of the repository
 * except its objects is read by git. A path that is not a regular file in the commit's tree (a symlink, a directory, a submodule) is `unreadable`; a path that is not in the tree is `absent`.
 */
export async function readFileAtCommit(input: { repositoryRoot: string; commitSha: string; path: string; scratchRoot: string; maxBytes: number; signal: AbortSignal }): Promise<ReplyFileRead> {
  if (!SHA1.test(input.commitSha)) return { kind: "unreadable" };
  try {
    const realRepository = await realpath(input.repositoryRoot);
    const gitDirectory = join(realRepository, ".git");
    const objects = join(gitDirectory, "objects");
    await plainDirectory(gitDirectory);
    await plainDirectory(objects);
    if (objects.includes("\n")) return { kind: "unreadable" };
    await mkdir(input.scratchRoot, { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(input.scratchRoot, "git-"));
    try {
      const gitDir = join(work, "borrowed.git");
      await runGit(["init", "--bare", "--quiet", "--template=", gitDir], { cwd: work, signal: input.signal, maxBytes: 4096 });
      await mkdir(join(gitDir, "objects", "info"), { recursive: true });
      await writeFile(join(gitDir, "objects", "info", "alternates"), `${objects}\n`, { mode: 0o600 });
      const listing = (await runGit([`--git-dir=${gitDir}`, "ls-tree", "-z", "--full-tree", `${input.commitSha}^{tree}`, "--", input.path], { cwd: work, signal: input.signal, maxBytes: 65_536 })).toString("utf8");
      if (listing === "") return { kind: "absent" };
      const entry = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)\0$/su.exec(listing);
      if (entry === null || entry[4] !== input.path || entry[2] !== "blob" || (entry[1] !== "100644" && entry[1] !== "100755")) return { kind: "unreadable" };
      const sha = entry[3] as string;
      const size = Number((await runGit([`--git-dir=${gitDir}`, "cat-file", "-s", sha], { cwd: work, signal: input.signal, maxBytes: 64 })).toString("utf8").trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > input.maxBytes) return { kind: "unreadable" };
      const bytes = await runGit([`--git-dir=${gitDir}`, "cat-file", "blob", sha], { cwd: work, signal: input.signal, maxBytes: input.maxBytes });
      return { kind: "file", bytes };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  } catch {
    return { kind: "unreadable" };
  }
}

/** One file of the working tree, without following a symlink (not the file, not any folder on the way), contained in the root, at most `maxBytes`. */
export async function readFileInWorkingTree(root: string, path: string, maxBytes: number): Promise<ReplyFileRead> {
  try {
    let current = await realpath(root);
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" || error.code === "ENOTDIR" ? undefined : null));
      if (stat === null) return { kind: "unreadable" };
      if (stat === undefined) return { kind: "absent" };
      if (stat.isSymbolicLink()) return { kind: "unreadable" };
      if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.size > maxBytes) return { kind: "unreadable" };
    }
    return { kind: "file", bytes: await readFile(current) };
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
