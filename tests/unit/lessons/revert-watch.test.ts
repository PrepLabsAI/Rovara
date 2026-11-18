// Lane L4-LM1b: revert detection is wired. The revert watch (core/proof/revert/revert-watch.ts) calls the two revert detectors from a periodic pass over the repositories the company merged Rovara pull requests into:
// a merged revert pull request and a pushed revert commit are each recorded once (one TASK_REVERT row per Rovara pull request) and told once to `onReverted`, only for THIS company's own Rovara pull requests. A revert of
// another company's pull request, of a pull request Rovara did not make, or one nobody with write access stands behind, records and tells nothing. No model is called anywhere here (the watch has no model port).
import { describe, expect, it } from "vitest";
import { HostRateLimitError, companyScoped, type ChangeRequestFilesPage, type HostAccount, type OrgId, type RecentCommit, type RepositoryRef } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { taskKey } from "../../../packages/broker/src/developer/task-records.js";
import { mergeCommitIndexStep } from "../../../packages/broker/src/core/proof/revert/merge-commit-index.js";
import { revertRecordKey } from "../../../packages/broker/src/core/proof/revert/revert-detect.js";
import {
  COMMITS_PER_READ, MERGE_ROWS_PER_PASS, REPOSITORIES_PER_PASS, REVERT_COMMITS_PER_REPOSITORY, STUCK_PASSES_MAX, createRevertWatch, looksLikeRevert, pullRequestNumberOfSubject, revertWatchPk,
  type RevertedTask, type RevertWatchHost, type RevertWatchOptions,
} from "../../../packages/broker/src/core/proof/revert/revert-watch.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TASK = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TASK = "00000000-0000-4000-8000-0000000000b2";
const MERGE = "1".repeat(40);
const OTHER_MERGE = "9".repeat(40);
const NOW = "2026-11-09T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY = 86_400_000;
const REPO: RepositoryRef = { url: "https://github.com/acme/payments" };
const sha = (n: number): string => n.toString(16).padStart(40, "c");

/** A Rovara task with one pull request in the company, its link, and the merge commit's index row. */
async function rovaraPullRequest(store: MemoryDocumentStore, options: { taskId?: string; orgId?: OrgId; number?: number; mergeCommit?: string; repo?: string; createdAt?: string; legacyRecord?: boolean } = {}) {
  const taskId = options.taskId ?? TASK;
  const number = options.number ?? 7;
  const repo = options.repo ?? "acme/payments";
  const url = `https://github.com/${repo}/pull/${String(number)}`;
  const orgId = options.orgId ?? ORG;
  // The CORE's task record names its company `companyId` and has no `orgId` (core/task-flow/start.ts); the older record has `orgId`. Tests use the core's shape unless they ask for the older one.
  await store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, ...(options.legacyRecord === true ? { orgId } : { companyId: orgId }), project: "payments", workflow: { pullRequests: [{ repositoryId: "payments", number, url, headSha: "a".repeat(40) }] } } });
  await store.put({ item: { pk: `GITHUB_PR#${repo}`, sk: `PR#${String(number).padStart(10, "0")}`, entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: repo, number, repositoryId: "payments", taskId, workspaceId: "ws-1", candidateDigest: "c".repeat(64), url } });
  await store.transact([mergeCommitIndexStep({ orgId, repositoryFullName: repo, repositoryId: "payments", number, url, taskId, mergeCommit: options.mergeCommit ?? MERGE, now: options.createdAt ?? NOW })!]);
  return { taskId, number, url };
}

