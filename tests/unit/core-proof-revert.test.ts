// Revert detection without the Team record. A Rovara pull request that is later reverted is recorded once as a fact about the task, from what the code host says, and only when a person who can write to the
// repository stands behind the revert (the one who merged the revert pull request, or the author and pusher of the revert commit). Anything unproven records nothing.
import { describe, expect, it } from "vitest";
import type { ChangeRequestDetails, HostAccount, OrgId, RepositoryRef } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { codeHostRepositoryKey } from "../../packages/broker/src/core/proof/revert/repository-key.js";
import { findLinkedChangeRequest, linkedChangeRequestKey, linkedChangeRequestStep } from "../../packages/broker/src/core/proof/revert/linked-change-requests.js";
import { findMergeCommit, githubPullRequestAddress, mergeCommitIndexStep, mergeCommitKey } from "../../packages/broker/src/core/proof/revert/merge-commit-index.js";
import { createRovaraPullRequestIndex } from "../../packages/broker/src/core/proof/revert/rovara-pull-request-index.js";
import {
  detectRevertFromMergedChangeRequest, detectRevertFromPushedCommit, gitRevertedCommits, revertRecordKey, revertedCommits, revertedPullRequests, type CommitFacts, type RevertDetectorDependencies,
} from "../../packages/broker/src/core/proof/revert/revert-detect.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TASK = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TASK = "00000000-0000-4000-8000-0000000000b2";
const MERGE = "1".repeat(40);
const URL7 = "https://github.com/acme/payments/pull/7";
const REPO: RepositoryRef = { url: "https://github.com/acme/payments" };
const SCOPE = { system: "install" } as const;
const NOW = "2026-11-09T12:00:00.000Z";

describe("the neutral identity of a repository", () => {
  it("is GitHub's owner/name in lower case, however the address is spelled", () => {
    for (const address of ["https://github.com/Acme/Payments", "https://github.com/acme/payments.git", "https://GitHub.com/acme/payments"]) {
      expect(codeHostRepositoryKey("github", address), address).toBe("acme/payments");
    }
  });

  it("is nothing for another host's address under GitHub's kind, a path of the wrong shape, or an address with credentials", () => {
    for (const address of ["https://gitlab.com/acme/payments", "https://github.com/acme", "https://github.com/acme/payments/extra", "https://user:pw@github.com/acme/payments", "ftp://github.com/acme/payments", "not a url", "https://github.com/a b/c", "http://github.com/acme/payments", "https://www.github.com/acme/payments", "https://github.com:8443/acme/payments", "https://github.com/acme/payments?x=1", "https://github.com/acme/payments#x", "https://github.com/ac_me/payments", "https://github.com/ac.me/payments", "https://github.com/acme/pay%20ments"]) {
      expect(codeHostRepositoryKey("github", address), address).toBeUndefined();
    }
  });

  it("is the kind and the normalised address for any other host", () => {
    expect(codeHostRepositoryKey("examplehost", "https://Code.Example.com/team/app.git/")).toBe("examplehost:https://code.example.com/team/app");
    expect(codeHostRepositoryKey("examplehost", "https://user@code.example.com/team/app")).toBeUndefined();
    expect(codeHostRepositoryKey("examplehost", "https://code.example.com/team/#x")).toBe("examplehost:https://code.example.com/team");
  });
});

