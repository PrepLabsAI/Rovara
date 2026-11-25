// RD-2b2: what the task page's Changes tab reads (`GET /v1/dev/tasks/{taskId}/changes`), as ONE answer. The host (core-host/task-changes-routes.ts) decides who may read and supplies the sources; this file turns them into the view.
//
// Which files, in this order (the first that has any):
//   1. The task's pull requests, every page of their files from the code host, with each file's patch. `checkedAgainstCodeHost` is true.
//   2. The list the code host gave when the code was checked (`VERIFIED_FILES`, kept by the build step), without patches. `checkedAgainstCodeHost` is true.
//   3. What Rovara's worker reported it changed (`workspace.diff`), without patches. NOT believed (core/build-step/changed-files.ts): `source` says `worker_report` and `checkedAgainstCodeHost` is false, so a client shows it labelled as
//      "reported by Rovara's worker, not yet checked against the code host". It never decides anything (risk is judged from the code host's list only).
//   Nothing to show: an empty list and no `source` (never an error: a missing layer is an empty member).
//
// The "why" next to a file is a join by path, never a guess: the plan's steps (claims) whose code evidence cites the path, the plan's checks that prove those steps (`checks.proves`), and the design review's findings whose code citations
// name the path. No file-to-step record exists, so where nothing matches `why` is empty.
//
// File paths, patches and the why texts are the customer's data and a model's words: each is made one safe string (control and direction characters removed, secrets redacted, cut), every list and the whole answer are bounded, and
// nothing here writes any of it to a log.
import { redactText, type PlanClaim, type PlanDocument, type WorkflowSnapshot } from "@agentx/contracts";

// ---- the limits

/** Files listed in one answer, pages of a pull request read for one answer (30 files each), and pull requests read. */
export const CHANGES_FILES_MAX = 200;
export const CHANGES_PAGES_MAX = 10;
export const CHANGES_PULL_REQUESTS_MAX = 10;
/** The longest patch one file shows (the diff read's own limit) and the most patch text one answer carries; a file past either shows no patch and says `truncated`. */
export const CHANGES_PATCH_MAX_CHARS = 30_000;
export const CHANGES_PATCH_TOTAL_MAX_CHARS = 1_000_000;
/** What one file's "why" holds and the longest text in it. */
export const CHANGES_WHY_PER_FILE_MAX = 6;
export const CHANGES_WHY_TEXT_MAX = 160;
const PATH_MAX = 500;
const NAME_MAX = 200;
const ID_MAX = 64;

// ---- what the host supplies

/** One file of one page of a pull request, as the host reads it. `patch` absent: the code host gave none (binary, or too large for it). `tooLong`: the patch is longer than a page shows. */
export interface PullRequestPageFile { path: string; additions: number; deletions: number; patch?: string | undefined; tooLong?: boolean | undefined }
export interface PullRequestPage { files: readonly PullRequestPageFile[]; more: boolean }

/** A list of changed files that has no patches (the kept code-host list, or the worker's report). A count that is absent is unknown, never 0. */
export interface ListedFiles {
  files: ReadonlyArray<{ repository: string; path: string; renamedFrom?: string | undefined; added?: number | undefined; removed?: number | undefined }>;
  complete: boolean;
}

export interface ChangesSources {
  /** One page (from 1) of one pull request's files. `undefined`, or a throw: this page cannot be read now. */
  pullRequestPage?: ((pullRequest: { repository: string; number: number }, page: number) => Promise<PullRequestPage | undefined>) | undefined;
  /** The list the code host gave when the task's current code was checked. */
  verified?: (() => Promise<ListedFiles | undefined>) | undefined;
  /** The worker's own report of what it changed. */
  reported?: (() => Promise<ListedFiles | undefined>) | undefined;
  /** The task's current plan, for the "why". */
  plan?: PlanDocument | undefined;
}

export interface ChangesTask {
  taskId: string;
  workflow?: Pick<WorkflowSnapshot, "pullRequests" | "designReview"> | undefined;
}

// ---- the view (the members of `TaskChangesReadSchema.changes`)