interface HostScript {
  commits: RecentCommit[];
  writers: Record<string, "admin" | "write" | "read" | "none">;
  /** The change requests the host knows, by number. */
  changeRequests: Record<number, { title: string; body: string; mergedBy: string; state?: string; targetBranch?: string; mergeRevision?: string }>;
  /** The pages of files a change request has. */
  files?: Record<number, ChangeRequestFilesPage[]>;
  commitFiles?: Record<string, { files: string[]; complete: boolean }>;
  fullName?: string;
  defaultBranch?: string;
  fail?: (call: string) => Error | undefined;
}
function scriptedHost(script: HostScript) {
  const calls: string[] = [];
  const check = (call: string): void => { calls.push(call); const error = script.fail?.(call); if (error !== undefined) throw error; };
  const codeHost = {
    kind: "github", provider: "github",
    async repositoryIdentity() { check("identity"); return { id: "1", fullName: script.fullName ?? "acme/payments", defaultBranch: script.defaultBranch ?? "main" }; },
    async recentCommits(_repository: RepositoryRef, branch: string, _scope: unknown, options: { max: number }) { check(`recent:${branch}:${String(options.max)}`); return { commits: script.commits.slice(0, options.max), complete: true }; },
    async getChangeRequest(ref: { id: string }) {
      check(`cr:${ref.id}`);
      const found = script.changeRequests[Number(ref.id)];
      if (found === undefined) throw new Error("no such change request");
      return { ref: { repository: REPO, id: ref.id, url: `https://github.com/acme/payments/pull/${ref.id}` }, state: found.state ?? "merged", sourceBranch: "revert", targetBranch: found.targetBranch ?? "main", headRevision: "4".repeat(40), mergeRevision: found.mergeRevision ?? "5".repeat(40), mergedBy: found.mergedBy, title: found.title, body: found.body };
    },
    async standing(_repository: RepositoryRef, person: HostAccount) { check(`standing:${person.login}`); return { permission: script.writers[person.login] ?? "none", accountType: "person" }; },
    async changedFiles(ref: { id: string }, page: number) {
      check(`files:${ref.id}:${String(page)}`);
      const pages = script.files?.[Number(ref.id)];
      if (pages === undefined) throw new Error("no files");
      return pages[page - 1] ?? { files: [] };
    },
    async commitChanges(_repository: RepositoryRef, revision: string) {
      check(`commit-files:${revision.slice(0, 4)}`);
      const found = script.commitFiles?.[revision];
      if (found === undefined) throw new Error("no commit");
      return { files: found.files.map((path) => ({ path, status: "modified", additions: 1, deletions: 1 })), complete: found.complete, parents: [] };
    },
  };
  return { codeHost, calls };
}

