// Shared fakes for the lessons-in-the-repo file tests: an in-memory code host with branches, files and change requests that refuses what the real adapter refuses, and the pass's dependencies around the
// lesson store fakes. No network, no AWS, no model: the pass's `names`, `store`, `state` and `audit` are all in-memory.
import {
  COMMIT_CONFLICT_MESSAGE, LESSON_FILE_BRANCH_PATTERN, LESSON_FILE_WRITE_PATHS, agentXError,
  type ChangeRequestInput, type ChangeRequestRef, type CodeHost, type CommitFilesInput, type PathKind, type RepositoryRef,
} from "@rovara-code/contracts";
import { setLearnedLessonsGate } from "../../../packages/lessons/src/policy.js";
import type { LessonAuditEvent } from "../../../packages/lessons/src/ports.js";
import { sweepDepsOf, sweepErasures } from "../../../packages/lessons/src/repo-file-erase.js";
import { runRepoFilePass, type RepoFileDeps, type RepoFileTarget } from "../../../packages/lessons/src/repo-file-pass.js";
import { InMemoryRepoFileStore, newRepoFileState } from "../../../packages/lessons/src/repo-file-state.js";
import { InMemoryLessonStore } from "../../../packages/lessons/src/store.js";
import type { Lesson } from "../../../packages/lessons/src/types.js";
import { Audit, Clock, KEY, PROJECT, WS, lessonRecord, seed, settings } from "./lesson-helpers.js";

export const REPO_URL = "https://github.com/acme/api";
export const PLACE = "github:repo/1001";
export const OTHER_PLACE = "github:repo/2002";
export const DAY = 86_400_000;
export const FILE = ".rovara/lessons.md";
const SHA0 = "a".repeat(40);
interface FakePr { number: number; source: string; target: string; baseRevision: string; title: string; body: string; state: "open" | "closed" | "merged"; mergeRevision?: string; /** A person made it (default: Rovara's own account did). */ byPerson?: boolean }

/** A repository: branches with files, a head per branch, change requests. It records every write so a test can see what was and was not written, and refuses what the real adapter refuses. */
export class FakeRepoHost {
  files = new Map<string, Map<string, string>>([["main", new Map()]]);
  heads = new Map<string, string>([["main", SHA0]]);
  snapshots = new Map<string, Map<string, string>>([[SHA0, new Map()]]);
  prs: FakePr[] = [];
  kinds = new Map<string, PathKind>();
  /** Every host call in order, by name. */
  calls: string[] = [];
  /** Every write: a commit, a branch deletion, a change request update. */
  writes: Array<{ op: "commit" | "delete" | "update" | "create"; branch?: string; paths?: string[]; force?: boolean; parent?: string; id?: string; state?: string }> = [];
  failCalls = new Set<string>();
  /** The id this repository has on the host (the id a place pins). */
  repoId = "1001";
  /** A host that cannot say who made a pull request (the answer is left out). */
  omitAuthorship = false;
  /** Every commit the pass asked for, as it asked (paths, `previous`). */
  commitInputs: CommitFilesInput[] = [];
  /** Runs in the middle of a commit, after the caller read and before the host writes: somebody pushes in between. */
  beforeCommit: (() => void) | undefined;
  private counter = 0;
  readonly kind = "fake";
  readonly capabilities = {} as never;
  readonly events = { mode: "none" as const };

  private id(): string { this.counter += 1; return String(this.counter).padStart(40, "c"); }
  private async seen(name: string): Promise<void> { this.calls.push(name); if (this.failCalls.has(name)) throw new Error(`${name} failed`); }

  /** A person (or a merge) puts a file on a branch. */
  setFile(branch: string, path: string, content: string | undefined): string {
    const files = new Map(this.files.get(branch) ?? this.files.get("main"));
    if (content === undefined) files.delete(path); else files.set(path, content);
    this.files.set(branch, files);
    const id = this.id();
    this.heads.set(branch, id);
    this.snapshots.set(id, new Map(files));
    return id;
  }
  file(branch: string, path: string): string | undefined { return this.files.get(branch)?.get(path); }
  /** Merges a pull request the way a person would with a squash: the paths it changed against its base, on top of main as it is now. */
  merge(number: number): string {
    const pr = this.prs.find((p) => p.number === number)!;
    const base = this.snapshots.get(pr.baseRevision) ?? new Map<string, string>();
    const branch = this.files.get(pr.source)!;
    const main = new Map(this.files.get("main"));
    for (const [path, text] of branch) if (base.get(path) !== text) main.set(path, text);
    for (const path of base.keys()) if (!branch.has(path)) main.delete(path);
    this.files.set("main", main);
    const id = this.id();
    this.heads.set("main", id);
    this.snapshots.set(id, new Map(main));
    pr.state = "merged";
    pr.mergeRevision = id;
    return id;
  }
  close(number: number): void { this.prs.find((p) => p.number === number)!.state = "closed"; }
  get open(): FakePr[] { return this.prs.filter((pr) => pr.state === "open"); }
  /** The branches that exist besides main. */
  get branchNames(): string[] { return [...this.files.keys()].filter((name) => name !== "main").sort(); }

