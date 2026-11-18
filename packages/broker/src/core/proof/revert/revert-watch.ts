// Revert watch (lane L4-LM1b, owner-approved 2026-11-17: "what happened after merge" as a learning source). It calls the two revert detectors (`revert-detect.ts`) that nothing called before, from the one place both a deployed install
// and a laptop already run on a timer: a periodic pass over the repositories the company has merged Rovara pull requests into.
//
// Why a pass and not an event: a revert is NOT a Rovara pull request, so the deployed webhook route (it authorises only pull requests linked to a task) never sees one, no neutral code host event has a consumer in Code, and a laptop has no public
// address. The pass asks the code host for the newest commits of the default branch (`CodeHost.recentCommits`, one request a repository) and looks at each commit that is shaped like a revert:
//   - a squash or merge commit of a pull request (`Revert "..." (#45)`, `Merge pull request #45 ...` whose title is a revert): the detector reads the pull request itself (title, body, who merged it) and records it only when a person with write access merged it;
//   - any other commit with git's own revert shape (`Revert "..."`, body line `This reverts commit <sha>`): the detector requires an ordinary verified commit whose author can write, committed by that author, and a pusher who can write. The list shows no pusher;
//     the committer of a commit that is not the host's web committer is taken as the pusher, and a web-committed commit with no pull request has none, so it records nothing (an unproven revert is never recorded).
//
// Company binding (every step): the repositories come from THIS company's merge-commit index only; the host and repository come from the task's own pinned project (`hosts.forTask`, which reads the task only when it is the company's); the detector's
// index finds a Rovara pull request only through the company's own index rows and its own task (a revert of another company's, or of a non-Rovara, pull request matches nothing). Every row this writes sits in the company's own partition.
//
// What a found revert does (`onReverted`, called once for each NEWLY recorded revert: the detector's row is written only when absent, so a revert seen again, by another pass or another way, is not told twice): the lessons host records it as
// an outcome (never blame; where the install can name who reverted, it takes back a queued "helpful" mark, as before this lane) and puts the lessons the task loaded "under question" only for files of the lesson's own code area. No model is ever called here.
//
// Progress: one cursor row per repository (the newest commit already looked at). A commit whose check failed (the host was down) is tried again by the next pass; after `STUCK_PASSES_MAX` failed passes on the same commit it is skipped, so one
// commit can never hold a repository back for good. Every read has a total bound (repositories, commits, requests, time).
import { OrgIdSchema, companyScoped, hostRateLimitRetryAt, type ChangeRequestFilesPage, type ChangeRequestRef, type CodeHost, type DocumentStore, type HostAccount, type HostScope, type OrgId, type PageBudget, type RepositoryRef, type RecentCommit } from "@agentx/contracts";
import { MERGE_COMMIT_ENTITY } from "./merge-commit-index.js";
import { createRovaraPullRequestIndex } from "./rovara-pull-request-index.js";
import { detectRevertFromMergedChangeRequest, detectRevertFromPushedCommit, type CommitFacts, type RevertFinding } from "./revert-detect.js";