function watch(script: HostScript, options: { store?: MemoryDocumentStore; companyId?: OrgId; onReverted?: RevertWatchOptions["onReverted"]; unsupported?: boolean; now?: () => number; limits?: RevertWatchOptions["limits"]; hostsOverride?: RevertWatchOptions["hosts"] } = {}) {
  const store = options.store ?? new MemoryDocumentStore();
  const host = scriptedHost(script);
  if (options.unsupported === true) delete (host.codeHost as { recentCommits?: unknown }).recentCommits;
  const told: RevertedTask[] = [];
  const asked: Array<{ orgId: string; taskId: string; repository: string }> = [];
  const logged: string[] = [];
  const hosts: RevertWatchOptions["hosts"] = options.hostsOverride ?? {
    async forTask(orgId, taskId, repository) {
      asked.push({ orgId, taskId, repository });
      return { codeHost: host.codeHost as unknown as RevertWatchHost["codeHost"], repository: REPO, scope: { orgId } };
    },
  };
  const service = createRevertWatch({
    companyId: options.companyId ?? ORG, store, hosts, now: options.now ?? (() => NOW_MS), log: (event) => { logged.push(event); },
    onReverted: options.onReverted ?? (async (revert) => { told.push(revert); }), ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { store, service, host, told, asked, logged };
}
const pass = (w: { service: { pass(o: { budgetMs: number }): Promise<Record<string, unknown>> } }) => w.service.pass({ budgetMs: 30_000 });
const revertRows = async (store: MemoryDocumentStore, taskId = TASK) => (await store.query({ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "REVERT#" } })).items;

const squashRevert = (n: number, over: Partial<RecentCommit> = {}): RecentCommit => ({ sha: sha(n), message: `Revert "Add retry" (#${String(n)})\n\nReverts #7`, parents: 1, verified: true, author: { login: "maya", hostUserId: "10" }, committer: { login: "web-flow", hostUserId: "19864447" }, webFlow: true, ...over });
const ordinary = (n: number): RecentCommit => ({ sha: sha(n), message: `Add feature ${String(n)} (#${String(n)})`, parents: 1, verified: true, author: { login: "dev", hostUserId: "11" }, committer: { login: "web-flow", hostUserId: "19864447" }, webFlow: true });
const gitRevert = (n: number, over: Partial<RecentCommit> = {}): RecentCommit => ({
  sha: sha(n), message: `Revert "Add retry"\n\nThis reverts commit ${MERGE}.`, parents: 1, verified: true, author: { login: "maya", hostUserId: "10" }, committer: { login: "maya", hostUserId: "10" }, ...over,
});

describe("the words the watch pre-filters on (nothing is believed from them: the detector proves the rest)", () => {
  it("finds the pull request number of a squash or merge commit subject", () => {
    expect(pullRequestNumberOfSubject('Revert "Add retry" (#45)')).toBe(45);
    expect(pullRequestNumberOfSubject("Merge pull request #46 from acme/revert-44")).toBe(46);
    expect(pullRequestNumberOfSubject('Revert "Add retry"')).toBeUndefined();
    expect(pullRequestNumberOfSubject("Fix (#12) typo")).toBeUndefined();
    expect(pullRequestNumberOfSubject("Revert x (#0)")).toBeUndefined();
    expect(pullRequestNumberOfSubject("Revert x (#12345678901)")).toBeUndefined();
  });
  it("a revert-looking commit has the subject, or merges a pull request whose title (the first body line) is one", () => {
    expect(looksLikeRevert('Revert "Add retry" (#45)\n\nbody')).toBe(true);
    expect(looksLikeRevert("Revert “Add retry”")).toBe(true);
    expect(looksLikeRevert('Merge pull request #46 from acme/revert-44\n\nRevert "Add retry"')).toBe(true);
    expect(looksLikeRevert("Merge pull request #46 from acme/feature\n\nAdd retry")).toBe(false);
    expect(looksLikeRevert("Add retry\n\nThis reverts commit abc")).toBe(false);
    expect(looksLikeRevert("Reverting is hard")).toBe(false);
  });
});

describe("a merged revert pull request", () => {
  it("is detected: recorded once as a TASK_REVERT row, credited to the person who merged it, and told once with the files it touched", async () => {
    const w = watch({
      commits: [squashRevert(20), ordinary(19)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } },
      files: { 20: [{ files: [{ path: "src/retry.ts", status: "modified", additions: 1, deletions: 1 }, { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0 }] }] },
    });
    await rovaraPullRequest(w.store);
    const report = await pass(w);
    expect(report).toMatchObject({ repositories: 1, found: 1, rateLimited: false });
    expect(w.told).toHaveLength(1);
    expect(w.told[0]).toMatchObject({ repository: "acme/payments", finding: { taskId: TASK, project: "payments", number: 7, reverter: "maya", via: "5".repeat(40) }, files: ["src/retry.ts", "src/new.ts", "src/old.ts"] });
    const rows = await revertRows(w.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "TASK_REVERT", orgId: ORG, taskId: TASK, reverter: "maya", ...revertRecordKey(TASK, "acme/payments", 7) });
  });

  it("finds a task of the CORE's record shape (company named `companyId`, no `orgId`) and of the older shape (`orgId`), and not one that names no company or two that disagree", async () => {
    for (const legacyRecord of [false, true]) {
      const w = watch({ commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } } });
      await rovaraPullRequest(w.store, { legacyRecord });
      await pass(w);
      expect(w.told, String(legacyRecord)).toHaveLength(1);
    }
    for (const record of [{ project: "payments" }, { companyId: OTHER_ORG, project: "payments" }, { companyId: OTHER_ORG, orgId: ORG, project: "payments" }, { companyId: ORG, orgId: OTHER_ORG, project: "payments" }]) {
      const w = watch({ commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } } });
      await rovaraPullRequest(w.store);
      await w.store.put({ item: { ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, ...record, workflow: { pullRequests: [{ repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7", headSha: "a".repeat(40) }] } } });
      await pass(w);
      expect(w.told, JSON.stringify(record)).toEqual([]);
    }
  });

  it("a standing read that is rate limited is not 'unproven': the commit is looked at again after the wait, and a plain fault stays unproven", async () => {
    let now = NOW_MS;
    let limited = true;
    const script: HostScript = {
      commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } },
      fail: (call) => (limited && call === "standing:maya" ? new HostRateLimitError(NOW_MS + 5 * 60_000) : undefined),
    };
    const w = watch(script, { now: () => now });
    await rovaraPullRequest(w.store);
    expect(await pass(w)).toMatchObject({ rateLimited: true });
    expect(w.told).toEqual([]);
    limited = false;
    now += 6 * 60_000;
    await pass(w);
    expect(w.told).toHaveLength(1);
    const plain = watch({ ...script, fail: (call) => (call === "standing:maya" ? new Error("host down") : undefined) });
    await rovaraPullRequest(plain.store);
    await pass(plain);
    expect(plain.told).toEqual([]);
  });

  it("a merge commit style (Merge pull request #20 ... whose first body line is the revert title) is detected the same way", async () => {
    const w = watch({
      commits: [{ ...squashRevert(20), message: 'Merge pull request #20 from acme/revert-7\n\nRevert "Add retry"' }], writers: { maya: "write" },
      changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } }, files: { 20: [{ files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }] }] },
    });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told).toHaveLength(1);
  });

  it("is not recorded when the account that merged it cannot write (an unproven revert records and tells nothing)", async () => {
    const w = watch({ commits: [squashRevert(20)], writers: { maya: "read" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } } });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told).toEqual([]);
    expect(await revertRows(w.store)).toEqual([]);
  });

  it("a revert pull request that names a pull request Rovara did not make is ignored", async () => {
    const w = watch({ commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Other work"', body: "Reverts #99", mergedBy: "maya" } } });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told).toEqual([]);
    expect(await revertRows(w.store)).toEqual([]);
  });

  it("files that cannot be read (the host refuses) still record the revert, and tell it with files undefined, so no lesson is put under question", async () => {
    const w = watch({ commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } } });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told).toHaveLength(1);
    expect(w.told[0]!.files).toBeUndefined();
    expect(await revertRows(w.store)).toHaveLength(1);
  });

  it("more pages of files than the bound are not a list: files undefined, never a partial list", async () => {
    const page = (nextPage?: number): ChangeRequestFilesPage => ({ files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }], ...(nextPage === undefined ? {} : { nextPage }) });
    const w = watch({ commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } }, files: { 20: [page(2), page(3), page(4), page(5)] } });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told[0]!.files).toBeUndefined();
  });
});