describe("the merge commit index", () => {
  it("keys by company, repository and commit, all lower case, and refuses what GitHub could not have issued", () => {
    const key = mergeCommitKey(ORG, "Acme/Payments", MERGE.toUpperCase());
    expect(key).toEqual({ pk: `ORG#${ORG}#GITHUB_MERGE`, sk: `acme/payments#${MERGE}` });
    expect(mergeCommitKey(ORG, "acme", MERGE)).toBeUndefined();
    expect(mergeCommitKey(ORG, "acme/payments", "abc")).toBeUndefined();
    expect(githubPullRequestAddress(URL7)).toEqual({ repositoryFullName: "acme/payments", number: 7 });
    expect(githubPullRequestAddress("https://example.test/acme/payments/pull/7")).toBeUndefined();
  });

  it("is written in the merge's transaction and found by the same company, repository and commit only", async () => {
    const store = new MemoryDocumentStore();
    const step = mergeCommitIndexStep({ orgId: ORG, repositoryFullName: "acme/payments", repositoryId: "payments", number: 7, url: URL7, taskId: TASK, mergeCommit: MERGE, now: NOW })!;
    expect(await store.transact([step])).toEqual({ applied: true });
    expect(await store.transact([step])).toEqual({ applied: true });
    expect(await findMergeCommit(store, { orgId: ORG, repositoryFullName: "ACME/payments", sha: MERGE })).toMatchObject({ taskId: TASK, number: 7, mergeCommit: MERGE });
    expect(await findMergeCommit(store, { orgId: OTHER_ORG, repositoryFullName: "acme/payments", sha: MERGE })).toBeUndefined();
    expect(await findMergeCommit(store, { orgId: ORG, repositoryFullName: "acme/other", sha: MERGE })).toBeUndefined();
    expect(await findMergeCommit(store, { orgId: ORG, repositoryFullName: "acme/payments", sha: "2".repeat(40) })).toBeUndefined();
    expect(mergeCommitIndexStep({ orgId: ORG, repositoryFullName: "acme", repositoryId: "p", number: 7, url: URL7, taskId: TASK, mergeCommit: MERGE, now: NOW })).toBeUndefined();
  });

  it("a row that does not say what its key says is not a row", async () => {
    const store = new MemoryDocumentStore();
    const key = mergeCommitKey(ORG, "acme/payments", MERGE)!;
    await store.put({ item: { ...key, entityType: "GITHUB_WORKFLOW_MERGE", orgId: OTHER_ORG, repositoryFullName: "acme/payments", repositoryId: "p", number: 7, url: URL7, taskId: TASK, mergeCommit: MERGE, createdAt: NOW } });
    expect(await findMergeCommit(store, { orgId: ORG, repositoryFullName: "acme/payments", sha: MERGE })).toBeUndefined();
    await store.put({ item: { ...key, entityType: "SOMETHING" } });
    expect(await findMergeCommit(store, { orgId: ORG, repositoryFullName: "acme/payments", sha: MERGE })).toBeUndefined();
  });
});

describe("the link from a change request to its task", () => {
  const link = (taskId = TASK) => ({ hostKind: "examplehost", repositoryAddress: "https://code.example.com/team/app", changeRequestId: "12", repositoryId: "app", number: 12, url: "https://code.example.com/team/app/cr/12", taskId, workspaceId: "ws-1", candidateDigest: "c".repeat(64), createdAt: NOW });

  it("keys a whole-number id so it sorts, and refuses an id that could widen the key", () => {
    expect(linkedChangeRequestKey("github", "https://github.com/acme/payments", "7")).toEqual({ pk: "CODEHOST_CR#github#acme/payments", sk: "CR#0000000007" });
    expect(linkedChangeRequestKey("github", "https://github.com/acme/payments", "a#b")).toBeUndefined();
    expect(linkedChangeRequestKey("github", "https://gitlab.com/acme/payments", "7")).toBeUndefined();
  });

  it("is written only when absent, so a second task can never take a change request, and read back", async () => {
    const store = new MemoryDocumentStore();
    expect(await store.transact([linkedChangeRequestStep(link())!])).toEqual({ applied: true });
    expect(await store.transact([linkedChangeRequestStep(link(OTHER_TASK))!])).toMatchObject({ applied: false });
    expect(await findLinkedChangeRequest(store, { hostKind: "examplehost", repositoryAddress: "https://code.example.com/team/app", id: "12" })).toMatchObject({ source: "neutral", taskId: TASK, number: 12 });
    expect(await findLinkedChangeRequest(store, { hostKind: "examplehost", repositoryAddress: "https://code.example.com/team/app", id: "13" })).toBeUndefined();
    expect(await findLinkedChangeRequest(store, { hostKind: "other", repositoryAddress: "https://code.example.com/team/app", id: "12" })).toBeUndefined();
  });

  it("reads GitHub's older row when there is no neutral one, only for the right repository and number", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { pk: "GITHUB_PR#acme/payments", sk: "PR#0000000007", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/payments", number: 7, repositoryId: "payments", taskId: TASK, workspaceId: "ws-1", candidateDigest: "c".repeat(64), url: URL7 } });
    expect(await findLinkedChangeRequest(store, { hostKind: "github", repositoryAddress: "https://github.com/Acme/Payments", id: "7" })).toMatchObject({ source: "github-legacy", taskId: TASK, url: URL7 });
    expect(await findLinkedChangeRequest(store, { hostKind: "github", repositoryAddress: "https://github.com/acme/payments", id: "8" })).toBeUndefined();
    expect(await findLinkedChangeRequest(store, { hostKind: "github", repositoryAddress: "https://github.com/acme/payments", id: "07" })).toBeUndefined();
  });

  it("a neutral row that is not a link for its key is a refusal, not a miss to be filled from the older row", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { pk: "GITHUB_PR#acme/payments", sk: "PR#0000000007", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/payments", number: 7, repositoryId: "payments", taskId: TASK, workspaceId: "ws-1", candidateDigest: "c".repeat(64), url: URL7 } });
    await store.put({ item: { ...linkedChangeRequestKey("github", "https://github.com/acme/payments", "7")!, entityType: "CODEHOST_WORKFLOW_CR", hostKind: "github", repositoryKey: "acme/other", changeRequestId: "7" } });
    expect(await findLinkedChangeRequest(store, { hostKind: "github", repositoryAddress: "https://github.com/acme/payments", id: "7" })).toBeUndefined();
  });
});