export interface ChangedFileView {
  path: string;
  repository?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  truncated?: boolean;
  why: Array<{ kind: "step" | "check" | "finding"; id: string; text: string }>;
}
export interface TaskChangesView {
  taskId: string;
  source?: "pull_request" | "worker_report";
  checkedAgainstCodeHost: boolean;
  pullRequests: Array<{ repository: string; number: number; url?: string }>;
  files: ChangedFileView[];
  filesNotListed?: number;
}

// ---- text that is the customer's

// C0 and C1 controls, line and paragraph separators, and the bidirectional controls that can make a path read as another one.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** One safe line: unsafe characters become a space, secrets are redacted, then it is cut. An empty result is `undefined`. */
export function plainLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = redactText(value.replace(UNSAFE_CHARACTERS, " ")).trim();
  return line === "" ? undefined : line.length > max ? line.slice(0, max) : line;
}

/** A path as the join compares it: no leading `./`, forward slashes. */
const normalizedPath = (path: string): string => path.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");

const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

// ---- the why

type WhyKind = "step" | "check" | "finding";
interface WhyEntry { kind: WhyKind; id: string; text: string; repository?: string | undefined }

function claimsOf(claims: readonly PlanClaim[] | undefined): PlanClaim[] {
  const all: PlanClaim[] = [];
  const walk = (list: readonly PlanClaim[] | undefined, depth: number): void => {
    for (const claim of list ?? []) {
      all.push(claim);
      if (depth < 3) walk(claim.children, depth + 1);
    }
  };
  walk(claims, 1);
  return all;
}

type WhyIndex = Map<string, WhyEntry[]>;

function addWhy(index: WhyIndex, path: string, entry: WhyEntry): void {
  const list = index.get(path) ?? [];
  if (!list.some((existing) => existing.kind === entry.kind && existing.id === entry.id)) list.push(entry);
  index.set(path, list);
}

/** The plan's steps: each claim's code evidence puts the claim under its path. Returns the claim ids per path, for the checks that prove them. */
function addSteps(index: WhyIndex, plan: PlanDocument | undefined): Map<string, Set<string>> {
  const stepsByPath = new Map<string, Set<string>>();
  for (const claim of claimsOf(plan?.claims)) {
    const id = plainLine(claim.id, ID_MAX);
    const text = plainLine(claim.text, CHANGES_WHY_TEXT_MAX);
    if (id === undefined || text === undefined) continue;
    for (const evidence of claim.evidence ?? []) {
      if (evidence.kind !== "code" || typeof evidence.path !== "string") continue;
      const path = normalizedPath(evidence.path);
      addWhy(index, path, { kind: "step", id, text });
      stepsByPath.set(path, (stepsByPath.get(path) ?? new Set<string>()).add(claim.id));
    }
  }
  return stepsByPath;
}

/** The checks that prove a step a file's path was cited by (`checks.proves`: check id to claim ids). */
function addChecks(index: WhyIndex, plan: PlanDocument | undefined, stepsByPath: Map<string, Set<string>>): void {
  const checks = plan?.checks;
  if (checks === undefined) return;
  const labels = new Map([...checks.proposed, ...(checks.alsoRun ?? [])].map((check) => [check.id, check.label] as const));
  for (const [path, claimIds] of stepsByPath) {
    for (const [checkId, proves] of Object.entries(checks.proves ?? {})) {
      if (!proves.some((claimId) => claimIds.has(claimId))) continue;
      const id = plainLine(checkId, ID_MAX);
      const text = plainLine(labels.get(checkId) ?? checkId, CHANGES_WHY_TEXT_MAX);
      if (id !== undefined && text !== undefined) addWhy(index, path, { kind: "check", id, text });
    }
  }
}

/** The design review's latest round: a finding goes under each path its code citations name. */
function addFindings(index: WhyIndex, designReview: WorkflowSnapshot["designReview"]): void {
  for (const finding of designReview?.rounds?.at(-1)?.findings ?? []) {
    const id = plainLine(finding.id, ID_MAX);
    const text = plainLine(finding.text, CHANGES_WHY_TEXT_MAX);
    if (id === undefined || text === undefined) continue;
    for (const citation of finding.citations ?? []) {
      if (citation.kind === "code" && typeof citation.path === "string") addWhy(index, normalizedPath(citation.path), { kind: "finding", id, text, repository: citation.repo });
    }
  }
}