  async repositoryIdentity() { await this.seen("repositoryIdentity"); return { id: this.repoId, fullName: "acme/api", defaultBranch: "main" }; }
  async baseBranchHead(_r: RepositoryRef, branch: string): Promise<string> { await this.seen("baseBranchHead"); const head = this.heads.get(branch); if (head === undefined) throw new Error("no such branch"); return head; }
  private filesAt(revision: string): Map<string, string> | undefined { return this.snapshots.get(revision); }
  async fileAtRevision(_r: RepositoryRef, path: string, revision: string, _s: unknown, options?: { maxBytes?: number }): Promise<string | undefined> {
    await this.seen("fileAtRevision");
    const text = this.filesAt(revision)?.get(path);
    if (text !== undefined && options?.maxBytes !== undefined && Buffer.byteLength(text) > options.maxBytes) throw agentXError("CONFIG_INVALID", "file too large");
    return text;
  }
  async pathKind(_r: RepositoryRef, path: string, revision: string): Promise<PathKind> {
    await this.seen("pathKind");
    const forced = this.kinds.get(path);
    if (forced !== undefined) return forced;
    return this.filesAt(revision)?.has(path) === true ? "file" : "none";
  }
  async commitFiles(input: CommitFilesInput) {
    await this.seen("commitFiles");
    this.commitInputs.push(structuredClone(input));
    // What the real adapter refuses.
    if (!LESSON_FILE_BRANCH_PATTERN.test(input.branch)) throw agentXError("CONFIG_INVALID", "branch name is invalid");
    if (input.files.some((file) => !LESSON_FILE_WRITE_PATHS.includes(file.path))) throw agentXError("CONFIG_INVALID", "file path is not one Rovara writes lessons to");
    this.beforeCommit?.();
    const base = input.baseRevision ?? this.heads.get(input.baseBranch)!;
    const exists = this.files.has(input.branch);
    if (exists && input.fromBase) throw agentXError("CONFIG_INVALID", COMMIT_CONFLICT_MESSAGE);
    if (!exists) {
      this.files.set(input.branch, new Map(this.snapshots.get(base)));
      this.heads.set(input.branch, base);
      this.branchBases.set(input.branch, base);
    }
    for (const expected of input.previous ?? []) if ((this.files.get(input.branch)!.get(expected.path) ?? null) !== expected.content) throw agentXError("CONFIG_INVALID", COMMIT_CONFLICT_MESSAGE);
    const parent = this.heads.get(input.branch)!;
    let head = parent;
    for (const file of input.files) if (this.files.get(input.branch)!.get(file.path) !== file.content) head = this.setFile(input.branch, file.path, file.content);
    this.writes.push({ op: "commit", branch: input.branch, paths: input.files.map((f) => f.path), force: false, parent });
    return { revision: head, changed: head !== parent };
  }
  async deleteBranch(_r: RepositoryRef, branch: string): Promise<"deleted" | "gone"> {
    await this.seen("deleteBranch");
    if (!LESSON_FILE_BRANCH_PATTERN.test(branch)) throw agentXError("CONFIG_INVALID", "branch name is invalid");
    this.writes.push({ op: "delete", branch });
    if (!this.files.has(branch)) return "gone";
    this.files.delete(branch); this.heads.delete(branch);
    for (const pr of this.prs) if (pr.source === branch && pr.state === "open") pr.state = "closed";
    return "deleted";
  }
  /** The pull request (any state) made from a branch, as the real adapter finds it. */
  async changeRequestForBranch(_r: RepositoryRef, branch: string): Promise<ChangeRequestRef | undefined> {
    await this.seen("changeRequestForBranch");
    const pr = this.prs.find((p) => p.source === branch);
    return pr === undefined ? undefined : this.refOf(pr);
  }
  async reconcileChangeRequest(input: ChangeRequestInput) {
    await this.seen("reconcileChangeRequest");
    const open = this.prs.find((pr) => pr.state === "open" && pr.source === input.sourceBranch && pr.target === input.targetBranch);
    if (open !== undefined) return { ref: this.refOf(open), reconciled: true };
    const pr: FakePr = { number: this.prs.length + 1, source: input.sourceBranch, target: input.targetBranch, baseRevision: this.baseOf(input.sourceBranch), title: input.title, body: input.body ?? "", state: "open" };
    this.prs.push(pr);
    this.writes.push({ op: "create", branch: input.sourceBranch, id: String(pr.number) });
    return { ref: this.refOf(pr), reconciled: false };
  }
  private baseOf(branch: string): string { return this.branchBases.get(branch) ?? this.heads.get("main")!; }
  /** The main revision each Rovara branch was made at (what a merge is computed against). */
  branchBases = new Map<string, string>();
  private refOf(pr: FakePr): ChangeRequestRef { return { repository: { url: REPO_URL }, id: String(pr.number), url: `${REPO_URL}/pull/${String(pr.number)}` }; }
  async getChangeRequest(ref: ChangeRequestRef) {
    await this.seen("getChangeRequest");
    const pr = this.prs.find((p) => String(p.number) === ref.id)!;
    return { ref, state: pr.state, sourceBranch: pr.source, targetBranch: pr.target, headRevision: this.heads.get(pr.source) ?? "f".repeat(40), ...(pr.mergeRevision === undefined ? {} : { mergeRevision: pr.mergeRevision }), title: pr.title, body: pr.body, ...(this.omitAuthorship ? {} : { authoredByRovara: pr.byPerson !== true }), baseRepositoryId: this.repoId };
  }
  async updateChangeRequest(ref: ChangeRequestRef, update: { title?: string; body?: string; state?: "open" | "closed" }) {
    await this.seen("updateChangeRequest");
    this.writes.push({ op: "update", id: ref.id, ...(update.state === undefined ? {} : { state: update.state }) });
    const pr = this.prs.find((p) => String(p.number) === ref.id)!;
    if (update.state !== undefined && pr.state !== "merged") pr.state = update.state;
  }
}