describe("a pushed revert commit", () => {
  it("is detected: git's own revert shape, a verified commit by an author who can write, committed by them, with the files it touched", async () => {
    const w = watch({ commits: [gitRevert(30)], writers: { maya: "write" }, changeRequests: {}, commitFiles: { [sha(30)]: { files: ["src/retry.ts"], complete: true } } });
    await rovaraPullRequest(w.store);
    expect(await pass(w)).toMatchObject({ found: 1 });
    expect(w.told).toHaveLength(1);
    expect(w.told[0]).toMatchObject({ finding: { taskId: TASK, number: 7, via: sha(30), reverter: "maya" }, files: ["src/retry.ts"] });
    expect((await revertRows(w.store))[0]).toMatchObject({ entityType: "TASK_REVERT", via: sha(30) });
  });

  it("a commit whose files the host listed only in part has files undefined", async () => {
    const w = watch({ commits: [gitRevert(30)], writers: { maya: "write" }, changeRequests: {}, commitFiles: { [sha(30)]: { files: ["src/retry.ts"], complete: false } } });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told[0]!.files).toBeUndefined();
  });

  it.each([
    ["an unverified commit", { verified: false }],
    ["a merge commit", { parents: 2 }],
    ["a commit committed by someone else than its author", { committer: { login: "eve", hostUserId: "99" } }],
    ["an author who cannot write", { author: { login: "stranger", hostUserId: "55" }, committer: { login: "stranger", hostUserId: "55" } }],
    ["a bot author", { authorIsBot: true }],
  ] as Array<[string, Partial<RecentCommit>]>)("records nothing for %s", async (_name, over) => {
    const w = watch({ commits: [gitRevert(30, over)], writers: { maya: "write", eve: "write" }, changeRequests: {} });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told).toEqual([]);
    expect(await revertRows(w.store)).toEqual([]);
  });

  it("a commit made by the host's web committer with no pull request has no provable pusher: nothing is recorded", async () => {
    const w = watch({ commits: [gitRevert(30, { committer: { login: "web-flow", hostUserId: "19864447" }, webFlow: true })], writers: { maya: "write" }, changeRequests: {} });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told).toEqual([]);
    expect(w.host.calls.some((call) => call.startsWith("standing:web-flow"))).toBe(false);
  });

  it("names a commit that is not a Rovara merge: ignored", async () => {
    const w = watch({ commits: [{ ...gitRevert(30), message: `Revert "x"\n\nThis reverts commit ${"7".repeat(40)}.` }], writers: { maya: "write" }, changeRequests: {} });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told).toEqual([]);
  });
});

