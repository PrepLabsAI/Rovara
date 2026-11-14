// The change tier's input from the code host: the files of each change request of a task, read as the host reports them (never what an agent says), and the commits the tier is bound to.
// A host that gives no patch text for a file leaves it unreadable, and the classifier then treats the file as risky (fail closed); the port is not changed.
import { createHash } from "node:crypto";
import type { ChangeRequestFile, CodeHost, HostScope, WorkflowSnapshot } from "@agentx/contracts";
import { changedFilesFromHostFiles, plainChangedPath } from "../proof/changed-files.js";
import { TIER_ENTRY_KINDS, TIER_REASON_CODES, canonicalPatchText, factKey, tierFromDiff, type DiffInput, type HeadFacts, type TierEntryKind, type TierFile, type TierFileEntry, type TierReason } from "../decisions/change-tier.js";
import { DOCS_SITE_PROBES, fileTypeOf, normalizedTierPath } from "../decisions/sensitive-list.js";
import { changeRequestRef, readChangeRequestFiles } from "./host-port.js";

export interface TierReadTarget {
  host: CodeHost;
  repositoryId: string;
  repositoryUrl: string;
  number: number;
}

const isEntryKind = (value: unknown): value is TierEntryKind => typeof value === "string" && (TIER_ENTRY_KINDS as readonly string[]).includes(value);

/**
 * The file's entry type as the host reported it (DEC 182: `entry: { head, base }` on a changed file), read defensively: a host that does not report it, or reports anything malformed, gives undefined, which the
 * classifier treats as NOT KNOWN (never as an ordinary file).
 */
export function entryOfHostFile(file: ChangeRequestFile): TierFileEntry | undefined {
  const raw = (file as ChangeRequestFile & { entry?: unknown }).entry;
  if (typeof raw !== "object" || raw === null) return undefined;
  const { head, base } = raw as { head?: unknown; base?: unknown };
  return isEntryKind(head) && isEntryKind(base) ? { head, base } : undefined;
}

/** The tier files of one change request's host list. The routes and response schemas the diff touches are read the way the risk rules read them. */
export function tierFilesOfRead(repositoryId: string, read: { files: readonly ChangeRequestFile[]; complete: boolean }): { files: TierFile[]; complete: boolean } {
  const parsed = changedFilesFromHostFiles(repositoryId, read.files, read.complete);
  const api = new Set(parsed.files.filter((entry) => entry.apiShapeChanged === true).map((entry) => `${entry.renamedFrom ?? ""}\u0000${entry.path}`));
  return {
    complete: read.complete && read.files.every((file) => plainChangedPath(file.path) && (file.previousPath === undefined || plainChangedPath(file.previousPath))),
    files: read.files.map((file) => {
      const entry = entryOfHostFile(file);
      return {
        repository: repositoryId, path: file.path, ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }), status: file.status, additions: file.additions, deletions: file.deletions,
        ...(file.patch === undefined ? {} : { patch: file.patch }), ...(api.has(`${file.previousPath ?? ""}\u0000${file.path}`) ? { apiShapeChanged: true } : {}), ...(entry === undefined ? {} : { entry }),
      };
    }),
  };
}

