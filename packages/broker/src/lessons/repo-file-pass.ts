// The weekly pass that proposes Rovara's `.rovara/lessons.md` for ONE repository through ONE batched pull request.
// This WRITES TO A CUSTOMER'S REPOSITORY, so every rule below is also a test:
//   - It makes NO model call: rendering, comparing and the reasons come from counters and rules. It runs only while lessons are switched on and the project's mode allows loading; while they are off, nothing is
//     opened, closed or changed (the reads and the state are untouched).
//   - Only lessons eligible for THIS repository go in (`planRepoFile`); the file is changed only by this pull request, which a person merges.
//   - One pass per repository at a time (a lease), at most one pass a week. An unchanged proposal opens nothing; the same proposals as the open pull request leave it alone.
//   - A new proposal goes on a NEW branch `rovara/lessons-<12 random hex>`: nothing is adopted, a branch that exists is never written to, the commit's parent is the default branch head the file was read at, and the ref is
//     moved without force. The previous Rovara pull request is closed and its branch deleted afterwards, so at most one Rovara lessons pull request is open per repository.
//   - A pull request a person pushed to (its head is not where Rovara left it) is theirs: never closed, never deleted, nothing new is opened beside it. A person's own pull request or branch is never looked at at all.
//   - Every host write is audited BEFORE it is made, and a failed audit skips the write (nothing is urgent by construction).
//   - After 3 weekly pull requests in a row that nobody merged, additions and edits stop; removals still go out, in a smaller pull request.
//   - A file the team deleted pauses the repository; a file that is a link, a folder, over 64 KB or unreadable is left alone, and the status says why. Nothing is retired on a failed read.
import { createHash } from "node:crypto";
import {
  COMMIT_CONFLICT_MESSAGE, COMMIT_SYMLINK_MESSAGE, LESSON_FILE_MAX_BYTES, LESSON_FILE_PATH, LESSON_FILE_POINTER_PATHS,
  type LessonFileProblem,
} from "@agentx/contracts";
import { modeAllows, requireAudit, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import { mentionsLessonsFile, pointerTargets, withPointer, type PointerPath } from "./repo-file-pointer.js";
import { planRepoFile, type RepoFilePlan } from "./repo-file-plan.js";
import { parseLessonsFile, textHash } from "./repo-file-format.js";
import { Unconfirmed, freshBranchName, guardTarget, headOf, readOwnPr, repositoryIdOfPlace, verifyRepository, watchRowOf, type RepoFileTarget } from "./repo-file-host.js";
import { prBody, prTitle } from "./repo-file-pr.js";
import { MAX_DECLINED, MAX_RENDERED, StateFull, StateUnreadable, additionsPaused, appendOrMark, boundedAppend, provisionalNumber, type OpenPr, type PrRow, type PrRowStore, type RepoFileState, type RepoFileStore } from "./repo-file-state.js";
import type { LessonStore, ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

export type { RepoFileTarget } from "./repo-file-host.js";

export interface RepoFileDeps {
  store: LessonStore;
  state: RepoFileStore;
  /** Where the pull request rows live (the erasure sweep reads them). Absent: the state store, which keeps them in separate items. A test gives a different one to show the sweep needs nothing of the state. */
  rows?: PrRowStore;
  settings: LearningSettingsReader;
  audit: LessonAuditSink;
  /** The display names of the people the lessons could name: the project's people and the lessons' own. Throws when it cannot be read (the pass then waits). */
  names(key: ScopeKey, lessons: readonly Lesson[]): Promise<readonly string[]>;
  now(): number;
  /** Who holds the lease (one value per running pass). */
  holder: string;
  /** 12 random lower-case hex digits for a branch name; the default is the platform's random bytes. */
  randomHex?(): string;
  log?(event: string, fields: Record<string, string | number>): void;
}

/** One pass a week: a run 6 days after the last is due (the nightly job asks daily, so it is the seventh night at the latest). */
export const PASS_EVERY_MS = 6 * 86_400_000;
export const LEASE_MS = 20 * 60_000;

export type PassResult =
  | { status: "skipped"; reason: "lessons_off" | "not_enabled" | "not_due" | "busy" | "file_deleted" }
  | { status: "problem"; problem: LessonFileProblem }
  | { status: "no_changes" | "left" }
  | { status: "opened"; number: string; removals: number; edits: number; adds: number };

class Abort extends Error { constructor(readonly problem: LessonFileProblem) { super(problem); } }
const codeOf = (error: unknown): string | undefined => (typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : undefined);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "");

/** Commits a changed state under the revision that was read; a lost race ends the pass. */
async function commit(deps: RepoFileDeps, key: ScopeKey, state: RepoFileState, next: Partial<RepoFileState> | ((state: RepoFileState) => RepoFileState)): Promise<RepoFileState> {
  // A state that does not fit (a cap, the item size) is refused loudly: the row says `state_unreadable`; nothing is dropped to make it fit. The callback is inside the try: a full list raised there is labelled the same way.
  let saved: RepoFileState | undefined;
  try {
    const value = typeof next === "function" ? next(state) : { ...state, ...next };
    saved = await deps.state.put(key, value, state.revision);
  } catch (error) {
    if (error instanceof StateFull || error instanceof StateUnreadable) { deps.log?.("lessons_repo_file.state_refused", {}); throw new Abort("state_unreadable"); }
    throw error;
  }
  if (saved === undefined) throw new Abort("conflict");
  return saved;
}
const without = <T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> => { const copy = { ...value }; for (const key of keys) delete copy[key]; return copy; };

/** Writes one audit event before a host write; false (skip the write) when the ledger cannot take it. */
async function audited(deps: RepoFileDeps, key: ScopeKey, action: "lesson.repo_file_pr_opened" | "lesson.repo_file_pr_closed", facts: Record<string, string | number | boolean>): Promise<boolean> {
  return requireAudit(deps.audit, { action, workspaceId: key.workspaceId, project: key.project, facts });
}

/** A closing is given up after this many passes in which the branch could not be read. */
const CLOSING_ATTEMPTS = 3;

/** The lessons an open pull request carries (adds and edits), kept on a closing so a later erasure can still find a pull request that could not be finished. */
const carriedBy = (open: OpenPr): string[] => [...Object.keys(open.added), ...Object.keys(open.edited)];

/**
 * Closes Rovara's own pull requests and deletes its own branches that are waiting in `closing`, and the branch of a pending write that was never recorded (an erasure's close is NOT here: it is a durable row of its own, below).
 * Each close or delete is audited first; one that fails stays for the next pass. A pull request is closed only while its branch head is still the one Rovara left; one a person pushed to is theirs and moves to `theirs`, with the
 * lessons it carried (never dropped from tracking, and never handed over if it carries erased text: that one is closed). DELETING a branch needs proof it is Rovara's own: the head is read again right before the
 * delete and the branch goes only while it is still the head Rovara left; a head that cannot be read is not known to be Rovara's, so nothing is deleted and the entry is tried again a few times.
 */
export async function finishClosings(deps: RepoFileDeps, key: ScopeKey, rawTarget: RepoFileTarget, state: RepoFileState): Promise<RepoFileState> {
  const target = guardTarget(rawTarget);
  let current = state;
  const { host, repository, scope } = target;
  if (current.pending === undefined && current.closing.length === 0) {
    // Nothing is left to close: a count of closes held back from earlier is cleared.
    if ((current.closesHeld ?? 0) === 0) return current;
    try { return await commit(deps, key, current, (s) => without(s, "closesHeld")); } catch (error) { if (error instanceof Abort) throw error; return current; }
  }
  // THE FIRST CHECK, before any close or delete: the repository at this address is the one the place pins. If it is not (or cannot be asked), nothing is touched; the entries wait.
  if (!(await verifyRepository(target)).ok) return current;
  if (current.pending !== undefined) {
    const pending = current.pending;
    const head = await headOf(target, pending.branch);
    // A branch Rovara decided on before it wrote: it may exist (made and never recorded), at the base it was made at or at its own commit; deleting it also closes any pull request made from it. A branch at any other head is not touched;
    // one that cannot be read (gone and down look alike) is tried again a few times, not dropped at once.
    const ours = head !== undefined && (head === pending.baseRevision || head === pending.headRevision);
    try {
      if (head === undefined) {
        const attempts = (pending.attempts ?? 0) + 1;
        current = await commit(deps, key, current, (s) => (attempts >= CLOSING_ATTEMPTS ? without(s, "pending") : { ...s, pending: { ...pending, attempts } }));
      } else if (!ours) {
        current = await commit(deps, key, current, (s) => without(s, "pending"));
      } else if (host.deleteBranch !== undefined && await audited(deps, key, "lesson.repo_file_pr_closed", { cause: "replaced", pullRequest: 0 })) {
        if (await headOf(target, pending.branch) === head) await host.deleteBranch(repository, pending.branch, scope);
        current = await commit(deps, key, current, (s) => without(s, "pending"));
      }
    } catch (error) { if (error instanceof Abort) throw error; deps.log?.("lessons_repo_file.pending_cleanup_failed", {}); }
  }
  let held = 0;
  for (const entry of [...current.closing]) {
    const same = (c: { branch: string; number?: string | undefined }): boolean => c.branch === entry.branch && c.number === entry.number;
    const replace = async (next: typeof entry | undefined): Promise<void> => { current = await commit(deps, key, current, (s) => ({ ...s, closing: next === undefined ? s.closing.filter((c) => !same(c)) : s.closing.map((c) => (same(c) ? next : c)) })); };
    /** The pull request is the team's now (or cannot be proved Rovara's): tracked in `theirs`, with the lessons it carried. If that list is full the entry is dropped from this state and the pass says so (the erasure sweep keeps its own row for the pull request either way). */
    const handOver = async (): Promise<void> => {
      if (entry.number === undefined) { await replace(undefined); return; }
      const number = entry.number;
      current = await commit(deps, key, current, (s) => ({ ...s, closing: s.closing.filter((c) => !same(c)), ...appendOrMark(s, "theirs", { branch: entry.branch, number, url: "", ids: entry.ids ?? [] }) }));
    };
    try {
      let working = entry;
      // 1. The pull request.
      if (entry.number !== undefined && entry.closed !== true) {
        const head = await headOf(target, entry.branch);
        if (head === undefined) {
          const attempts = (entry.attempts ?? 0) + 1;
          if (attempts >= CLOSING_ATTEMPTS) await handOver(); else await replace({ ...entry, attempts });
          continue;
        }
        if (entry.headRevision === undefined || head !== entry.headRevision) { await handOver(); continue; }
        // READ AND CONFIRM before the close: a pull request that cannot be read (any failure but a confirmed 404) is left alone and tried again; one that is not Rovara's is dropped from the list untouched.
        const read = await readOwnPr(target, entry.number, entry.branch, entry.headRevision);
        if (read.kind === "read" && read.ours === false) { await replace(undefined); continue; }
        if (read.kind === "read" && read.details.state === "open") {
          if (read.ours !== true) throw new Unconfirmed();
          if (!await audited(deps, key, "lesson.repo_file_pr_closed", { cause: entry.cause, pullRequest: Number(entry.number) || 0 })) continue;
          await host.updateChangeRequest({ repository, id: entry.number, url: "" }, { state: "closed" }, scope);
        }
        working = { ...entry, closed: true };
        await replace(working);
      }
      // 2. The branch.
      if (working.headRevision === undefined || host.deleteBranch === undefined) { await replace(undefined); continue; }
      const head = await headOf(target, working.branch);
      if (head === undefined) {
        const attempts = (working.attempts ?? 0) + 1;
        if (attempts >= CLOSING_ATTEMPTS) await replace(undefined); else await replace({ ...working, attempts });
        continue;
      }
      if (head === working.headRevision) {
        if (working.closed !== true && !await audited(deps, key, "lesson.repo_file_pr_closed", { cause: working.cause, pullRequest: 0 })) continue;
        // Read again right before the delete: a push since the read above leaves the branch alone.
        if (await headOf(target, working.branch) === working.headRevision) await host.deleteBranch(repository, working.branch, scope);
      }
      await replace(undefined);
    } catch (error) {
      if (error instanceof Abort) throw error;
      // A pull request that could not be read or confirmed as Rovara's was not closed: counted, so the status says so.
      if (error instanceof Unconfirmed) held += 1;
      deps.log?.("lessons_repo_file.close_failed", {});
    }
  }
  if (held !== (current.closesHeld ?? 0)) {
    try { current = await commit(deps, key, current, (s) => (held === 0 ? without(s, "closesHeld") : { ...s, closesHeld: held })); } catch (error) { if (error instanceof Abort) throw error; }
  }
  return current;
}

/** Switching a repository off: the open pull request and its branch come down (when they are still Rovara's own), nothing more is proposed, the merged file stays. Returns the saved state. */
export async function switchRepoFileOff(deps: RepoFileDeps, key: ScopeKey, rawTarget: RepoFileTarget, state: RepoFileState): Promise<RepoFileState> {
  const target = guardTarget(rawTarget);
  let current = await commit(deps, key, state, { enabled: false });
  if (current.open !== undefined) {
    const open = current.open;
    // The closing checks the head again before it touches anything: a pull request a person pushed to is theirs and is left alone.
    current = await commit(deps, key, current, (s) => ({ ...without(s, "open") as RepoFileState, ...appendOrMark(s, "closing", { branch: open.branch, number: open.number, cause: "switched_off" as const, headRevision: open.headRevision, ids: carriedBy(open) }) }));
  }
  return finishClosings(deps, key, target, current);
}

/** The state after Rovara's open pull request was seen merged: what it put in the file is now Rovara's rendered record. */
function mergedState(state: RepoFileState, open: OpenPr): RepoFileState {
  const rendered = { ...state.rendered, ...open.added, ...open.edited };
  for (const id of open.removed) delete rendered[id];
  return { ...without(state, "open") as RepoFileState, rendered, unmerged: 0, fileSeen: true, fileDeleted: false };
}

/**
 * One weekly pass for one repository. Never throws: a fault is a `problem` code on the state (shown in the status) and the pass tries again at the next night. `force` skips only the "one a week" gate.
 */
export async function runRepoFilePass(deps: RepoFileDeps, key: ScopeKey, rawTarget: RepoFileTarget, options: { force?: boolean } = {}): Promise<PassResult> {
  const target = guardTarget(rawTarget);
  const { host } = target;
  // While lessons are off (the install's switch, the project's mode) nothing is delivered: no pull request, no close, no read.
  const learning = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(learning.mode, "load")) {
    // Nothing is delivered, but what Rovara already put up comes down: its open pull request is closed and leftover closings are finished (closing is not delivery).
    const left = await deps.state.get(key, target.place).catch(() => undefined);
    if (left !== undefined && (left.open !== undefined || left.closing.length > 0 || left.pending !== undefined)) {
      try {
        let current = left;
        if (current.open !== undefined) { const open = current.open; current = await commit(deps, key, current, (s) => ({ ...without(s, "open") as RepoFileState, ...appendOrMark(s, "closing", { branch: open.branch, number: open.number, cause: "lessons_off" as const, headRevision: open.headRevision, ids: carriedBy(open) }) })); }
        await finishClosings(deps, key, target, current);
      } catch { deps.log?.("lessons_repo_file.lessons_off_close_failed", {}); }
    }
    return { status: "skipped", reason: "lessons_off" };
  }
  let state: RepoFileState | undefined;
  try { state = await deps.state.get(key, target.place); } catch { return { status: "problem", problem: "state_unreadable" }; }
  if (state === undefined || !state.enabled) return { status: "skipped", reason: "not_enabled" };
  if (state.fileDeleted) return { status: "skipped", reason: "file_deleted" };
  const started = deps.now();
  if (options.force !== true && state.lastPassAt !== undefined && started - state.lastPassAt < PASS_EVERY_MS) return { status: "skipped", reason: "not_due" };
  if (state.lease !== undefined && state.lease.until > started && state.lease.holder !== deps.holder) return { status: "skipped", reason: "busy" };
  if (host.commitFiles === undefined || host.deleteBranch === undefined || host.pathKind === undefined) {
    await deps.state.put(key, { ...state, problem: "host_cannot_write" }, state.revision).catch(() => undefined);
    return { status: "problem", problem: "host_cannot_write" };
  }
  // THE FIRST CHECK, before the pass reads a pull request or saves anything: the repository at this address is the one the place pins. If not, nothing at all is done (the erasure sweep records the repository as not reachable).
  if (!(await verifyRepository(target)).ok) return { status: "problem", problem: "repository_unreadable" };
  try {
    state = await commit(deps, key, state, (s) => ({ ...without(s, "problem") as RepoFileState, lease: { holder: deps.holder, until: started + LEASE_MS } }));
  } catch { return { status: "skipped", reason: "busy" }; }

  let result: PassResult;
  try {
    result = await pass(deps, key, target, state, learning.preset === "standard" ? "standard" : "regulated");
  } catch (error) {
    const problem: LessonFileProblem = error instanceof Abort ? error.problem : "repository_unreadable";
    if (!(error instanceof Abort)) deps.log?.("lessons_repo_file.pass_failed", {});
    result = { status: "problem", problem };
    const latest = await deps.state.get(key, target.place).catch(() => undefined);
    if (latest !== undefined) await deps.state.put(key, { ...latest, problem }, latest.revision).catch(() => undefined);
  }
  // The lease goes back whatever happened; a lost race on this write is harmless (the lease expires).
  const latest = await deps.state.get(key, target.place).catch(() => undefined);
  if (latest?.lease?.holder === deps.holder) await deps.state.put(key, without(latest, "lease") as RepoFileState, latest.revision).catch(() => undefined);
  return result;
}