describe("company binding", () => {
  it("another company's Rovara merges are not this company's: its watch finds no repository, asks no host and tells nothing", async () => {
    const w = watch({ commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } } });
    await rovaraPullRequest(w.store, { orgId: OTHER_ORG, taskId: OTHER_TASK });
    expect(await pass(w)).toMatchObject({ repositories: 0, found: 0 });
    expect(w.asked).toEqual([]);
    expect(w.host.calls).toEqual([]);
    expect(w.told).toEqual([]);
    expect(await revertRows(w.store, OTHER_TASK)).toEqual([]);
  });

  it("a revert of another company's pull request in a repository this company also merged into is ignored (the index is the company's own)", async () => {
    const w = watch({
      commits: [{ ...gitRevert(30), message: `Revert "Theirs"\n\nThis reverts commit ${OTHER_MERGE}.` }], writers: { maya: "write" }, changeRequests: {},
    });
    await rovaraPullRequest(w.store, { taskId: TASK, number: 7, mergeCommit: MERGE });
    await rovaraPullRequest(w.store, { orgId: OTHER_ORG, taskId: OTHER_TASK, number: 8, mergeCommit: OTHER_MERGE });
    await pass(w);
    expect(w.told).toEqual([]);
    expect(await revertRows(w.store, OTHER_TASK)).toEqual([]);
    expect(await revertRows(w.store)).toEqual([]);
  });

  it("each company's watch records only its own: two companies in one store, one repository name", async () => {
    const store = new MemoryDocumentStore();
    const script: HostScript = { commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } } };
    await rovaraPullRequest(store, { orgId: ORG, taskId: TASK, number: 7, mergeCommit: MERGE });
    const a = watch(script, { store, companyId: ORG });
    const b = watch(script, { store, companyId: OTHER_ORG });
    await pass(a);
    await pass(b);
    expect(a.told).toHaveLength(1);
    expect(b.told).toEqual([]);
    expect(b.asked).toEqual([]);
    // B's own state is in B's partition: nothing of A's cursor or scan is B's.
    expect((await store.query({ pk: revertWatchPk(ORG) })).items.every((row) => String(row["pk"]).includes(ORG))).toBe(true);
    expect((await store.query({ pk: revertWatchPk(OTHER_ORG) })).items.every((row) => String(row["pk"]).includes(OTHER_ORG))).toBe(true);
  });

  it("a merge row in this company's partition that names another company (a poisoned row) is not read as this company's", async () => {
    const w = watch({ commits: [ordinary(1)], writers: {}, changeRequests: {} });
    await w.store.put({ item: { pk: companyScoped(ORG, "GITHUB_MERGE"), sk: `acme/payments#${MERGE}`, entityType: "GITHUB_WORKFLOW_MERGE", orgId: OTHER_ORG, repositoryFullName: "acme/payments", repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7", taskId: OTHER_TASK, mergeCommit: MERGE, createdAt: NOW } });
    expect(await pass(w)).toMatchObject({ repositories: 0 });
    expect(w.asked).toEqual([]);
  });

  it("asks for the host with this company's id and the task of THIS company's merge row", async () => {
    const w = watch({ commits: [ordinary(1)], writers: {}, changeRequests: {} });
    await rovaraPullRequest(w.store);
    await rovaraPullRequest(w.store, { orgId: OTHER_ORG, taskId: OTHER_TASK, number: 8, mergeCommit: OTHER_MERGE, repo: "other/repo" });
    await pass(w);
    expect(w.asked).toEqual([{ orgId: ORG, taskId: TASK, repository: "acme/payments" }]);
  });

  it("a host for another repository than the merge's is never read as this repository's", async () => {
    const w = watch({ commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } }, fullName: "acme/other" });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told).toEqual([]);
    expect(w.host.calls.some((call) => call.startsWith("recent:"))).toBe(false);
  });

  it("only merges of the window are watched", async () => {
    const w = watch({ commits: [ordinary(1)], writers: {}, changeRequests: {} });
    await rovaraPullRequest(w.store, { createdAt: new Date(NOW_MS - 31 * DAY).toISOString() });
    expect(await pass(w)).toMatchObject({ repositories: 0 });
    const fresh = watch({ commits: [ordinary(1)], writers: {}, changeRequests: {} });
    await rovaraPullRequest(fresh.store, { createdAt: new Date(NOW_MS - 29 * DAY).toISOString() });
    expect(await pass(fresh)).toMatchObject({ repositories: 1 });
  });
});