/** The instruction files whose imports are read at the head: a document one of them reads is an instruction, whatever its name. */
const INSTRUCTION_ROOTS = [
  "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md", "AGENT.md", "GEMINI.md", "WARP.md", ".github/copilot-instructions.md", ".cursorrules", ".windsurfrules", ".clinerules",
  // Cursor's rules folder cannot be listed through the port: its usual file names are asked for by name.
  ".cursor/rules/main.mdc", ".cursor/rules/index.mdc", ".cursor/rules/rules.mdc", ".cursor/rules/project.mdc", ".cursor/rules/general.mdc", ".cursor/rules/global.mdc", ".cursor/rules/default.mdc", ".cursor/rules/coding.mdc",
  ".cursor/rules/repo.mdc", ".cursor/rules/main.md", ".cursor/rules/rules.md", ".claude/CLAUDE.md",
] as const;
/** Folders where instruction files live and that the port cannot list: when one exists there may be files in it that were not read, and no document is cleared as plain docs. */
const INSTRUCTION_FOLDERS = [".cursor", ".claude", ".github/instructions", ".windsurf", ".clinerules", ".continue", ".agents", ".codex", ".openhands", ".kilocode", ".amazonq", ".kiro", ".gemini", ".roo", ".cline", ".trae", ".junie"] as const;
/** The instruction files an agent reads in the folders of the files it works on. */
const NESTED_INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"] as const;
const INSTRUCTION_READ_MAX_BYTES = 100_000;
const DOCUMENT_READ_MAX_BYTES = 200_000;
/** The most host reads one tier spends on facts beyond the file list. */
const DOCUMENTS_READ_MAX = 20;
const PATH_KINDS_READ_MAX = 40;
const NESTED_FOLDERS_MAX = 30;
/** Imports are followed this many links deep (Claude's own limit is five); a longer chain is not followed, and what cannot be followed is not cleared. */
const IMPORT_DEPTH_MAX = 5;
const IMPORTED_FILES_MAX = 40;

/**
 * The paths an instruction file names, in any form: `@path` imports, Markdown inline and reference links, HTML `href` and `src`, and a path written in plain words ("read docs/rules.md"). Each is resolved against the file's
 * folder and against the repository root (an agent may read either), and written in the normalized form.
 */