/** Path -> why entries, from the plan (steps, then the checks that prove them) and the design review's latest round. */
export function whyIndexOf(plan: PlanDocument | undefined, designReview: WorkflowSnapshot["designReview"]): WhyIndex {
  const index: WhyIndex = new Map();
  addChecks(index, plan, addSteps(index, plan));
  addFindings(index, designReview);
  return index;
}

/** The why of one file: entries for its path (or the path it was renamed from), a finding only for its own repository, steps before checks before findings, at most `CHANGES_WHY_PER_FILE_MAX`. */
function whyOf(index: WhyIndex, file: { path: string; repository?: string | undefined; renamedFrom?: string | undefined }): ChangedFileView["why"] {
  if (index.size === 0) return [];
  const found = [...(index.get(normalizedPath(file.path)) ?? []), ...(file.renamedFrom === undefined ? [] : index.get(normalizedPath(file.renamedFrom)) ?? [])]
    .filter((entry) => entry.repository === undefined || file.repository === undefined || entry.repository === file.repository);
  const order: Record<WhyKind, number> = { step: 0, check: 1, finding: 2 };
  const seen = new Set<string>();
  return found.sort((left, right) => order[left.kind] - order[right.kind])
    .filter((entry) => !seen.has(`${entry.kind}:${entry.id}`) && seen.add(`${entry.kind}:${entry.id}`))
    .slice(0, CHANGES_WHY_PER_FILE_MAX).map(({ kind, id, text }) => ({ kind, id, text }));
}

// ---- the files

/** What the pages read so far, shared across the pull requests of one answer. */
interface PageState { files: ChangedFileView[]; notListed: number; read: boolean; patchChars: number; pagesLeft: number }

/** One page, or `undefined` when it cannot be read (a throw is the same: the reason is never kept). */
async function readPage(sources: ChangesSources, pullRequest: { repository: string; number: number }, page: number): Promise<PullRequestPage | undefined> {
  try { return await sources.pullRequestPage?.(pullRequest, page); } catch { return undefined; }
}

/** One file of a page as the answer lists it: patch kept only within the limits (a file past them says `truncated` and keeps its counts). */
function pageFileView(state: PageState, file: PullRequestPageFile, path: string, repository: string, why: ChangedFileView["why"]): ChangedFileView {
  const view: ChangedFileView = { path, repository, ...optionalCounts(file.additions, file.deletions), why };
  const patch = file.tooLong === true || file.patch === undefined || file.patch === "" ? undefined : file.patch;
  const tooBig = patch !== undefined && (patch.length > CHANGES_PATCH_MAX_CHARS || state.patchChars + patch.length > CHANGES_PATCH_TOTAL_MAX_CHARS);
  if (file.tooLong === true || tooBig) view.truncated = true;
  else if (patch !== undefined) { state.patchChars += patch.length; view.patch = redactText(patch); }
  return view;
}

function addPageFiles(state: PageState, page: PullRequestPage, pullRequest: { repositoryId: string }, repository: string, why: WhyIndex): void {
  for (const file of page.files) {
    const path = plainLine(file.path, PATH_MAX);
    if (path === undefined) continue;
    if (state.files.length >= CHANGES_FILES_MAX) { state.notListed += 1; continue; }
    state.files.push(pageFileView(state, file, path, repository, whyOf(why, { path: file.path, repository: pullRequest.repositoryId })));
  }
}

/** Every page of one pull request, until its last page, a page that cannot be read, or the page cap (what was read stays; the answer says some files are not listed). */
async function readPullRequest(state: PageState, sources: ChangesSources, pullRequest: { repositoryId: string; number: number }, repository: string, why: WhyIndex): Promise<void> {
  for (let page = 1; ; page += 1) {
    if (state.pagesLeft === 0) { state.notListed += 1; return; }
    state.pagesLeft -= 1;
    const got = await readPage(sources, { repository: pullRequest.repositoryId, number: pullRequest.number }, page);
    if (got === undefined) {
      if (page > 1) state.notListed += 1;
      return;
    }
    state.read = true;
    addPageFiles(state, got, pullRequest, repository, why);
    if (!got.more) return;
  }
}