/** An eligible lesson for the repository: stable after trial, project audience, no names, repo-only for `place`. */
export function repoLesson(id: string, over: Partial<Lesson> & { place?: string; names?: boolean } = {}): Lesson {
  const { place = PLACE, ...rest } = over;
  const base = lessonRecord({
    id, title: `Title of ${id}`, body: `Lesson text for ${id}: use the shared helper.`, scope: { repos: ["api"] }, tier: 0, tierReasons: [],
    trial: { state: "stable", startedAt: 1, stableAt: 2 }, approvals: [{ approvalId: "a", by: "system:trial", at: 1, mode: "trial" }], createdAt: 10,
  });
  return { ...base, provenance: { ...base.provenance, repoOnly: { place }, authors: ["ann"], supportTasks: [`task-${id}`] }, ...rest };
}
/** The same lesson, approved by a person instead of the trial. */
export const personApproved = (lesson: Lesson): Lesson => { const { trial: _trial, ...rest } = lesson; void _trial; return { ...rest, approvals: [{ approvalId: "p", by: "ann", at: 1, mode: "one" }] }; };

export function passSetup(over: { host?: FakeRepoHost; preset?: "standard" | "regulated"; mode?: "On" | "Suggest" | "Collect" | "Off"; names?: string[]; startAt?: number } = {}) {
  setLearnedLessonsGate(() => true);
  const host = over.host ?? new FakeRepoHost();
  const store = new InMemoryLessonStore();
  const state = new InMemoryRepoFileStore();
  const audit = new Audit();
  const clock = new Clock(over.startAt);
  const failAudit = { on: false };
  const sink = { emit: async (event: LessonAuditEvent, options?: { required?: boolean }) => { if (failAudit.on) throw new Error("ledger down"); await audit.emit(event, options); } };
  const names = { value: over.names ?? ["Ann Lee", "Bob Stone"], throws: false };
  const spyModel = { calls: 0 };
  const deps: RepoFileDeps = {
    store, state, settings: settings({ preset: over.preset ?? "standard", mode: over.mode ?? "On" }), audit: sink, now: clock.now, holder: "pass-1",
    names: async () => { if (names.throws) throw new Error("names down"); return names.value; },
  };
  const hex = { next: 0 };
  deps.randomHex = () => { hex.next += 1; return hex.next.toString(16).padStart(12, "0"); };
  const target: RepoFileTarget = { name: "api", place: PLACE, repository: { url: REPO_URL }, scope: { system: "private-install" } as never, host: host as unknown as CodeHost };
  const key = KEY;
  return {
    host, store, state, audit, clock, deps, target, key, failAudit, names, spyModel, hex,
    seedLessons: (...lessons: Lesson[]) => seed(store, ...lessons),
    enable: async (extra: Partial<ReturnType<typeof newRepoFileState>> = {}) => { const next = { ...newRepoFileState(PLACE, "api"), enabled: true, ...extra }; await state.put(key, next, 0); },
    run: (options: { force?: boolean } = {}) => runRepoFilePass(deps, key, target, options),
    /** The erasure sweep for the repository, as the nightly job and the erasure hook run it. */
    sweep: () => sweepErasures(sweepDepsOf(deps), key, target),
    current: async () => (await state.get(key, PLACE))!,
    week: () => clock.advance(7 * DAY),
  };
}
export { Audit, Clock, KEY, PROJECT, WS };