async function pass(deps: RepoFileDeps, key: ScopeKey, target: RepoFileTarget, leased: RepoFileState, preset: "standard" | "regulated"): Promise<PassResult> {
  const { host, repository, scope } = target;
  const pathKind = host.pathKind!.bind(host);
  let state = leased;

  // 1. What the last pass left behind: closings and an unrecorded write. (Erasure is NOT here: the erasure sweep runs before every pass, from its own rows, and does not depend on this state.)
  state = await finishClosings(deps, key, target, state);

  // 2. Pull requests handed over earlier come first, so the list is pruned before anything new is added to it: one still open keeps additions and edits waiting; one that was merged or closed is forgotten. One whose state cannot be read
  // is taken as still open (additions wait) and never stops the pass: removals must not wait on bookkeeping.
  let teamPr = false;
  if (state.theirs.length > 0) {
    const still: typeof state.theirs = [];
    const merged: string[] = [];
    for (const theirs of state.theirs) {
      const details = await host.getChangeRequest({ repository, id: theirs.number, url: theirs.url }, scope).then((d) => d, () => undefined);
      if (details === undefined || details.state === "open") still.push(theirs);
      // Merged by the team: what it put in the file is Rovara's lessons' text under the team's wording. The ids become known to Rovara (with a fingerprint nothing matches, so the wording is the team's and held), so an erasure that
      // comes later still reaches the block.
      else if (details.state === "merged") merged.push(...theirs.ids);
    }
    if (merged.length > 0) state = await commit(deps, key, state, (s) => ({ ...s, rendered: { ...Object.fromEntries(merged.map((id) => [id, "merged-by-team"])), ...s.rendered } }));
    teamPr = still.length > 0;
    if (still.length !== state.theirs.length) state = await commit(deps, key, state, { theirs: still });
  }
  // 3. The open pull request: merged, closed, or still open (and whose).
  let stillOpen = false;
  if (state.open !== undefined) {
    const open = state.open;
    let details;
    try { details = await host.getChangeRequest({ repository, id: open.number, url: open.url }, scope); } catch { throw new Abort("repository_unreadable"); }
    if (details.state === "merged") {
      state = await commit(deps, key, state, (s) => mergedState(s, open));
      // Its branch is Rovara's own unless a person pushed to it (the closing checks the head again before it deletes).
      state = await commit(deps, key, state, (s) => ({ ...s, ...appendOrMark(s, "closing", { branch: open.branch, cause: "merged" as const, headRevision: open.headRevision }) }));
    } else if (details.state === "closed") {
      state = await commit(deps, key, state, (s) => ({
        ...without(s, "open") as RepoFileState, unmerged: s.unmerged + 1,
        ...appendOrMark(s, "closing", { branch: open.branch, cause: "closed_by_team" as const, headRevision: open.headRevision }),
      }));
    } else if (details.headRevision !== open.headRevision) {
      // A person pushed to it (GitHub's "Update branch" counts): it is the team's now. It stays open, untouched, and Rovara stops treating it as its own; it counts as one more pull request nobody merged. Removals still go out in a new
      // pull request (and only removals while the team's one is open), because a removal must never wait on a branch Rovara may not write .
      state = await commit(deps, key, state, (s) => ({
        ...without(s, "open") as RepoFileState, unmerged: s.unmerged + 1,
        ...appendOrMark(s, "theirs", { branch: open.branch, number: open.number, url: open.url, ids: carriedBy(open) }),
      }));
      // The team's pull request is open right now: only removals go out beside it.
      teamPr = true;
    } else stillOpen = true;
    state = await finishClosings(deps, key, target, state);
  }
  // A hand-over the full list could not hold: the row says so, and additions and edits wait this pass (removals go on).
  if (state.problem === "state_unreadable") teamPr = true;
  // This pass found the open pull request unmerged: it counts once, when the pass finishes.
  const unmerged = state.unmerged + (stillOpen ? 1 : 0);
  const finish = async (extra: Partial<RepoFileState>): Promise<RepoFileState> => commit(deps, key, state, (s) => ({ ...without(s, "problem") as RepoFileState, ...(s.problem === "state_unreadable" ? { problem: s.problem } : {}), ...extra, unmerged, lastPassAt: deps.now() }));

  // 4. The repository and its file on the default branch.
  let defaultBranch: string;
  let head: string;
  let fileText: string | undefined;
  try {
    const identity = await host.repositoryIdentity(repository, scope);
    if (identity === undefined) throw new Abort("repository_gone");
    if (identity.defaultBranch === undefined) throw new Abort("repository_unreadable");
    // The repository at this address must be the one the place pins; anything else is never written to.
    if (String(identity.id) !== repositoryIdOfPlace(target.place)) throw new Abort("repository_unreadable");
    defaultBranch = identity.defaultBranch;
    head = await host.baseBranchHead(repository, defaultBranch, scope);
  } catch (error) { throw error instanceof Abort ? error : new Abort("repository_unreadable"); }
  let kind;
  try { kind = await pathKind(repository, LESSON_FILE_PATH, head, scope); } catch { throw new Abort("file_unreadable"); }
  if (kind === "symlink" || kind === "dir") throw new Abort("file_is_link");
  if (kind === "file") {
    try { fileText = await host.fileAtRevision(repository, LESSON_FILE_PATH, head, scope, { maxBytes: LESSON_FILE_MAX_BYTES }); } catch (error) { throw new Abort(codeOf(error) === "CONFIG_INVALID" ? "file_too_big" : "file_unreadable"); }
    if (fileText === undefined) throw new Abort("file_unreadable");
  }
  if (fileText === undefined && state.fileSeen) {
    // The team deleted it: nothing is retired, nothing re-adds it, the repository waits until someone resumes it.
    await commit(deps, key, state, (s) => ({ ...without(s, "problem") as RepoFileState, fileDeleted: true, lastPassAt: deps.now(), unmerged }));
    return { status: "skipped", reason: "file_deleted" };
  }
  if (fileText !== undefined && !state.fileSeen) state = await commit(deps, key, state, { fileSeen: true });

  // 5. The proposal.
  const lessons = await deps.store.listAllHeads(key);
  // Which of the markers in the file belong to a lesson that is gone for good: the lesson store's own tombstone, one durable row per lesson. A lookup that cannot be made stops the write (never read as 'not gone').
  let gone: Set<string>;
  try { gone = new Set((await deps.store.goneOf(key, [...(fileText === undefined ? [] : parseLessonsFile(fileText).blocks.map((block) => block.id)), ...lessons.filter((lesson) => lesson.provenance.repoOnly?.place === target.place).map((lesson) => lesson.id)])).keys()); } catch { throw new Abort("repository_unreadable"); }
  let names: readonly string[];
  try { names = await deps.names(key, lessons); } catch { throw new Abort("names_unreadable"); }
  const plan = planRepoFile({ place: target.place, repoName: target.name, lessons, names, fileText, rendered: state.rendered, declined: state.declined, gone, addsPaused: additionsPaused({ unmerged }), teamPr, preset });
  // What the plan learned about the file is recorded whatever comes next.
  const rendered = { ...state.rendered, ...plan.adopted };
  for (const id of plan.newlyDeclined) delete rendered[id];
  const bounded = Object.fromEntries(Object.entries(rendered).slice(-MAX_RENDERED));
  state = await commit(deps, key, state, { rendered: bounded, declined: boundedAppend(state.declined, plan.newlyDeclined, MAX_DECLINED), held: plan.held.slice(0, MAX_RENDERED) });

  // 6. The pointer: carried by the pull request that proposes it until that one is merged; proposed once. Every agent file is read, and a read that FAILS is never "absent": a pass that could not read one of them
  // writes no pointer this time (the lessons are still proposed), and every file that is written is written under the text it was read as (`previous`), so a change made in between is a conflict, never an overwrite.
  const wantsPointer = !state.pointerDeclined && (!state.pointerProposed || state.open?.pointer === true);
  const pointerFiles: Array<{ path: PointerPath; text: string; previous: string | null }> = [];
  const found: PointerPath[] = [];
  const links: PointerPath[] = [];
  const currentOf = new Map<PointerPath, string>();
  // A failed read of AGENTS.md or CLAUDE.md stops the pointer for this pass (it could hide the very file the pointer belongs in). A Copilot file that cannot be read (say `.github` is a link) only leaves that file out, so one
  // unreadable path never blocks the pointer for ever.
  let pointerReadFailed = false;
  const unreadable: PointerPath[] = [];
  for (const path of LESSON_FILE_POINTER_PATHS) {
    try {
      const pathKindOf = await pathKind(repository, path, head, scope);
      if (pathKindOf === "symlink") links.push(path);
      else if (pathKindOf === "file") {
        const text = await host.fileAtRevision(repository, path, head, scope, { maxBytes: 1_000_000 });
        if (text === undefined) throw new Error("unreadable");
        found.push(path); currentOf.set(path, text);
      } else if (pathKindOf === "dir") throw new Error("unreadable");
    } catch { unreadable.push(path); if (path !== ".github/copilot-instructions.md") pointerReadFailed = true; }
  }
  // A pointer proposed earlier and merged but named nowhere now: shown in the status, never edited again. Said only when every file could be read.
  const pointerMissing = unreadable.length === 0 ? state.pointerProposed && state.open?.pointer !== true && !state.pointerDeclined && [...currentOf.values()].every((text) => !mentionsLessonsFile(text)) : state.pointerMissing;
  if (wantsPointer && plan.nextText !== undefined && !pointerReadFailed) {
    for (const path of pointerTargets(found, state.pointers, [...links, ...unreadable])) {
      const next = withPointer(path, currentOf.get(path));
      if (next !== undefined) pointerFiles.push({ path, text: next, previous: currentOf.get(path) ?? null });
    }
  }
  // The row says so when the pointer is waiting on a file that cannot be read.
  const pointerProblem = wantsPointer && pointerReadFailed ? { problem: "pointer_unreadable" as const } : {};
  // The digest covers the file on the default branch and each pointer file it would write: a change the team made there rebuilds a pull request computed on the old text .
  const digest = createHash("sha256").update(`${plan.digest}|f:${textHash(fileText ?? "")}${pointerFiles.map((f) => `|${f.path}:${textHash(f.previous ?? "")}`).join("")}`).digest("hex").slice(0, 32);

  // 7. Decide.
  if (plan.nextText === undefined) {
    if (stillOpen) {
      const open = state.open!;
      // A pointer that rode in this pull request was never merged: the next pull request proposes it.
      state = await commit(deps, key, state, (s) => ({ ...without(s, "open") as RepoFileState, pointerProposed: open.pointer ? false : s.pointerProposed, ...appendOrMark(s, "closing", { branch: open.branch, number: open.number, cause: "nothing_left" as const, headRevision: open.headRevision, ids: carriedBy(open) }) }));
      state = await finishClosings(deps, key, target, state);
    }
    await finish({ pointerMissing, ...pointerProblem });
    return { status: "no_changes" };
  }
  if (stillOpen && state.open!.digest === digest) { await finish({ pointerMissing, ...pointerProblem }); return { status: "left" }; }

  return openPullRequest(deps, key, target, state, { plan, pointerFiles, digest, head, defaultBranch, fileText, unmerged, pointerMissing, pointerProblem });
}