const DAY = 86_400_000;
/** Only a merge this young is watched: a revert later than this is not a "what happened after merge" signal. */
export const REVERT_WATCH_WINDOW_DAYS = 30;
/** One pass: this many repositories, this many commits each, this many revert-shaped commits checked per repository, this many merge rows read, and this long. */
export const REPOSITORIES_PER_PASS = 10;
export const COMMITS_PER_READ = 50;
export const REVERT_COMMITS_PER_REPOSITORY = 10;
export const MERGE_ROWS_PER_PASS = 2_000;
export const REQUESTS_PER_REPOSITORY = 40;
export const REPOSITORY_MS_MAX = 15_000;
/** A commit whose check failed this many passes in a row is skipped (logged), so it cannot hold its repository back for good. */
export const STUCK_PASSES_MAX = 5;
/** The files of one revert that are read (pages of 100 for a pull request; one commit read for a pushed commit): more are "not known", never a partial list. */
export const FILE_PAGES_MAX = 3;
const STATE_KEEP_DAYS = 60;
const PAGE = 200;
const SHA = /^[a-f0-9]{40,64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const REVERT_SUBJECT = /^Revert\s+["“']/iu;

/** The partition of the watch's own rows (a cursor for each repository, and where the merge-row scan stopped). */
export const revertWatchPk = (companyId: string): string => companyScoped(companyId, "REVERT_WATCH");

/** What the watch is told of a newly recorded revert. `files` is undefined when the revert's files could not be read whole (then no lesson is put under question: no overlap can be shown). */
export interface RevertedTask {
  finding: RevertFinding;
  /** The repository (lower case owner/name) the revert is in. */
  repository: string;
  files: readonly string[] | undefined;
}

export interface RevertWatchHost { codeHost: CodeHost; repository: RepositoryRef; scope: HostScope }
export interface RevertWatchHosts {
  /** The host for `repositoryFullName` as the (company's own) task's pinned project registers it, or undefined. Never another company's host. */
  forTask(orgId: OrgId, taskId: string, repositoryFullName: string): Promise<RevertWatchHost | undefined>;
}

export interface RevertWatchOptions {
  companyId: OrgId;
  store: Pick<DocumentStore, "get" | "put" | "query"> & { ttlAttribute?: string | undefined };
  hosts: RevertWatchHosts;
  /** Told once for each newly recorded revert. A throw is logged and does not undo the record. Absent: the revert row only. */
  onReverted?: ((revert: RevertedTask) => Promise<void>) | undefined;
  /** Accounts that never count as a person behind a revert (a service account). */
  isExcluded?: ((login: string) => boolean) | undefined;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  limits?: { repositories?: number; commits?: number } | undefined;
}

export interface RevertWatch {
  readonly companyId: OrgId;
  /** One periodic pass: a small report of counts for the log (fixed words and numbers only). */
  pass(options: { budgetMs: number }): Promise<Record<string, unknown>>;
}

/** The pull request number a squash or merge commit's subject names: `... (#45)` at the end, or `Merge pull request #45 ...`. */
export function pullRequestNumberOfSubject(subject: string): number | undefined {
  const squash = /\(#([1-9][0-9]{0,8})\)\s*$/u.exec(subject.trim());
  const merge = /^Merge pull request #([1-9][0-9]{0,8})\b/u.exec(subject.trim());
  const found = squash?.[1] ?? merge?.[1];
  return found === undefined ? undefined : Number(found);
}

/** Whether a commit is shaped like a revert: its subject says so, or it merges a pull request whose title (the first body line GitHub writes) says so. Cheap and local: nothing is believed from it, the detector proves the rest. */
export function looksLikeRevert(message: string): boolean {
  const lines = message.split("\n");
  const subject = (lines[0] ?? "").trim();
  if (REVERT_SUBJECT.test(subject)) return true;
  if (!/^Merge pull request #[1-9][0-9]{0,8}\b/u.test(subject)) return false;
  const title = lines.slice(1).find((line) => line.trim() !== "");
  return title !== undefined && REVERT_SUBJECT.test(title.trim());
}

function pageBudgetOf(now: () => number, limits: { requests: number; ms: number }): PageBudget & { exhausted: () => boolean } {
  const startedAt = now();
  let requests = 0;
  return {
    beforeRequest: () => {
      if (requests >= limits.requests || now() >= startedAt + limits.ms) {
        const exhausted = new Error("the revert watch used its request allowance");
        exhausted.name = "RevertWatchBudgetExhausted";
        throw exhausted;
      }
      requests += 1;
    },
    exhausted: () => requests >= limits.requests || now() >= startedAt + limits.ms,
  };
}

const factsOf = (commit: RecentCommit): CommitFacts => ({
  sha: commit.sha.toLowerCase(), message: commit.message, parents: commit.parents, verified: commit.verified,
  ...(commit.author === undefined ? {} : { author: commit.author }), ...(commit.committer === undefined ? {} : { committer: commit.committer }),
  ...(commit.webFlow === true ? { webFlow: true } : {}), ...(commit.authorIsBot === true ? { authorIsBot: true } : {}),
});

type RepositoryOutcome = "off" | "skipped" | "read" | "rate_limited" | "unavailable";

export function createRevertWatch(options: RevertWatchOptions): RevertWatch {
  const { companyId, store } = options;
  // Checked when the watch is made, not at the first pass: a bad company is a wiring bug.
  if (!OrgIdSchema.safeParse(companyId).success) throw new Error("the revert watch needs a company id");
  const log = (event: string, fields: Record<string, unknown> = {}): void => options.log?.(event, fields);
  const index = createRovaraPullRequestIndex({ store, companyId });
  const ttl = (): Record<string, number> => (store.ttlAttribute === undefined ? {} : { [store.ttlAttribute]: Math.floor(options.now() / 1000) + STATE_KEEP_DAYS * 86_400 });
  /** When the host last said slow down, until (milliseconds since the epoch). */
  let pausedUntil = 0;

  const cursorKey = (repository: string) => ({ pk: revertWatchPk(companyId), sk: `REPO#${repository}` });
  const scanKey = () => ({ pk: revertWatchPk(companyId), sk: "SCAN" });
  const rotationKey = () => ({ pk: revertWatchPk(companyId), sk: "ROTATION" });

  /** `head`: the newest commit already looked at (absent: none yet, and only a failure count is kept). */
  interface Cursor { head?: string; stuckSha?: string; stuckPasses?: number }
  async function readCursor(repository: string): Promise<Cursor | undefined> {
    const row = await store.get(cursorKey(repository));
    if (row === undefined || row["entityType"] !== "REVERT_WATCH_CURSOR" || row["repository"] !== repository) return undefined;
    const head = typeof row["head"] === "string" && SHA.test(row["head"]) ? row["head"] : undefined;
    const stuckSha = typeof row["stuckSha"] === "string" && SHA.test(row["stuckSha"]) ? row["stuckSha"] : undefined;
    const stuckPasses = typeof row["stuckPasses"] === "number" && Number.isSafeInteger(row["stuckPasses"]) && row["stuckPasses"] > 0 ? row["stuckPasses"] : undefined;
    return { ...(head === undefined ? {} : { head }), ...(stuckSha === undefined || stuckPasses === undefined ? {} : { stuckSha, stuckPasses }) };
  }
  async function writeCursor(repository: string, cursor: Cursor): Promise<void> {
    await store.put({ item: { ...cursorKey(repository), entityType: "REVERT_WATCH_CURSOR", repository, ...(cursor.head === undefined ? {} : { head: cursor.head }), ...(cursor.stuckSha === undefined ? {} : { stuckSha: cursor.stuckSha, stuckPasses: cursor.stuckPasses ?? 1 }), updatedAt: new Date(options.now()).toISOString(), ...ttl() } });
  }

  /**
   * The repositories this company merged a Rovara pull request into lately, from its own merge-commit index (`ORG#<org>#GITHUB_MERGE`), each with the newest merge's task (the host is found through it). The scan is bounded and
   * resumes where the last pass stopped (a row remembers the place), so a big company's repositories are all reached over several passes.
   */
  async function watchedRepositories(): Promise<{ repositories: Array<{ repository: string; taskId: string }>; more: boolean }> {
    const since = options.now() - REVERT_WATCH_WINDOW_DAYS * DAY;
    const pk = companyScoped(companyId, "GITHUB_MERGE");
    const saved = await store.get(scanKey());
    let cursor = saved !== undefined && saved["entityType"] === "REVERT_WATCH_SCAN" && typeof saved["cursor"] === "string" ? saved["cursor"] : undefined;
    const newest = new Map<string, { taskId: string; at: number }>();
    let rows = 0;
    let more = false;
    for (;;) {
      const page = await store.query({ pk, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
      for (const row of page.items) {
        rows += 1;
        if (row["pk"] !== pk || row["orgId"] !== companyId || row["entityType"] !== MERGE_COMMIT_ENTITY || typeof row["repositoryFullName"] !== "string" || typeof row["taskId"] !== "string" || typeof row["createdAt"] !== "string") continue;
        const at = Date.parse(row["createdAt"]);
        const repository = row["repositoryFullName"].toLowerCase();
        if (!Number.isFinite(at) || at < since || !REPOSITORY.test(repository)) continue;
        const seen = newest.get(repository);
        if (seen === undefined || at > seen.at) newest.set(repository, { taskId: row["taskId"], at });
      }
      cursor = page.cursor;
      if (cursor === undefined) break;
      if (rows >= MERGE_ROWS_PER_PASS) { more = true; break; }
    }
    // Remember where this pass stopped (or that the scan is complete, so the next pass starts over).
    await store.put({ item: { ...scanKey(), entityType: "REVERT_WATCH_SCAN", ...(cursor === undefined ? {} : { cursor }), updatedAt: new Date(options.now()).toISOString(), ...ttl() } });
    return { repositories: [...newest].map(([repository, entry]) => ({ repository, taskId: entry.taskId })).sort((a, b) => a.repository.localeCompare(b.repository)), more };
  }

  /** The files a revert pull request or revert commit touched, whole, or undefined (unreadable, or longer than the bound: no overlap can then be shown). */
  async function filesOf(host: RevertWatchHost, finding: RevertFinding, budget: PageBudget, commit: RecentCommit | undefined, ref: ChangeRequestRef | undefined): Promise<string[] | undefined> {
    try {
      if (ref !== undefined) {
        const files: string[] = [];
        let next: number | undefined = 1;
        for (let pages = 0; next !== undefined; pages += 1) {
          // More pages than the bound: the list is not whole, so nothing is claimed from it.
          if (pages >= FILE_PAGES_MAX) return undefined;
          budget.beforeRequest();
          const read: ChangeRequestFilesPage = await host.codeHost.changedFiles(ref, next, host.scope);
          for (const file of read.files) { files.push(file.path); if (file.previousPath !== undefined) files.push(file.previousPath); }
          next = read.nextPage;
        }
        return files;
      }
      if (commit !== undefined && typeof host.codeHost.commitChanges === "function") {
        const read = await host.codeHost.commitChanges(host.repository, commit.sha, host.scope, budget);
        if (!read.complete) return undefined;
        return read.files.flatMap((file) => (file.previousPath === undefined ? [file.path] : [file.path, file.previousPath]));
      }
    } catch (error) {
      log("revert_watch.files_unreadable", { level: "warn", error: error instanceof Error ? error.name : "unknown" });
    }
    return undefined;
  }

  async function tell(host: RevertWatchHost, repository: string, findings: readonly RevertFinding[], budget: PageBudget, commit: RecentCommit, ref: ChangeRequestRef | undefined): Promise<number> {
    if (findings.length === 0) return 0;
    // One read of the revert's files serves every task it reverted (a revert of two Rovara pull requests is one change).
    const files = await filesOf(host, findings[0]!, budget, commit, ref);
    for (const finding of findings) {
      log("revert_watch.found", { repository, taskId: finding.taskId });
      try { await options.onReverted?.({ finding, repository, files }); } catch { log("revert_watch.on_reverted_failed", { level: "warn" }); }
    }
    return findings.length;
  }

  async function watchRepository(repository: string, taskId: string, budget: PageBudget & { exhausted: () => boolean }): Promise<{ outcome: RepositoryOutcome; found: number; retryAt?: number }> {
    let host: RevertWatchHost | undefined;
    try { host = await options.hosts.forTask(companyId, taskId, repository); } catch { log("revert_watch.host_unavailable", { level: "warn" }); return { outcome: "unavailable", found: 0 }; }
    if (host === undefined) return { outcome: "skipped", found: 0 };
    const codeHost = host.codeHost;
    if (typeof codeHost.recentCommits !== "function") return { outcome: "skipped", found: 0 };
    let found = 0;
    try {
      const identity = await codeHost.repositoryIdentity(host.repository, host.scope);
      // The repository answered for must be the one the index named: never another repository's branch under this repository's merges.
      if (identity?.defaultBranch === undefined || identity.fullName.toLowerCase() !== repository) return { outcome: "skipped", found: 0 };
      const branch = identity.defaultBranch;
      budget.beforeRequest();
      const read = await codeHost.recentCommits(host.repository, branch, host.scope, { max: options.limits?.commits ?? COMMITS_PER_READ }, budget);
      const cursor = await readCursor(repository);
      const newestFirst = read.commits.filter((commit) => SHA.test(commit.sha));
      const seenAt = cursor?.head === undefined ? -1 : newestFirst.findIndex((commit) => commit.sha.toLowerCase() === cursor.head);
      // Commits newer than the cursor, oldest first. A cursor that is not in the list (more new commits than one read, or a rewritten branch) means the whole list is new: the detector's row makes a repeat free.
      const fresh = (seenAt === -1 ? newestFirst : newestFirst.slice(0, seenAt)).reverse();
      if (cursor?.head !== undefined && seenAt === -1) log("revert_watch.cursor_gap", { level: "warn" });
      const pushed = fresh.map((commit) => commit.sha.toLowerCase());
      const detectorDeps = {
        store, companyId, codeHost, index, now: options.now, ...(options.isExcluded === undefined ? {} : { isExcluded: options.isExcluded }),
        readCommit: async (_repository: RepositoryRef, sha: string): Promise<CommitFacts | undefined> => {
          const commit = fresh.find((candidate) => candidate.sha.toLowerCase() === sha.toLowerCase());
          return commit === undefined ? undefined : factsOf(commit);
        },
        log: (event: string, fields: Record<string, unknown>) => log(event, fields),
      };
      let handled = 0;
      let done: string | undefined; // the newest commit fully looked at
      let failedAt: string | undefined;
      for (const commit of fresh) {
        const sha = commit.sha.toLowerCase();
        if (!looksLikeRevert(commit.message)) { done = sha; continue; }
        if (handled >= REVERT_COMMITS_PER_REPOSITORY || budget.exhausted()) break;
        handled += 1;
        // A commit that already failed `STUCK_PASSES_MAX` passes is skipped (it is logged by the pass that gave up on it).
        if (cursor?.stuckSha === sha && (cursor.stuckPasses ?? 0) >= STUCK_PASSES_MAX) { log("revert_watch.commit_skipped", { level: "warn" }); done = sha; continue; }
        try {
          const number = pullRequestNumberOfSubject((commit.message.split("\n", 1)[0] ?? ""));
          if (number !== undefined) {
            const ref: ChangeRequestRef = { repository: host.repository, id: String(number), url: `${host.repository.url.replace(/\.git$/u, "").replace(/\/$/u, "")}/pull/${String(number)}` };
            found += await tell(host, repository, await detectRevertFromMergedChangeRequest(detectorDeps, ref, host.scope), budget, commit, ref);
          } else {
            const pusher: HostAccount | undefined = commit.webFlow === true ? undefined : commit.committer;
            found += await tell(host, repository, await detectRevertFromPushedCommit(detectorDeps, { repository: host.repository, branch, sha, pusher, pushedShas: pushed }, host.scope), budget, commit, undefined);
          }
          done = sha;
        } catch (error) {
          const retryAt = hostRateLimitRetryAt(error);
          if (retryAt !== undefined) { await advance(repository, cursor, done); return { outcome: "rate_limited", found, retryAt }; }
          failedAt = sha;
          log("revert_watch.commit_failed", { level: "warn", error: error instanceof Error ? error.name : "unknown" });
          break;
        }
      }
      // Whatever follows `done` was not looked at (a failure, the bounds): the cursor stays there, and the next pass starts from it.
      const complete = failedAt === undefined && handled < REVERT_COMMITS_PER_REPOSITORY && !budget.exhausted();
      await advance(repository, cursor, complete ? (fresh.length === 0 ? undefined : pushed[pushed.length - 1]) : done, failedAt, complete);
      return { outcome: "read", found };
    } catch (error) {
      const retryAt = hostRateLimitRetryAt(error);
      if (retryAt !== undefined) return { outcome: "rate_limited", found, retryAt };
      log("revert_watch.read_failed", { level: "warn", error: error instanceof Error ? error.name : "unknown" });
      return { outcome: error instanceof Error && error.name === "RevertWatchBudgetExhausted" ? "skipped" : "unavailable", found };
    }
  }

  /**
   * Saves where the repository's look got to: the cursor moves to `head` (when given), and a failed commit (`failedAt`) counts toward being skipped. A pass that read everything starts the failure count clean; a partial one that did not
   * fail keeps the count of the commit it was stuck on.
   */
  async function advance(repository: string, cursor: Cursor | undefined, head: string | undefined, failedAt?: string, complete?: boolean): Promise<void> {
    const next = head ?? cursor?.head;
    const stuck = failedAt !== undefined
      ? { stuckSha: failedAt, stuckPasses: cursor?.stuckSha === failedAt ? (cursor.stuckPasses ?? 0) + 1 : 1 }
      : complete === true || cursor?.stuckSha === undefined ? undefined : { stuckSha: cursor.stuckSha, stuckPasses: cursor.stuckPasses ?? 1 };
    if (next === undefined && stuck === undefined) return;
    if (cursor !== undefined && cursor.head === next && stuck === undefined && cursor.stuckSha === undefined) return;
    await writeCursor(repository, { ...(next === undefined ? {} : { head: next }), ...(stuck ?? {}) });
  }

  return {
    companyId,
    async pass(passOptions: { budgetMs: number }): Promise<Record<string, unknown>> {
      const deadline = options.now() + Math.max(0, passOptions.budgetMs);
      const report: Record<string, unknown> = { repositories: 0, found: 0, rateLimited: false, unavailable: 0, skipped: 0 };
      if (options.now() < pausedUntil) { report["rateLimited"] = true; return report; }
      let watched: Awaited<ReturnType<typeof watchedRepositories>>;
      try { watched = await watchedRepositories(); } catch { log("revert_watch.index_unreadable", { level: "warn" }); report["unavailable"] = 1; return report; }
      report["more"] = watched.more;
      // A company with more watched repositories than one pass reads is covered over several passes: each pass starts after the repository the last one stopped at (a row remembers it).
      const all = watched.repositories;
      const rotation = await store.get(rotationKey()).catch(() => undefined);
      const after = rotation !== undefined && rotation["entityType"] === "REVERT_WATCH_ROTATION" && typeof rotation["after"] === "string" ? rotation["after"] : undefined;
      const first = after === undefined ? -1 : all.findIndex((entry) => entry.repository > after);
      const start = first === -1 ? 0 : first;
      const turn = [...all.slice(start), ...all.slice(0, start)].slice(0, options.limits?.repositories ?? REPOSITORIES_PER_PASS);
      let last: string | undefined;
      for (const entry of turn) {
        const left = deadline - options.now();
        if (left <= 0) { report["skipped"] = (report["skipped"] as number) + 1; continue; }
        const result = await watchRepository(entry.repository, entry.taskId, pageBudgetOf(options.now, { requests: REQUESTS_PER_REPOSITORY, ms: Math.min(REPOSITORY_MS_MAX, left) }));
        // The next pass starts after this repository, except one the host would not answer (it is looked at again first).
        if (result.outcome !== "rate_limited") last = entry.repository;
        report["repositories"] = (report["repositories"] as number) + 1;
        report["found"] = (report["found"] as number) + result.found;
        if (result.outcome === "unavailable") report["unavailable"] = (report["unavailable"] as number) + 1;
        if (result.outcome === "skipped") report["skipped"] = (report["skipped"] as number) + 1;
        if (result.outcome === "rate_limited") {
          const nowMs = options.now();
          pausedUntil = Math.min(Math.max(result.retryAt ?? 0, nowMs + 60_000), nowMs + 3_600_000);
          report["rateLimited"] = true;
          break;
        }
      }
      if (last !== undefined) await store.put({ item: { ...rotationKey(), entityType: "REVERT_WATCH_ROTATION", after: last, updatedAt: new Date(options.now()).toISOString(), ...ttl() } }).catch(() => undefined);
      return report;
    },
  };
}