describe("one record per revert", () => {
  it("a revert seen again (the same pass repeated with the cursor lost, or by both ways) is recorded and told once", async () => {
    const w = watch({
      commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } }, files: { 20: [{ files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }] }] },
    });
    await rovaraPullRequest(w.store);
    await pass(w);
    // The cursor row is lost (a fresh store of state only): the same commit is looked at again.
    for (const row of (await w.store.query({ pk: revertWatchPk(ORG), sk: { op: "beginsWith", prefix: "REPO#" } })).items) await w.store.delete({ key: { pk: String(row["pk"]), sk: String(row["sk"]) } });
    await pass(w);
    expect(w.told).toHaveLength(1);
    expect(await revertRows(w.store)).toHaveLength(1);
  });

  it("a second revert commit for the same pull request is not told again (one row per Rovara pull request)", async () => {
    const w = watch({ commits: [gitRevert(31), gitRevert(30)], writers: { maya: "write" }, changeRequests: {}, commitFiles: { [sha(30)]: { files: ["a.ts"], complete: true }, [sha(31)]: { files: ["a.ts"], complete: true } } });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.told).toHaveLength(1);
    expect(await revertRows(w.store)).toHaveLength(1);
  });

  it("two tasks reverted by one commit are each told, with one read of the files", async () => {
    const w = watch({
      commits: [{ ...gitRevert(30), message: `Revert "Both"\n\nThis reverts commit ${MERGE}.\nThis reverts commit ${"2".repeat(40)}.` }], writers: { maya: "write" }, changeRequests: {}, commitFiles: { [sha(30)]: { files: ["a.ts"], complete: true } },
    });
    await rovaraPullRequest(w.store, { taskId: TASK, number: 7, mergeCommit: MERGE });
    await rovaraPullRequest(w.store, { taskId: OTHER_TASK, number: 8, mergeCommit: "2".repeat(40) });
    await pass(w);
    expect(w.told.map((entry) => entry.finding.taskId).sort()).toEqual([TASK, OTHER_TASK].sort());
    expect(w.host.calls.filter((call) => call.startsWith("commit-files"))).toHaveLength(1);
  });

  it("a failing onReverted does not undo the record and does not stop the pass", async () => {
    const w = watch({ commits: [gitRevert(30)], writers: { maya: "write" }, changeRequests: {}, commitFiles: { [sha(30)]: { files: ["a.ts"], complete: true } } }, { onReverted: async () => { throw new Error("lessons down"); } });
    await rovaraPullRequest(w.store);
    expect(await pass(w)).toMatchObject({ found: 1 });
    expect(await revertRows(w.store)).toHaveLength(1);
    expect(w.logged).toContain("revert_watch.on_reverted_failed");
  });
});