export function importsOf(instructionPath: string, text: string): string[] {
  const folder = instructionPath.includes("/") ? instructionPath.slice(0, instructionPath.lastIndexOf("/") + 1) : "";
  const targets = [
    ...[...text.matchAll(/(?:^|[\s(])@([\w@./-]+\.[A-Za-z0-9]{1,6})\b/gu)].map((match) => match[1]!),
    ...[...text.matchAll(/\]\(<?([^)#\s>]+)(?:#[^)\s]*)?>?[^)]*\)/gu)].map((match) => match[1]!),
    ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>#]+)/gmu)].map((match) => match[1]!),
    ...[...text.matchAll(/\b(?:href|src)\s*=\s*["']([^"'#]+)/giu)].map((match) => match[1]!),
    ...[...text.matchAll(/(?:^|[\s("'`<])((?:[\w@.-]+\/)*[\w@.-]+\.(?:md|mdx|markdown|rst|adoc|txt|ya?ml|json|toml))(?=$|[\s)"'`>,.;:])/gmu)].map((match) => match[1]!),
  ];
  const out = new Set<string>();
  for (const target of targets) {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    for (const base of target.startsWith("/") ? [""] : folder === "" ? [""] : [folder, ""]) {
      const resolved: string[] = [];
      for (const part of `${base}${target.replace(/^\//u, "")}`.split("/")) { if (part === "..") resolved.pop(); else if (part !== "." && part !== "") resolved.push(part); }
      out.add(normalizedTierPath(resolved.join("/")));
    }
  }
  return [...out];
}

export interface TierReadInput { diff: DiffInput; head: HeadFacts }

/**
 * What the host knows of the code at each head commit, beyond the file list: the text of the documents the change touches (so the section a changed line sits in is known), which paths the instruction files import, and
 * which paths are symbolic links. A path kind the host cannot answer THROWS (the caller refuses, or leaves the tier unwritten); a document or an instruction file that cannot be read leaves that fact unknown, and the rules
 * then do not clear the document as plain docs. `files` are the tier files already read (each names its repository).
 */
export async function readHeadFacts(targets: ReadonlyArray<TierReadTarget & { headSha: string }>, files: readonly TierFile[], scope: HostScope, beforeRequest?: () => void): Promise<HeadFacts> {
  const text = new Map<string, string>();
  const imports = new Set<string>();
  const links = new Set<string>();
  const submodules = new Set<string>();
  const unchecked = new Set<string>();
  let importsKnown: boolean | undefined;
  let docsSite: boolean | undefined;
  for (const target of targets) {
    const ref = changeRequestRef(target.repositoryUrl, target.number);
    const all = files.filter((file) => file.repository === target.repositoryId);
    const listed = all.filter((file) => file.status !== "removed");
    // Documents: the text at the head, so a changed line's heading and block are known. Past the limit the text is not read, and the document is then not cleared.
    const documents = listed.filter((file) => fileTypeOf(file.path) === "prose").slice(0, DOCUMENTS_READ_MAX);
    for (const document of documents) {
      beforeRequest?.();
      const body = await target.host.fileAtRevision(ref.repository, document.path, target.headSha, scope, { maxBytes: DOCUMENT_READ_MAX_BYTES }).catch(() => undefined);
      if (body !== undefined) text.set(factKey(target.repositoryId, document.path), body);
    }
    // A document (changed, added OR removed) may be read by an instruction file, and may be built into a documentation site.
    if (all.some((file) => fileTypeOf(file.path) === "prose" || (file.previousPath !== undefined && fileTypeOf(file.previousPath) === "prose"))) {
      importsKnown ??= true;
      const exists = async (path: string): Promise<boolean> => {
        beforeRequest?.();
        try {
          if (target.host.pathKind !== undefined) return (await target.host.pathKind(ref.repository, path, target.headSha, scope)) !== "none";
          return (await target.host.fileAtRevision(ref.repository, path, target.headSha, scope, { maxBytes: 2_000_000 })) !== undefined;
        } catch {
          return true; // it could not be asked: it may be there
        }
      };
      const read = async (path: string): Promise<{ body: string | undefined } | undefined> => {
        beforeRequest?.();
        try { return { body: await target.host.fileAtRevision(ref.repository, path, target.headSha, scope, { maxBytes: INSTRUCTION_READ_MAX_BYTES }) }; } catch { return undefined; }
      };
      // Instruction files: the roots, the ones in the folders of the changed files, then what each of them imports, to a depth of five.
      const folders = [...new Set(all.flatMap((file) => [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])]).flatMap((path) => {
        const parts = path.split("/").slice(0, -1);
        return parts.map((_part, index) => parts.slice(0, index + 1).join("/"));
      }))];
      if (folders.length > NESTED_FOLDERS_MAX) importsKnown = false;
      const nested = folders.slice(0, NESTED_FOLDERS_MAX).flatMap((folder) => NESTED_INSTRUCTION_NAMES.map((name) => `${folder}/${name}`));
      const queue: Array<{ path: string; depth: number }> = [...INSTRUCTION_ROOTS, ...nested].map((path) => ({ path, depth: 0 }));
      const seen = new Set<string>();
      let followed = 0;
      while (queue.length > 0) {
        const { path, depth } = queue.shift()!;
        if (seen.has(path)) continue;
        seen.add(path);
        if (depth > 0 && ++followed > IMPORTED_FILES_MAX) { importsKnown = false; break; }
        const got = await read(path);
        if (got === undefined) { importsKnown = false; continue; }
        const body = got.body;
        if (body === undefined) continue;
        for (const imported of importsOf(path, body)) {
          imports.add(factKey(target.repositoryId, imported));
          if (depth + 1 > IMPORT_DEPTH_MAX) importsKnown = false;
          else if (!seen.has(imported) && fileTypeOf(imported) !== "code") queue.push({ path: imported, depth: depth + 1 });
        }
      }
      // A folder that holds instruction files and cannot be listed may hold files that were not read.
      for (const folder of INSTRUCTION_FOLDERS) if (await exists(folder)) importsKnown = false;
      // A repository that builds a documentation site compiles or runs its documents.
      docsSite = false;
      for (const probe of DOCS_SITE_PROBES) if (await exists(probe)) { docsSite = true; break; }
    }
    // Symbolic links, where the host can tell (the port's own optional read).
    if (target.host.pathKind !== undefined) {
      for (const file of listed.slice(0, PATH_KINDS_READ_MAX)) {
        beforeRequest?.();
        const kind = await target.host.pathKind(ref.repository, file.path, target.headSha, scope);
        if (kind === "symlink") links.add(factKey(target.repositoryId, file.path));
        // A changed path that is a directory at the head is a submodule (a host reads a submodule as a directory).
        if (kind === "dir") submodules.add(factKey(target.repositoryId, file.path));
      }
      // Past the limit the kind is not asked: unknown is risky, never "not a link".
      for (const file of listed.slice(PATH_KINDS_READ_MAX)) unchecked.add(factKey(target.repositoryId, file.path));
    }
  }
  return { text, instructionImports: imports, ...(importsKnown === undefined ? {} : { importsKnown }), links, submodules, unchecked, ...(docsSite === undefined ? {} : { docsSite }) };
}

/** What the tier is computed from: the files of every change request of the task (as the host lists them), and the facts of `readHeadFacts`. A host that cannot answer THROWS. */
export async function readTierInput(targets: ReadonlyArray<TierReadTarget & { headSha: string }>, scope: HostScope, beforeRequest?: () => void): Promise<TierReadInput> {
  const files: TierFile[] = [];
  let complete = true;
  for (const target of targets) {
    const read = tierFilesOfRead(target.repositoryId, await readChangeRequestFiles(target.host, changeRequestRef(target.repositoryUrl, target.number), scope, beforeRequest));
    complete &&= read.complete;
    files.push(...read.files);
  }
  return { diff: { files, complete: complete && targets.length > 0 }, head: await readHeadFacts(targets, files, scope, beforeRequest) };
}

const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;
const digestOf = (lines: readonly string[]): string => createHash("sha1").update(lines.join("\n")).digest("hex");

/**
 * The head commit and the merge base a tier is bound to. One repository whose commit ids have 40 hex characters: its own head and the base commit the task's code was built on. Anything else (several repositories, or a repository
 * whose ids have 64 characters, as SHA-256 repositories do) is bound by a 40-hex digest of each repository's name, head and base, in repository order, so any push to any of them changes it. A base that is not known (or any head that
 * is not a commit id) is left out; the tier is then bound to the head alone.
 */
export function boundCommits(entries: ReadonlyArray<{ repositoryId: string; headSha: string; baseCommitSha?: string | undefined }>): { headSha?: string; mergeBase?: string } {
  const sorted = [...entries].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  const isId = (value: string | undefined): value is string => value !== undefined && (SHA40.test(value) || SHA64.test(value));
  if (sorted.length === 0 || sorted.some((entry) => !isId(entry.headSha))) return {};
  const baseKnown = sorted.every((entry) => isId(entry.baseCommitSha));
  if (sorted.length === 1 && SHA40.test(sorted[0]!.headSha) && (!baseKnown || SHA40.test(sorted[0]!.baseCommitSha!))) return { headSha: sorted[0]!.headSha, ...(baseKnown ? { mergeBase: sorted[0]!.baseCommitSha! } : {}) };
  return {
    headSha: digestOf(sorted.map((entry) => `${entry.repositoryId}\u0000${entry.headSha}`)),
    ...(baseKnown ? { mergeBase: digestOf(sorted.map((entry) => `${entry.repositoryId}\u0000${entry.baseCommitSha!}`)) } : {}),
  };
}

/**
 * What the reviewer floor is given, read from the code host at the pinned head by the same read the merge gate makes: the paths and the patch text in the one canonical form (`canonicalPatchText`), so the digest the floor
 * records is the digest the gate recomputes. A caller never builds the patch text itself.
 */
export async function readReviewInput(targets: ReadonlyArray<TierReadTarget & { headSha: string }>, scope: HostScope, beforeRequest?: () => void): Promise<{ files: string[]; patchText: string; diff: DiffInput }> {
  const read = await readTierInput(targets, scope, beforeRequest);
  return { files: read.diff.files.map((file) => file.path), patchText: canonicalPatchText(read.diff.files), diff: read.diff };
}

// ---- versions pushed between checks

/** How many commits are visited, in all, looking for the versions the task has already seen; past it, the commits are counted as not scanned. */
export const UNSEEN_WALK_MAX = 20;
/**
 * The forms Rovara writes a head in, each anchored at the start of the check's detail: the head is read only from the first match, never from text that follows (a patch line copied into a detail can carry any sha).
 * `review level=...` and `tier_review level=...` (the review records), `tier_questions`, and the quick checks' own forms (`docs secret scan`, `code_config tests ...`, `dependency source`, `dependency install in the test run ...`, `install_link`, `ci_file reviewer questions (...) ...`).
 */
const OWN_HEAD_IN_DETAIL = /^(?:(?:tier_)?review level=\w+|tier_questions|docs secret scan|install_link|dependency source|dependency install in the test run \w+|code_config tests \w+|ci_file reviewer questions \([^)]*\) (?:not )?answered) head=([a-f0-9]{40})\b/u;

/**
 * Every commit the task has seen and checked, from its own record: the heads it recorded for its pull requests (and the heads they were synced from), the base and candidate commits, the heads its tiers were bound to,
 * and the heads named by its checks in the forms Rovara itself writes (`OWN_HEAD_IN_DETAIL`). A tier bound to a digest (several repositories) names no commit, so the pull requests' recorded heads are what count there.
 */
export function seenHeadsOf(workflow: Pick<WorkflowSnapshot, "pullRequests" | "reviewBase" | "candidate" | "flow">): Set<string> {
  const seen = new Set<string>();
  const add = (value: string | undefined): void => { if (value !== undefined && SHA40.test(value)) seen.add(value); };
  for (const entry of workflow.pullRequests ?? []) { add(entry.headSha); add(entry.syncedFrom); }
  for (const entry of workflow.reviewBase ?? []) add(entry.baseCommitSha);
  for (const entry of workflow.candidate?.repositories ?? []) { add(entry.commitSha); add(entry.baseCommitSha); }
  const flow = workflow.flow;
  for (const tier of [...(flow?.tierHistory ?? []), ...(flow?.tier === undefined ? [] : [flow.tier])]) { add(tier.headSha); add(tier.mergeBase); }
  for (const check of flow?.quickChecks ?? []) add(OWN_HEAD_IN_DETAIL.exec(check.detail ?? "")?.[1]);
  return seen;
}

/** The base commits the task recorded, by repository: the history below them is the base branch's, not the task's (a merge of the base branch brings it in as a second parent). */
export function baseCommitsOf(workflow: Pick<WorkflowSnapshot, "reviewBase" | "candidate">): Map<string, string[]> {
  const bases = new Map<string, string[]>();
  const add = (repositoryId: string, value: string | undefined): void => {
    if (value === undefined || !SHA40.test(value)) return;
    const list = bases.get(repositoryId) ?? [];
    if (!list.includes(value)) list.push(value);
    bases.set(repositoryId, list);
  };
  for (const entry of workflow.reviewBase ?? []) add(entry.repositoryId, entry.baseCommitSha);
  for (const entry of workflow.candidate?.repositories ?? []) add(entry.repositoryId, entry.baseCommitSha);
  return bases;
}

/** DEC 213: the most parents a commit pushed between checks may have (an ordinary commit or a two-parent merge); a commit with more is not scanned, and the head is escalated. */
export const COMMIT_PARENTS_MAX = 2;
/** The most commits read from the base branch's history (its current head, and the recorded base commits, down): those commits are the base branch's, not the task's. */
export const BASE_HISTORY_READS_MAX = 40;
/** The risky reason codes of the rules (the ones before the first standard one). */
const RISKY_CODES: ReadonlySet<string> = new Set<string>(TIER_REASON_CODES.slice(0, TIER_REASON_CODES.indexOf("more_than_lines")));
/** Risky reasons that do not flag one commit read on its own: an empty commit, its size (the size of the final diff is what counts), a hint, and the walk's own reasons. */
const NOT_A_COMMIT_FLAG: ReadonlySet<string> = new Set(["no_diff_files", "large_change", "eval_hint", "incomplete_diff", "unscanned_commits", "unseen_commit_flagged"]);
/**
 * What a MERGE commit's own text can add. Its listed diff (against its first parent) also holds everything the other parents brought in (a newer base branch, a side branch whose commits are walked on their own), so the
 * paths in it are not the merge's: only text added in it counts (a key written while resolving a conflict).
 */
const MERGE_CONTENT_CODES: ReadonlySet<string> = new Set(["secret_like_text", "reviewer_injection_text", "bidi_control", "invisible_character", "line_break_character", "confusable_text"]);
const COMMIT_SCAN_AT = new Date(0).toISOString();

/** A commit pushed between checks whose own diff the rules flagged, with the risky reasons it was flagged for (paths as the host listed them; never the flagged text). */
export interface FlaggedCommit { repositoryId: string; commit: string; reasons: TierReason[] }
export interface UnseenCommitsRead {
  /** Commits found between the heads and the versions the task saw. */
  count: number;
  /** A path ended without reaching a seen commit (the first commit), or the walk read more than `UNSEEN_WALK_MAX` commits: what was pushed is not known at all. */
  capped: boolean;
  /** Commits found whose own diff could not be scanned: the host has no `commitChanges` or could not answer it, it cut the file list, or the commit has more parents than `COMMIT_PARENTS_MAX`. */
  unscanned: number;
  /** The commits whose own diff was flagged. */
  flagged: FlaggedCommit[];
}

/** The reasons one commit's own diff is flagged for (empty: clean), or undefined when its list is not whole (not scanned). A merge is flagged only by text added in it (`MERGE_CONTENT_CODES`). */
export function commitFlagsOf(repositoryId: string, read: { files: readonly ChangeRequestFile[]; complete: boolean }, merge: boolean): TierReason[] | undefined {
  const files = tierFilesOfRead(repositoryId, read);
  if (!files.complete) return undefined;
  const tier = tierFromDiff({ files: files.files, complete: true }, { at: COMMIT_SCAN_AT });
  return tier.reasons.filter((reason) => RISKY_CODES.has(reason.code) && !NOT_A_COMMIT_FLAG.has(reason.code) && (!merge || MERGE_CONTENT_CODES.has(reason.code)));
}

/**
 * The commits between each current head and the versions below it that the task saw (`seenHeadsOf`), along EVERY parent (a person's merge of another branch brings its commits in by a second parent; one first-parent line would
 * miss them): a breadth-first walk that stops each path at a seen commit, reading at most `UNSEEN_WALK_MAX` commits in all. Those versions were pushed between two checks and no tier read them: a credential added in one and
 * taken out in the next leaves a clean final diff. So each one is scanned on its OWN diff (DEC 213: the host's `commitChanges`, the same rules as the head's: secret-like text, risky paths, file mode and type), and only a
 * flagged one counts against the head (`flagged`).
 * The base branch's history counts as seen: the commits at and below the recorded base commits, and those reachable from the base branch's CURRENT head (`target.baseBranch`, read once, at most `BASE_HISTORY_READS_MAX`
 * commits): GitHub's "Update branch" merges a newer base-branch head in as a second parent, and those commits were reviewed when they landed there. A host that cannot list a commit's parents THROWS (the caller leaves the
 * record as it was); a host that cannot give a commit's changes leaves that commit `unscanned`.
 */
export async function unseenCommits(
  targets: ReadonlyArray<TierReadTarget & { headSha: string; baseBranch?: string | undefined }>, seen: ReadonlySet<string>, scope: HostScope, beforeRequest?: () => void, bases: ReadonlyMap<string, readonly string[]> = new Map(),
): Promise<UnseenCommitsRead> {
  let count = 0;
  let capped = false;
  let unscanned = 0;
  const flagged: FlaggedCommit[] = [];
  for (const target of targets) {
    const repository = { url: target.repositoryUrl };
    const parentsOf = async (commit: string): Promise<string[]> => { beforeRequest?.(); return target.host.commitParents(repository, commit, scope); };
    // The base branch's history (at most `BASE_HISTORY_READS_MAX` reads), found once, when the walk first meets a commit it has not seen.
    let baseHistory: Set<string> | undefined;
    const baseHistoryOf = async (): Promise<Set<string>> => {
      if (baseHistory !== undefined) return baseHistory;
      const found = new Set(bases.get(target.repositoryId) ?? []);
      baseHistory = found;
      const queue = [...found];
      if (target.baseBranch !== undefined) {
        try {
          beforeRequest?.();
          const current = await target.host.baseBranchHead(repository, target.baseBranch, scope);
          if (SHA40.test(current) && !found.has(current)) { found.add(current); queue.unshift(current); }
        } catch { /* the base branch's head could not be read: its newer commits are walked as the task's */ }
      }
      for (let step = 0; step < BASE_HISTORY_READS_MAX && queue.length > 0; step += 1) {
        for (const parent of await parentsOf(queue.shift()!)) if (!found.has(parent)) { found.add(parent); queue.push(parent); }
      }
      return found;
    };
    /** One unseen commit, scanned on its own diff: its parents (from the same read when it answers), and whether it was scanned. */
    const scan = async (commit: string): Promise<string[]> => {
      const read = target.host.commitChanges === undefined ? undefined : await (async () => {
        beforeRequest?.();
        try {
          const answer = await target.host.commitChanges!(repository, commit, scope);
          return Array.isArray(answer.parents) && answer.parents.every((parent) => typeof parent === "string" && SHA40.test(parent)) && Array.isArray(answer.files) ? answer : undefined;
        } catch { return undefined; }
      })();
      const parents = read?.parents ?? await parentsOf(commit);
      const flags = read === undefined || read.complete !== true || parents.length > COMMIT_PARENTS_MAX ? undefined : commitFlagsOf(target.repositoryId, read, parents.length > 1);
      if (flags === undefined) unscanned += 1;
      else if (flags.length > 0) flagged.push({ repositoryId: target.repositoryId, commit, reasons: flags });
      return parents;
    };
    // The head itself is walked from even when it was seen (tiered): its own unseen ancestors are its own reason on every pass. Its own changes are the change request's (read whole), so it is not scanned again.
    const visited = new Set<string>([target.headSha]);
    const queue: Array<{ commit: string; head: boolean }> = [{ commit: target.headSha, head: true }];
    let reads = 0;
    while (queue.length > 0) {
      if (reads >= UNSEEN_WALK_MAX) { capped = true; break; }
      const next = queue.shift()!;
      const parents = next.head ? await parentsOf(next.commit) : await scan(next.commit);
      reads += 1;
      // A path that ends at the first commit without meeting a seen one: nothing says what was pushed.
      if (parents.length === 0) { capped = true; continue; }
      // More parents than the limit (an octopus merge): not scanned (counted above for an unseen one; the head's own counts here), and not walked.
      if (parents.length > COMMIT_PARENTS_MAX) { if (next.head) unscanned += 1; continue; }
      for (const parent of parents) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        if (seen.has(parent) || (await baseHistoryOf()).has(parent)) continue;
        count += 1;
        queue.push({ commit: parent, head: false });
      }
    }
  }
  return { count, capped, unscanned, flagged };
}