async function pagesOf(task: ChangesTask, sources: ChangesSources, why: WhyIndex): Promise<PageState> {
  const state: PageState = { files: [], notListed: 0, read: false, patchChars: 0, pagesLeft: CHANGES_PAGES_MAX };
  const seen = new Set<string>();
  for (const pullRequest of (task.workflow?.pullRequests ?? []).slice(0, CHANGES_PULL_REQUESTS_MAX)) {
    const repository = plainLine(pullRequest.repositoryId, NAME_MAX);
    const key = `${pullRequest.repositoryId}#${pullRequest.number}`;
    if (repository === undefined || seen.has(key) || sources.pullRequestPage === undefined) continue;
    seen.add(key);
    await readPullRequest(state, sources, pullRequest, repository, why);
  }
  return state;
}

function optionalCounts(additions: unknown, deletions: unknown): { additions?: number; deletions?: number } {
  const added = count(additions), removed = count(deletions);
  return { ...(added === undefined ? {} : { additions: added }), ...(removed === undefined ? {} : { deletions: removed }) };
}

function listedFiles(list: ListedFiles, why: WhyIndex): { files: ChangedFileView[]; notListed: number } {
  const files: ChangedFileView[] = [];
  let notListed = 0;
  for (const file of list.files) {
    const path = plainLine(file.path, PATH_MAX);
    if (path === undefined) continue;
    if (files.length >= CHANGES_FILES_MAX) { notListed += 1; continue; }
    const repository = plainLine(file.repository, NAME_MAX);
    files.push({ path, ...(repository === undefined ? {} : { repository }), ...optionalCounts(file.added, file.removed), why: whyOf(why, { path: file.path, repository: file.repository, renamedFrom: file.renamedFrom }) });
  }
  // A list the code host or the worker cut short says so: at least one file is not listed.
  return { files, notListed: notListed === 0 && !list.complete ? 1 : notListed };
}

async function listOf(read: (() => Promise<ListedFiles | undefined>) | undefined): Promise<ListedFiles | undefined> {
  if (read === undefined) return undefined;
  try {
    const list = await read();
    return list !== undefined && Array.isArray(list.files) && list.files.length > 0 ? list : undefined;
  } catch {
    return undefined;
  }
}

function pullRequestsOf(task: ChangesTask): TaskChangesView["pullRequests"] {
  const listed: TaskChangesView["pullRequests"] = [];
  for (const pullRequest of task.workflow?.pullRequests ?? []) {
    const repository = plainLine(pullRequest.repositoryId, NAME_MAX);
    if (repository === undefined || listed.some((entry) => entry.repository === repository && entry.number === pullRequest.number) || listed.length >= CHANGES_PULL_REQUESTS_MAX) continue;
    listed.push({ repository, number: pullRequest.number, ...(typeof pullRequest.url === "string" && /^https:\/\/[^\s]{1,2000}$/u.test(pullRequest.url) ? { url: pullRequest.url } : {}) });
  }
  return listed;
}

function withFiles(base: Pick<TaskChangesView, "taskId" | "pullRequests">, source: NonNullable<TaskChangesView["source"]>, files: ChangedFileView[], notListed: number): TaskChangesView {
  // Only the code host's list is checked; the worker's is shown labelled and is never believed.
  return { ...base, source, checkedAgainstCodeHost: source === "pull_request", files, ...(notListed > 0 ? { filesNotListed: notListed } : {}) };
}

/** The Changes tab's answer for one task. Never throws for a source that cannot answer: that source is left out (and the answer says which kind of list it is). */
export async function taskChangesOf(task: ChangesTask, sources: ChangesSources): Promise<TaskChangesView> {
  const why = whyIndexOf(sources.plan, task.workflow?.designReview);
  const base = { taskId: task.taskId, pullRequests: pullRequestsOf(task) };
  const fromPullRequests = await pagesOf(task, sources, why);
  if (fromPullRequests.read && fromPullRequests.files.length > 0) return withFiles(base, "pull_request", fromPullRequests.files, fromPullRequests.notListed);
  const lists = [{ read: sources.verified, source: "pull_request" }, { read: sources.reported, source: "worker_report" }] as const;
  for (const { read, source } of lists) {
    const list = await listOf(read);
    const listed = list === undefined ? undefined : listedFiles(list, why);
    if (listed !== undefined && listed.files.length > 0) return withFiles(base, source, listed.files, listed.notListed);
  }
  return { ...base, checkedAgainstCodeHost: false, files: [] };
}