describe("progress: the cursor, failures and bounds", () => {
  it("a second pass looks only at commits newer than the cursor: no host call for an old revert commit", async () => {
    const script: HostScript = { commits: [squashRevert(20), ordinary(19)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } } };
    const w = watch(script);
    await rovaraPullRequest(w.store);
    await pass(w);
    const before = w.host.calls.filter((call) => call.startsWith("cr:")).length;
    await pass(w);
    expect(w.host.calls.filter((call) => call.startsWith("cr:")).length).toBe(before);
    // a new commit on top is looked at (and, being no revert, costs no detector call)
    script.commits = [ordinary(21), ...script.commits];
    await pass(w);
    expect(w.host.calls.filter((call) => call.startsWith("cr:")).length).toBe(before);
    expect(w.host.calls.filter((call) => call.startsWith("recent:main:")).length).toBe(3);
  });

  it("a commit whose check failed (the host was down) is tried again by the next pass, and the commits after it wait", async () => {
    let down = true;
    const script: HostScript = {
      commits: [squashRevert(21), squashRevert(20)], writers: { maya: "write" },
      changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" }, 21: { title: 'Revert "Add retry"', body: "Reverts #8", mergedBy: "maya" } },
      fail: (call) => (down && call === "cr:20" ? new Error("host down") : undefined),
    };
    const w = watch(script);
    await rovaraPullRequest(w.store, { taskId: TASK, number: 7, mergeCommit: MERGE });
    await rovaraPullRequest(w.store, { taskId: OTHER_TASK, number: 8, mergeCommit: "2".repeat(40) });
    await pass(w);
    expect(w.told).toEqual([]);
    expect(w.logged).toContain("revert_watch.commit_failed");
    down = false;
    await pass(w);
    expect(w.told.map((entry) => entry.finding.taskId).sort()).toEqual([TASK, OTHER_TASK].sort());
  });

  it(`a commit that failed ${String(STUCK_PASSES_MAX)} passes in a row is skipped, so it cannot hold the repository back for good`, async () => {
    const script: HostScript = {
      commits: [squashRevert(21), squashRevert(20)], writers: { maya: "write" },
      changeRequests: { 21: { title: 'Revert "Add retry"', body: "Reverts #8", mergedBy: "maya" } }, fail: (call) => (call === "cr:20" ? new Error("never works") : undefined),
    };
    const w = watch(script);
    await rovaraPullRequest(w.store, { taskId: OTHER_TASK, number: 8, mergeCommit: "2".repeat(40) });
    for (let i = 0; i < STUCK_PASSES_MAX; i += 1) await pass(w);
    expect(w.told).toEqual([]);
    await pass(w);
    expect(w.logged).toContain("revert_watch.commit_skipped");
    expect(w.told.map((entry) => entry.finding.taskId)).toEqual([OTHER_TASK]);
  });

  it("a host that says slow down stops the pass and is left alone until its time", async () => {
    let now = NOW_MS;
    const script: HostScript = { commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: {}, fail: (call) => (call.startsWith("recent:") ? new HostRateLimitError(NOW_MS + 5 * 60_000) : undefined) };
    const w = watch(script, { now: () => now });
    await rovaraPullRequest(w.store);
    expect(await pass(w)).toMatchObject({ rateLimited: true });
    const calls = w.host.calls.length;
    now += 60_000;
    expect(await pass(w)).toMatchObject({ rateLimited: true });
    expect(w.host.calls.length).toBe(calls);
  });

  it("a host that says slow down in the middle of a revert check stops the pass too, and the commit is not counted as failed (it is asked again after the wait)", async () => {
    let now = NOW_MS;
    let limited = true;
    const script: HostScript = {
      commits: [squashRevert(20)], writers: { maya: "write" }, changeRequests: { 20: { title: 'Revert "Add retry"', body: "Reverts #7", mergedBy: "maya" } },
      fail: (call) => (limited && call === "cr:20" ? new HostRateLimitError(NOW_MS + 5 * 60_000) : undefined),
    };
    const w = watch(script, { now: () => now });
    await rovaraPullRequest(w.store);
    expect(await pass(w)).toMatchObject({ rateLimited: true, found: 0 });
    expect(w.logged).not.toContain("revert_watch.commit_failed");
    const calls = w.host.calls.length;
    now += 60_000;
    await pass(w);
    expect(w.host.calls.length).toBe(calls);
    limited = false;
    now += 5 * 60_000;
    await pass(w);
    expect(w.told).toHaveLength(1);
  });

  it("a host that cannot list commits is skipped without a call; one that fails to answer is 'unavailable', never 'no reverts'", async () => {
    const off = watch({ commits: [], writers: {}, changeRequests: {} }, { unsupported: true });
    await rovaraPullRequest(off.store);
    expect(await pass(off)).toMatchObject({ skipped: 1, found: 0 });
    const broken = watch({ commits: [], writers: {}, changeRequests: {}, fail: (call) => (call === "identity" ? new Error("down") : undefined) });
    await rovaraPullRequest(broken.store);
    expect(await pass(broken)).toMatchObject({ unavailable: 1, found: 0 });
  });

  it(`reads at most ${String(COMMITS_PER_READ)} commits a repository and checks at most ${String(REVERT_COMMITS_PER_REPOSITORY)} revert-shaped ones a pass`, async () => {
    const commits = Array.from({ length: 30 }, (_, i) => squashRevert(100 + i));
    const changeRequests: HostScript["changeRequests"] = {};
    for (const commit of commits) changeRequests[Number(/#(\d+)/u.exec(commit.message)![1])] = { title: 'Revert "x"', body: "Reverts #99", mergedBy: "maya" };
    const w = watch({ commits, writers: { maya: "write" }, changeRequests });
    await rovaraPullRequest(w.store);
    await pass(w);
    expect(w.host.calls.find((call) => call.startsWith("recent:"))).toBe(`recent:main:${String(COMMITS_PER_READ)}`);
    expect(w.host.calls.filter((call) => call.startsWith("cr:"))).toHaveLength(REVERT_COMMITS_PER_REPOSITORY);
  });

  it(`one pass looks at ${String(REPOSITORIES_PER_PASS)} repositories at most, and the start moves so all are reached`, async () => {
    let now = NOW_MS;
    const repos = Array.from({ length: 13 }, (_, i) => `acme/r${String(i).padStart(2, "0")}`);
    const w = watch({ commits: [ordinary(1)], writers: {}, changeRequests: {} }, { now: () => now });
    for (const [i, repo] of repos.entries()) await rovaraPullRequest(w.store, { taskId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, repo, number: i + 1, mergeCommit: sha(500 + i) });
    expect(await pass(w)).toMatchObject({ repositories: REPOSITORIES_PER_PASS });
    const first = new Set(w.asked.map((entry) => entry.repository));
    expect(first.size).toBe(REPOSITORIES_PER_PASS);
    // The next pass starts after the last repository of the first, wrapping: together they reach all 13.
    now += 60_000;
    await pass(w);
    expect(new Set(w.asked.map((entry) => entry.repository)).size).toBe(13);
    expect(w.asked.slice(REPOSITORIES_PER_PASS)[0]!.repository).toBe(repos[REPOSITORIES_PER_PASS]);
  });

  it(`a merge-row scan stops at ${String(MERGE_ROWS_PER_PASS)} rows, says more remain, and resumes there on the next pass`, async () => {
    const store = new MemoryDocumentStore();
    const pk = companyScoped(ORG, "GITHUB_MERGE");
    for (let i = 0; i < MERGE_ROWS_PER_PASS + 50; i += 1) await store.put({ item: { pk, sk: `acme/r${String(i).padStart(5, "0")}#${sha(i)}`, entityType: "SOMETHING_ELSE" } });
    const w = watch({ commits: [], writers: {}, changeRequests: {} }, { store });
    expect(await pass(w)).toMatchObject({ more: true });
    expect(await pass(w)).toMatchObject({ more: false });
  });

  it("a pass with no time left looks at nothing", async () => {
    const w = watch({ commits: [ordinary(1)], writers: {}, changeRequests: {} });
    await rovaraPullRequest(w.store);
    expect(await w.service.pass({ budgetMs: 0 })).toMatchObject({ repositories: 0, skipped: 1 });
    expect(w.host.calls).toEqual([]);
  });
});

describe("no lesson is touched and no model is called", () => {
  it("the watch is told only through onReverted: with none given it writes the revert row and its own cursor, and nothing else", async () => {
    const store = new MemoryDocumentStore();
    const hosts: RevertWatchOptions["hosts"] = { forTask: async (orgId) => ({ codeHost: scriptedHost({ commits: [gitRevert(30)], writers: { maya: "write" }, changeRequests: {}, commitFiles: { [sha(30)]: { files: ["a.ts"], complete: true } } }).codeHost as unknown as RevertWatchHost["codeHost"], repository: REPO, scope: { orgId } }) };
    await rovaraPullRequest(store);
    const service = createRevertWatch({ companyId: ORG, store, hosts, now: () => NOW_MS });
    await service.pass({ budgetMs: 30_000 });
    const kinds = new Set<string>();
    for (const pk of [revertWatchPk(ORG), `DEVTASK#${TASK}`, companyScoped(ORG, "GITHUB_MERGE")]) for (const row of (await store.query({ pk })).items) kinds.add(row["entityType"] as string);
    expect([...kinds].sort()).toEqual(["DEVELOPER_TASK", "GITHUB_WORKFLOW_MERGE", "REVERT_WATCH_CURSOR", "REVERT_WATCH_ROTATION", "REVERT_WATCH_SCAN", "TASK_REVERT"].sort());
  });

  it("the watch is built with no model dependency at all (its options name no model, key, spend or admission port)", () => {
    const options = ["companyId", "store", "hosts", "onReverted", "isExcluded", "now", "log", "limits"];
    const w = watch({ commits: [], writers: {}, changeRequests: {} });
    expect(Object.keys(w.service).sort()).toEqual(["companyId", "pass"]);
    expect(options.some((name) => /model|key|spend|admission|judge|reflect/iu.test(name))).toBe(false);
  });
});