/** A Rovara task with one pull request, linked in the old GitHub way, in the company. */
async function rovaraPullRequest(store: MemoryDocumentStore, options: { taskId?: string; orgId?: string; number?: number; mergeCommit?: string | false } = {}) {
  const taskId = options.taskId ?? TASK;
  const number = options.number ?? 7;
  const url = `https://github.com/acme/payments/pull/${String(number)}`;
  await store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, orgId: options.orgId ?? ORG, project: "payments", workflow: { pullRequests: [{ repositoryId: "payments", number, url, headSha: "a".repeat(40) }] } } });
  await store.put({ item: { pk: "GITHUB_PR#acme/payments", sk: `PR#${String(number).padStart(10, "0")}`, entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/payments", number, repositoryId: "payments", taskId, workspaceId: "ws-1", candidateDigest: "c".repeat(64), url } });
  if (options.mergeCommit !== false) {
    const step = mergeCommitIndexStep({ orgId: ORG, repositoryFullName: "acme/payments", repositoryId: "payments", number, url, taskId, mergeCommit: options.mergeCommit ?? MERGE, now: NOW })!;
    await store.transact([step]);
  }
  return { taskId, number, url };
}

describe("finding Rovara's own pull requests", () => {
  it("finds one by number and by merge commit, only for this company's task", async () => {
    const store = new MemoryDocumentStore();
    await rovaraPullRequest(store);
    const index = createRovaraPullRequestIndex({ store, companyId: ORG });
    expect(await index.byNumber({ host: "github", repo: "acme/payments", number: 7 })).toEqual({ taskId: TASK, project: "payments", number: 7, url: URL7, candidateHeadSha: "a".repeat(40) });
    expect(await index.byMergeCommit({ host: "github", repo: "acme/payments", sha: MERGE })).toMatchObject({ taskId: TASK, number: 7, mergeCommitSha: MERGE });
    const other = createRovaraPullRequestIndex({ store, companyId: OTHER_ORG });
    expect(await other.byNumber({ host: "github", repo: "acme/payments", number: 7 })).toBeUndefined();
    expect(await other.byMergeCommit({ host: "github", repo: "acme/payments", sha: MERGE })).toBeUndefined();
  });

  it("finds nothing for another host, another number, or a pull request the task does not record at that address", async () => {
    const store = new MemoryDocumentStore();
    await rovaraPullRequest(store);
    const index = createRovaraPullRequestIndex({ store, companyId: ORG });
    expect(await index.byNumber({ host: "examplehost", repo: "acme/payments", number: 7 })).toBeUndefined();
    expect(await index.byNumber({ host: "github", repo: "acme/payments", number: 8 })).toBeUndefined();
    expect(await index.byMergeCommit({ host: "github", repo: "acme/payments", sha: "2".repeat(40) })).toBeUndefined();
    // The task records another address for that number: not this pull request.
    await store.update({ key: taskKey(TASK), ops: [{ op: "set", path: ["workflow"], value: { pullRequests: [{ repositoryId: "payments", number: 7, url: "https://github.com/acme/elsewhere/pull/7", headSha: "a".repeat(40) }] } }] });
    expect(await index.byNumber({ host: "github", repo: "acme/payments", number: 7 })).toBeUndefined();
  });

  it("a merge commit row that names another task than the link does is a miss: a revert is never recorded against the wrong task", async () => {
    const store = new MemoryDocumentStore();
    await rovaraPullRequest(store);
    await store.transact([mergeCommitIndexStep({ orgId: ORG, repositoryFullName: "acme/payments", repositoryId: "payments", number: 7, url: URL7, taskId: OTHER_TASK, mergeCommit: "3".repeat(40), now: NOW })!]);
    const index = createRovaraPullRequestIndex({ store, companyId: ORG });
    expect(await index.byMergeCommit({ host: "github", repo: "acme/payments", sha: "3".repeat(40) })).toBeUndefined();
  });

  it("gives the step that keeps a merge commit, which the same index then finds", async () => {
    const store = new MemoryDocumentStore();
    await rovaraPullRequest(store, { mergeCommit: false });
    const index = createRovaraPullRequestIndex({ store, companyId: ORG });
    expect(await index.byMergeCommit({ host: "github", repo: "acme/payments", sha: MERGE })).toBeUndefined();
    await store.transact([index.mergeStep({ repo: "acme/payments", repositoryId: "payments", number: 7, url: URL7, taskId: TASK, mergeCommitSha: MERGE, now: NOW })!]);
    expect(await index.byMergeCommit({ host: "github", repo: "acme/payments", sha: MERGE })).toMatchObject({ taskId: TASK });
  });
});

describe("the words of a revert", () => {
  it("git's own revert shape is a subject that starts Revert and a body line that starts with the sentence; a mention is not a revert", () => {
    expect(gitRevertedCommits(`Revert "Add retry"\n\nThis reverts commit ${MERGE}.\n`)).toEqual([MERGE]);
    // One length rule with the commit id pattern (review L4): a 64-digit id and one up to 128 are read; 39 digits are not an id.
    const long = "ab".repeat(32);
    const longest = "cd".repeat(64);
    expect(gitRevertedCommits(`Revert "x"\n\nThis reverts commit ${long}.\n`)).toEqual([long]);
    expect(gitRevertedCommits(`Revert "x"\n\nThis reverts commit ${longest}.\n`)).toEqual([longest]);
    expect(gitRevertedCommits(`Revert "x"\n\nThis reverts commit ${"a".repeat(39)}.\n`)).toEqual([]);
    expect(revertedCommits(`This reverts commit ${long}`)).toEqual([long]);
    expect(gitRevertedCommits(`Add retry\n\nThis reverts commit ${MERGE}.`)).toEqual([]);
    expect(gitRevertedCommits(`Revert "x"\n\n> This reverts commit ${MERGE}`)).toEqual([]);
    expect(gitRevertedCommits(`Revert "x"\n\nWe discussed that this reverts commit ${MERGE}`)).toEqual([]);
    expect(gitRevertedCommits("Revert “Smart quotes”\n\nThis reverts commit " + MERGE)).toEqual([MERGE]);
  });

  it("names commits and pull requests of this repository only", () => {
    expect(revertedCommits(`Reverts it.\nThis reverts commit ${MERGE.toUpperCase()}`)).toEqual([MERGE]);
    expect(revertedPullRequests("Reverts #7 and Reverts acme/payments#8", "acme/payments")).toEqual([7, 8]);
    expect(revertedPullRequests("Reverts other/repo#9", "acme/payments")).toEqual([]);
    expect(revertedPullRequests("Reverts #99999999999", "acme/payments")).toEqual([]);
  });
});

interface HostState {
  writers: Record<string, "admin" | "write" | "read" | "none">;
  bots?: string[];
  others?: string[];
  defaultBranch?: string | undefined;
  details: Partial<ChangeRequestDetails>;
  standingFails?: boolean;
}
function detector(state: HostState, extra: Partial<RevertDetectorDependencies> = {}) {
  const store = new MemoryDocumentStore();
  const logged: string[] = [];
  const standingCalls: string[] = [];
  const codeHost = {
    kind: "github",
    repositoryIdentity: async () => ({ id: "1", fullName: "acme/payments", ...("defaultBranch" in state ? (state.defaultBranch === undefined ? {} : { defaultBranch: state.defaultBranch }) : { defaultBranch: "main" }) }),
    getChangeRequest: async () => ({
      ref: { repository: REPO, id: "20", url: "https://github.com/acme/payments/pull/20" }, state: "merged", sourceBranch: "revert-7", targetBranch: "main", headRevision: "4".repeat(40), mergeRevision: "5".repeat(40),
      mergedBy: "maya", title: 'Revert "Add retry"', body: "Reverts #7", ...state.details,
    }),
    standing: async (_repo: RepositoryRef, person: HostAccount) => {
      standingCalls.push(person.login);
      if (state.standingFails === true) throw new Error("host down");
      return { permission: state.writers[person.login] ?? "none", accountType: state.bots?.includes(person.login) === true ? "bot" : state.others?.includes(person.login) === true ? "other" : "person" };
    },
  } as unknown as RevertDetectorDependencies["codeHost"];
  const index = createRovaraPullRequestIndex({ store, companyId: ORG });
  const deps: RevertDetectorDependencies = { store, companyId: ORG, codeHost, index, now: () => Date.parse(NOW), log: (event) => { logged.push(event); }, ...extra };
  return { store, deps, logged, standingCalls };
}
const REF = { repository: REPO, id: "20", url: "https://github.com/acme/payments/pull/20" };

describe("a merged revert pull request", () => {
  it("records the Rovara pull request it reverts, once, credited to the person who merged it", async () => {
    const t = detector({ writers: { maya: "write" }, details: {} });
    await rovaraPullRequest(t.store);
    const found = await detectRevertFromMergedChangeRequest(t.deps, REF, SCOPE);
    expect(found).toEqual([{ taskId: TASK, project: "payments", number: 7, url: URL7, via: "5".repeat(40), reverter: "maya" }]);
    expect(await t.store.get(revertRecordKey(TASK, "acme/payments", 7))).toMatchObject({ entityType: "TASK_REVERT", orgId: ORG, taskId: TASK, project: "payments", number: 7, reverter: "maya", detectedAt: NOW });
    // However many deliveries tell of it, it is recorded once.
    expect(await detectRevertFromMergedChangeRequest(t.deps, REF, SCOPE)).toEqual([]);
  });

  it("finds the pull request by the merge commit the body names too, and records one revert per task however many ways name it", async () => {
    const t = detector({ writers: { maya: "admin" }, details: { body: `Reverts #7\n\nThis reverts commit ${MERGE}` } });
    await rovaraPullRequest(t.store);
    expect(await detectRevertFromMergedChangeRequest(t.deps, REF, SCOPE)).toHaveLength(1);
    const byCommit = detector({ writers: { maya: "write" }, details: { body: `This reverts commit ${MERGE}` } });
    await rovaraPullRequest(byCommit.store);
    expect(await detectRevertFromMergedChangeRequest(byCommit.deps, REF, SCOPE)).toHaveLength(1);
  });

  it("records nothing when the person who merged it cannot write, is a bot or another kind of account (an organization, an unknown kind), or cannot be told", async () => {
    for (const state of [{ writers: { maya: "read" as const } }, { writers: { maya: "none" as const } }, { writers: { maya: "write" as const }, bots: ["maya"] }, { writers: { maya: "write" as const }, others: ["maya"] }, { writers: { maya: "write" as const }, standingFails: true }]) {
      const t = detector({ ...state, details: {} });
      await rovaraPullRequest(t.store);
      expect(await detectRevertFromMergedChangeRequest(t.deps, REF, SCOPE), JSON.stringify(state)).toEqual([]);
      expect(await t.store.get(revertRecordKey(TASK, "acme/payments", 7))).toBeUndefined();
    }
    const noMerger = detector({ writers: { maya: "write" }, details: { mergedBy: undefined } });
    await rovaraPullRequest(noMerger.store);
    expect(await detectRevertFromMergedChangeRequest(noMerger.deps, REF, SCOPE)).toEqual([]);
  });

  it("records nothing for a change request that is not a merged revert into the default branch", async () => {
    for (const details of [{ state: "open" as const }, { state: "closed" as const }, { targetBranch: "release" }, { title: "Add retry again" }, { body: "no reference" }, { body: "Reverts other/repo#7" }]) {
      const t = detector({ writers: { maya: "write" }, details });
      await rovaraPullRequest(t.store);
      expect(await detectRevertFromMergedChangeRequest(t.deps, REF, SCOPE), JSON.stringify(details)).toEqual([]);
    }
    const noDefault = detector({ writers: { maya: "write" }, defaultBranch: undefined, details: {} });
    await rovaraPullRequest(noDefault.store);
    expect(await detectRevertFromMergedChangeRequest(noDefault.deps, REF, SCOPE)).toEqual([]);
  });

  it("records nothing for a pull request that is not Rovara's, or is another company's, and asks about standing only when a Rovara pull request is named", async () => {
    const notRovara = detector({ writers: { maya: "write" }, details: { body: "Reverts #99" } });
    await rovaraPullRequest(notRovara.store);
    expect(await detectRevertFromMergedChangeRequest(notRovara.deps, REF, SCOPE)).toEqual([]);
    expect(notRovara.standingCalls).toEqual([]);
    const foreign = detector({ writers: { maya: "write" }, details: {} });
    await rovaraPullRequest(foreign.store, { orgId: OTHER_ORG });
    expect(await detectRevertFromMergedChangeRequest(foreign.deps, REF, SCOPE)).toEqual([]);
  });
});

describe("a revert commit pushed to the default branch", () => {
  const commit = (overrides: Partial<CommitFacts> = {}): CommitFacts => ({
    sha: "6".repeat(40), message: `Revert "Add retry"\n\nThis reverts commit ${MERGE}.\n`, parents: 1, verified: true, author: { login: "maya", hostUserId: "10" }, committer: { login: "maya", hostUserId: "10" }, ...overrides,
  });
  const push = (overrides: Partial<{ branch: string; sha: string; pusher: HostAccount | undefined; pushedShas: string[] }> = {}) => ({ repository: REPO, branch: "main", sha: "6".repeat(40), pusher: { login: "maya", hostUserId: "10" } as HostAccount | undefined, pushedShas: ["5".repeat(40), "6".repeat(40)], ...overrides });

  it("records the reverted pull request when the commit is an ordinary verified commit authored and pushed by people who can write", async () => {
    const t = detector({ writers: { maya: "write" }, details: {} }, { readCommit: async () => commit() });
    await rovaraPullRequest(t.store);
    expect(await detectRevertFromPushedCommit(t.deps, push(), SCOPE)).toEqual([{ taskId: TASK, project: "payments", number: 7, url: URL7, via: "6".repeat(40), reverter: "maya" }]);
    expect(await detectRevertFromPushedCommit(t.deps, push(), SCOPE)).toEqual([]);
  });

  it("the host's web committer stands for the author on a squash or a web edit", async () => {
    const t = detector({ writers: { maya: "write" }, details: {} }, { readCommit: async () => commit({ committer: { login: "web-flow" }, webFlow: true }) });
    await rovaraPullRequest(t.store);
    expect(await detectRevertFromPushedCommit(t.deps, push(), SCOPE)).toHaveLength(1);
  });

  it("records nothing when any part of the proof is missing: a merge, an unverified commit, another committer, an author or pusher who cannot write, no pusher, a bot", async () => {
    const cases: Array<[string, Partial<CommitFacts>, Parameters<typeof push>[0]?, HostState["writers"]?]> = [
      ["a merge", { parents: 2 }], ["unverified", { verified: false }], ["another committer", { committer: { login: "eve", hostUserId: "66" } }],
      ["no author", { author: undefined }], ["a bot author", { authorIsBot: true }], ["no pusher", {}, { pusher: undefined }],
      ["a committer matched by login only", { committer: { login: "maya" }, author: { login: "maya" } }], ["a [bot] author", { author: { login: "dependabot[bot]", hostUserId: "10" }, committer: { login: "dependabot[bot]", hostUserId: "10" } }],
      ["a commit this push did not carry", {}, { pushedShas: ["5".repeat(40)] }], ["a pusher who cannot write", {}, { pusher: { login: "eve", hostUserId: "66" } }], ["an author who cannot write", {}, {}, { maya: "read" }],
    ];
    for (const [name, facts, pushed, writers] of cases) {
      const t = detector({ writers: writers ?? { maya: "write", eve: "none" }, details: {} }, { readCommit: async () => commit(facts) });
      await rovaraPullRequest(t.store);
      expect(await detectRevertFromPushedCommit(t.deps, push(pushed), SCOPE), name).toEqual([]);
      expect(await t.store.get(revertRecordKey(TASK, "acme/payments", 7)), name).toBeUndefined();
    }
  });

  it("records nothing for a push to another branch, a commit that is not a git revert, a commit the host shows differently, or when the host cannot show commits", async () => {
    const t = detector({ writers: { maya: "write" }, details: {} }, { readCommit: async () => commit() });
    await rovaraPullRequest(t.store);
    expect(await detectRevertFromPushedCommit(t.deps, push({ branch: "release" }), SCOPE)).toEqual([]);
    expect(await detectRevertFromPushedCommit(t.deps, push({ sha: "not a sha" }), SCOPE)).toEqual([]);
    const plain = detector({ writers: { maya: "write" }, details: {} }, { readCommit: async () => commit({ message: `Add retry\n\nThis reverts commit ${MERGE}` }) });
    await rovaraPullRequest(plain.store);
    expect(await detectRevertFromPushedCommit(plain.deps, push(), SCOPE)).toEqual([]);
    const other = detector({ writers: { maya: "write" }, details: {} }, { readCommit: async () => commit({ sha: "7".repeat(40) }) });
    await rovaraPullRequest(other.store);
    expect(await detectRevertFromPushedCommit(other.deps, push(), SCOPE)).toEqual([]);
    const none = detector({ writers: { maya: "write" }, details: {} });
    await rovaraPullRequest(none.store);
    expect(await detectRevertFromPushedCommit(none.deps, push(), SCOPE)).toEqual([]);
  });

  it("an excluded account never counts, whatever its standing", async () => {
    const t = detector({ writers: { maya: "write" }, details: {} }, { readCommit: async () => commit(), isExcluded: (login) => login === "maya" });
    await rovaraPullRequest(t.store);
    expect(await detectRevertFromPushedCommit(t.deps, push(), SCOPE)).toEqual([]);
    const merged = detector({ writers: { maya: "write" }, details: {} }, { isExcluded: (login) => login === "maya" });
    await rovaraPullRequest(merged.store);
    expect(await detectRevertFromMergedChangeRequest(merged.deps, REF, SCOPE)).toEqual([]);
    const botMerger = detector({ writers: { "ci[bot]": "write" }, details: { mergedBy: "ci[bot]" } });
    await rovaraPullRequest(botMerger.store);
    expect(await detectRevertFromMergedChangeRequest(botMerger.deps, REF, SCOPE)).toEqual([]);
  });

  it("a revert of a revert names the first revert's commit, which matches nothing: the task stays reverted", async () => {
    const t = detector({ writers: { maya: "write" }, details: {} }, { readCommit: async () => commit({ message: `Revert "Revert \\"Add retry\\""\n\nThis reverts commit ${"6".repeat(40)}.` }) });
    await rovaraPullRequest(t.store);
    expect(await detectRevertFromPushedCommit(t.deps, push(), SCOPE)).toEqual([]);
  });
});