async function openPullRequest(
  deps: RepoFileDeps, key: ScopeKey, target: RepoFileTarget, state: RepoFileState,
  work: { plan: RepoFilePlan; pointerFiles: Array<{ path: PointerPath; text: string; previous: string | null }>; digest: string; head: string; defaultBranch: string; fileText: string | undefined; unmerged: number; pointerMissing: boolean; pointerProblem: { problem?: "pointer_unreadable" } },
): Promise<PassResult> {
  const { host, repository, scope } = target;
  const { plan } = work;
  // The ledger first: if it cannot take the event nothing is written (this week's pull request waits).
  if (!await audited(deps, key, "lesson.repo_file_pr_opened", { removals: plan.removals.length, edits: plan.edits.length, adds: plan.adds.length })) throw new Abort("audit_down");
  // A leftover pending write the cleanup could not settle yet is not lost: it becomes a closing, tried again like any other.
  if (state.pending !== undefined) {
    const stray = state.pending;
    state = await commit(deps, key, state, (s) => ({ ...without(s, "pending") as RepoFileState, ...appendOrMark(s, "closing", { branch: stray.branch, cause: "replaced" as const, headRevision: stray.headRevision ?? stray.baseRevision, attempts: stray.attempts ?? 0 }) }));
  }
  const branch = await freshBranchName(deps, target);
  if (branch === undefined) throw new Abort("conflict");
  // WRITE AHEAD: the repository's watch row and a row keyed by the new branch (the number is not known yet) come BEFORE anything is written to the host, so a crash or a failed write between any two steps leaves a row the erasure
  // sweep can find; and if a row cannot be written, no host write is made. The branch is then recorded in the state as well, so the next pass cleans up a write that never got a pull request.
  const rows = deps.rows ?? deps.state;
  const carried = [...plan.adds.map((a) => a.id), ...plan.edits.map((e) => e.id)];
  const provisional: PrRow = { place: target.place, kind: "adds", number: provisionalNumber(branch), branch, ids: carried, at: deps.now() };
  try {
    await rows.putPr(key, watchRowOf(target, deps.now()));
    await rows.putPr(key, provisional);
  } catch { throw new Abort("state_unreadable"); }
  state = await commit(deps, key, state, { pending: { branch, at: deps.now(), baseRevision: work.head } });
  let revision: string;
  try {
    const written = await host.commitFiles!({
      repository, branch, baseBranch: work.defaultBranch, message: prTitle(plan), fromBase: true, baseRevision: work.head,
      files: [{ path: LESSON_FILE_PATH, content: plan.nextText! }, ...work.pointerFiles.map((f) => ({ path: f.path, content: f.text }))],
      previous: [{ path: LESSON_FILE_PATH, content: work.fileText ?? null }, ...work.pointerFiles.map((f) => ({ path: f.path, content: f.previous }))],
    }, scope);
    revision = written.revision;
    await rows.putPr(key, { ...provisional, headRevision: revision }).catch(() => undefined);
    // The head Rovara itself wrote, so a cleanup of a pull request that was never recorded can tell its own branch from a person's.
    state = await commit(deps, key, state, (s) => ({ ...s, pending: { branch, at: deps.now(), baseRevision: work.head, headRevision: revision } }));
  } catch (error) {
    if (error instanceof Abort) throw error;
    // Nothing was written (or the branch is Rovara's own random name, which the next pass deletes).
    const message = messageOf(error);
    throw new Abort(message === COMMIT_CONFLICT_MESSAGE ? "conflict" : message === COMMIT_SYMLINK_MESSAGE ? "file_is_link" : "write_refused");
  }
  let created;
  try {
    created = await host.reconcileChangeRequest({ repository, sourceBranch: branch, targetBranch: work.defaultBranch, title: prTitle(plan), body: prBody(plan, { pointerFiles: work.pointerFiles.map((f) => f.path), unmerged: work.unmerged }) }, scope);
  } catch { throw new Abort("write_refused"); }
  const previous = state.open;
  const open: OpenPr = {
    branch, number: created.ref.id, url: created.ref.url, headRevision: revision, baseRevision: work.head, digest: work.digest, openedAt: deps.now(),
    removals: plan.removals.length, edits: plan.edits.length, adds: plan.adds.length,
    added: Object.fromEntries(plan.adds.map((a) => [a.id, a.fingerprint])), edited: Object.fromEntries(plan.edits.map((e) => [e.id, e.fingerprint])), removed: plan.removals.map((r) => r.id),
    pointer: work.pointerFiles.length > 0,
  };
  // The numbered row replaces the provisional one. If that cannot be done the provisional row stays, and the erasure sweep finds the pull request by its branch.
  try {
    await rows.putPr(key, { ...provisional, number: open.number, headRevision: revision });
    await rows.delPr(key, target.place, provisional.number);
  } catch { deps.log?.("lessons_repo_file.pr_row_update_failed", {}); }
  state = await commit(deps, key, state, (s) => ({
    ...without(s, "pending", "problem") as RepoFileState, ...(s.problem === "state_unreadable" ? { problem: s.problem } : {}), ...work.pointerProblem, open,
    pointerProposed: s.pointerProposed || work.pointerFiles.length > 0,
    pointerMissing: work.pointerFiles.length > 0 ? false : work.pointerMissing,
    unmerged: work.unmerged, lastPassAt: deps.now(),
    ...(previous === undefined ? {} : appendOrMark(s, "closing", { branch: previous.branch, number: previous.number, cause: "replaced" as const, headRevision: previous.headRevision, ids: carriedBy(previous) })),
  }));
  // The previous Rovara pull request comes down after the new one is up: at most one is open when the pass ends.
  await finishClosings(deps, key, target, state);
  return { status: "opened", number: open.number, removals: open.removals, edits: open.edits, adds: open.adds };
}
