// Owner decision D1 (2026-11-08): Rovara may force-push a branch only when ONLY Rovara has ever written to it; a branch a person pushed to is never rewritten, and Rovara falls back to a merge there.
// These tests hold the rules: the record of who wrote to a branch (sticky, and no record is no proof), the choice between a restack and a merge, the one way a force-push is spelled (a lease on the
// task's own branch at the head Rovara recorded), and what a finished restack is (from what the host shows, never carrying an approval).
import { describe, expect, it } from "vitest";
import {
  WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, startWorkflowBranchSync, startWorkflowBranchSyncRun, type CodeHost, type OrgId, type WorkflowProgram, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { branchWritersKey, noteBranchHead, noteRestackRefused, openBranchWriters, readBranchWriters, type BranchWriters } from "../../packages/broker/src/core/branch-sync/branch-writers.js";
import { ANCESTRY_WALK_MAX, decideBranchMethod, forcePushLease, headBuildsOnBase, isForcePushRefusal, plainBranchName, planRestackOutcome } from "../../packages/broker/src/core/branch-sync/restack.js";

const at = "2026-11-09T12:00:00.000Z";
const TASK = "00000000-0000-4000-8000-0000000000a1";
const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const BRANCH = "rovara/00000000-0000-4000-8000-000000000001";
const KEY = { orgId: ORG, repositoryId: "payments", branch: BRANCH };
const HEAD_A = "a".repeat(40);
const BASE = "f".repeat(40);
const NEW_HEAD = "9".repeat(40);
const NEW_TREE = "c".repeat(40);

describe("who has written to a branch", () => {

  it("the publish path opens a Rovara-only record once; seeing Rovara's own head writes nothing", async () => {
    const store = new MemoryDocumentStore();
    await openBranchWriters(store, KEY, at);
    await openBranchWriters(store, KEY, "2026-11-09T13:00:00.000Z");
    await noteBranchHead(store, KEY, { headIsRecordedRovaraPush: true, now: "2026-11-09T14:00:00.000Z" });
    expect(await readBranchWriters(store, KEY)).toEqual({ state: "rovara_only", restackRefused: false });
    expect(await store.get(branchWritersKey(KEY))).toMatchObject({ entityType: "BRANCH_WRITERS", orgId: ORG, personPushed: false, createdAt: at });
  });

  it("a refs/heads spelling is the same branch; any other full ref is not a branch name", async () => {
    const store = new MemoryDocumentStore();
    await openBranchWriters(store, { ...KEY, branch: `refs/heads/${BRANCH}` }, at);
    await noteBranchHead(store, KEY, { headIsRecordedRovaraPush: false, now: at });
    expect(await readBranchWriters(store, { ...KEY, branch: `refs/heads/${BRANCH}` })).toEqual({ state: "person_pushed", restackRefused: false });
    expect(() => branchWritersKey({ ...KEY, branch: "refs/tags/v1" })).toThrow();
    expect(() => branchWritersKey({ ...KEY, branch: "HEAD" })).toThrow();
  });

  it("a refused force-push is remembered, and only for a branch that has a record", async () => {
    const store = new MemoryDocumentStore();
    await noteRestackRefused(store, KEY, at);
    expect(await readBranchWriters(store, KEY)).toEqual({ state: "unknown" });
    await openBranchWriters(store, KEY, at);
    await noteRestackRefused(store, KEY, at);
    expect(await readBranchWriters(store, KEY)).toEqual({ state: "rovara_only", restackRefused: true });
  });

  it("refuses keys that could widen a partition", () => {
    expect(() => branchWritersKey({ ...KEY, repositoryId: "a#b" })).toThrow();
    expect(() => branchWritersKey({ ...KEY, repositoryId: "" })).toThrow();
    expect(() => branchWritersKey({ ...KEY, branch: "a b" })).toThrow();
    expect(() => branchWritersKey({ ...KEY, branch: "" })).toThrow();
  });
});

const ROVARA_ONLY: BranchWriters = { state: "rovara_only", restackRefused: false };
const method = (overrides: Partial<Parameters<typeof decideBranchMethod>[0]> = {}) => decideBranchMethod({
  writers: ROVARA_ONLY, headByRovara: true, autonomy: "prepare", recordedBranch: BRANCH, baseBranch: "main", defaultBranch: "main", ...overrides,
});

describe("restack or merge", () => {

  it("falls back to a merge for every branch that is not proved Rovara-only", () => {
    expect(method({ writers: { state: "person_pushed", restackRefused: false } })).toEqual({ method: "merge", reason: "person_pushed" });
    expect(method({ writers: { state: "unknown" } })).toEqual({ method: "merge", reason: "writers_unknown" });
    expect(method({ headByRovara: false })).toEqual({ method: "merge", reason: "head_not_rovaras" });
    expect(method({ writers: { state: "rovara_only", restackRefused: true } })).toEqual({ method: "merge", reason: "restack_refused" });
    expect(method({ autonomy: "suggest" })).toEqual({ method: "merge", reason: "ask_first" });
    expect(method({ recordedBranch: "main" })).toEqual({ method: "merge", reason: "base_is_head_branch" });
    expect(method({ recordedBranch: "trunk", defaultBranch: "trunk", baseBranch: "release" })).toEqual({ method: "merge", reason: "base_is_head_branch" });
  });
});

describe("the one way a force-push is spelled", () => {
  const lease = (overrides: Partial<Parameters<typeof forcePushLease>[0]> = {}) => forcePushLease({
    branch: BRANCH, recordedBranch: BRANCH, baseBranch: "main", defaultBranch: "main", workflow: syncing(), writers: ROVARA_ONLY, headIsRecordedRovaraPush: true, autonomy: "prepare", ...overrides,
  });

  it("is a lease on the task's own branch at the head the workflow recorded, with the destination spelled in full", () => {
    const made = lease();
    expect(made).toMatchObject({ ok: true, argument: `--force-with-lease=refs/heads/${BRANCH}:${HEAD_A}`, branch: BRANCH, expectedHead: HEAD_A });
    if (!made.ok) return;
    expect(made.refspecFor(NEW_HEAD)).toBe(`${NEW_HEAD}:refs/heads/${BRANCH}`);
    expect(() => made.refspecFor("main")).toThrow();
    expect(() => made.refspecFor(`${NEW_HEAD};x`)).toThrow();
  });

  it("derives the expected head from the workflow: it must be the head the running merge was queued for AND the head the pull request records", () => {
    const base = syncing();
    expect(lease({ workflow: { ...base, pullRequests: base.pullRequests?.map((pullRequest) => ({ ...pullRequest, headSha: "8".repeat(40) })) } })).toEqual({ ok: false, reason: "head_not_recorded" });
    expect(lease({ workflow: { pullRequests: base.pullRequests } })).toEqual({ ok: false, reason: "not_a_sha" });
    expect(lease({ workflow: { branchSync: base.branchSync } })).toEqual({ ok: false, reason: "head_not_recorded" });
  });

  it("is refused for the base branch, the default branch and any branch that is not the task's own, by any spelling", () => {
    expect(lease({ branch: "main", recordedBranch: "main" })).toEqual({ ok: false, reason: "base_or_default_branch" });
    expect(lease({ branch: "Main", recordedBranch: "Main" })).toEqual({ ok: false, reason: "base_or_default_branch" });
    expect(lease({ branch: "trunk", recordedBranch: "trunk", defaultBranch: "refs/heads/Trunk", baseBranch: "main" })).toEqual({ ok: false, reason: "base_or_default_branch" });
    expect(lease({ branch: "someone/feature" })).toEqual({ ok: false, reason: "not_the_tasks_branch" });
  });

  it("is refused for a branch spelled as a full ref, HEAD, a force marker or a hidden path part, so no spelling can name another ref", () => {
    for (const bad of ["refs/heads/main", "refs/heads/rovara/x", "refs/tags/v1", "HEAD", "head", "+main", ".hidden", "a/.hidden", "refs/remotes/origin/main"]) {
      expect(lease({ branch: bad, recordedBranch: bad }), bad).toEqual({ ok: false, reason: "unsafe_branch" });
    }
    expect(plainBranchName("refs/heads/Main")).toBe("main");
    expect(plainBranchName("refs/tags/x")).toBeUndefined();
  });

  it("is refused for a branch a person pushed to, one with no record, a head that is not Rovara's recorded push, a refused push before, and the agent set to suggest", () => {
    expect(lease({ writers: { state: "person_pushed", restackRefused: false } })).toEqual({ ok: false, reason: "not_rovara_only" });
    expect(lease({ writers: { state: "unknown" } })).toEqual({ ok: false, reason: "not_rovara_only" });
    expect(lease({ headIsRecordedRovaraPush: false })).toEqual({ ok: false, reason: "not_rovara_only" });
    expect(lease({ writers: { state: "rovara_only", restackRefused: true } })).toEqual({ ok: false, reason: "not_rovara_only" });
    expect(lease({ autonomy: "suggest" })).toEqual({ ok: false, reason: "ask_first" });
  });
});

describe("the host's refusal of a force-push", () => {
  it("is told by the host's own words: a protected branch, no rewriting, no force-push; other failures are not", () => {
    expect(isForcePushRefusal("! [remote rejected] HEAD -> x (protected branch hook declined)")).toBe(true);
    expect(isForcePushRefusal("remote: error: GH006: Protected branch update failed")).toBe(true);
    expect(isForcePushRefusal("! [rejected] x -> x (non-fast-forward)")).toBe(true);
    expect(isForcePushRefusal("force pushes are not allowed on this branch")).toBe(true);
    expect(isForcePushRefusal("! [rejected] x -> x (stale info)")).toBe(true);
    expect(isForcePushRefusal("CONFIG_INVALID: one or more registered readiness checks failed")).toBe(false);
    expect(isForcePushRefusal("RUNTIME_UNAVAILABLE: timeout")).toBe(false);
    expect(isForcePushRefusal(undefined)).toBe(false);
  });
});

describe("whether a head builds on a base", () => {
  /** A host that knows the parents of a few commits. */
  const hostOf = (parents: Record<string, string[]>, fail?: string): Pick<CodeHost, "commitParents"> => ({
    commitParents: async (_repository, revision) => {
      if (revision === fail) throw new Error("host down");
      const found = parents[revision];
      if (found === undefined) throw new Error("no such revision");
      return found;
    },
  });
  const repo = { url: "https://github.com/acme/payments" };
  const scope = { system: "install" } as const;

  it("is true for the base itself and for a head whose first-parent chain reaches it", async () => {
    expect(await headBuildsOnBase(hostOf({}), repo, BASE, BASE, scope)).toBe(true);
    expect(await headBuildsOnBase(hostOf({ [NEW_HEAD]: ["1".repeat(40)], ["1".repeat(40)]: [BASE] }), repo, NEW_HEAD, BASE, scope)).toBe(true);
  });

  it("is true through a merge, and false for a head that does not reach it", async () => {
    expect(await headBuildsOnBase(hostOf({ [NEW_HEAD]: ["1".repeat(40), "2".repeat(40)], ["1".repeat(40)]: ["3".repeat(40)], ["2".repeat(40)]: [BASE], ["3".repeat(40)]: [] }), repo, NEW_HEAD, BASE, scope)).toBe(true);
    expect(await headBuildsOnBase(hostOf({ [NEW_HEAD]: ["1".repeat(40)], ["1".repeat(40)]: [] }), repo, NEW_HEAD, BASE, scope)).toBe(false);
  });

  it("cannot be told when the host fails or the walk is cut: undefined, never false", async () => {
    expect(await headBuildsOnBase(hostOf({ [NEW_HEAD]: ["1".repeat(40)] }, "1".repeat(40)), repo, NEW_HEAD, BASE, scope)).toBeUndefined();
    const chain: Record<string, string[]> = {};
    for (let index = 0; index <= ANCESTRY_WALK_MAX + 5; index += 1) chain[String(index).padStart(40, "0")] = [String(index + 1).padStart(40, "0")];
    expect(await headBuildsOnBase(hostOf(chain), repo, "0".repeat(40), BASE, scope)).toBeUndefined();
  });
});

const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const PULL_REQUEST = { repositoryId: "payments", number: 7, headSha: HEAD_A, headTreeSha: "b".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" as const, url: "https://github.com/acme/payments/pull/7" };
function syncing(): WorkflowSnapshot {
  const waiting = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: at, definitionVersion: "1.1.0", program: PROGRAM }),
    revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", programStepId: "pull_request", candidate, reviewBase: [{ repositoryId: "payments", baseCommitSha: "e".repeat(40) }],
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    pullRequests: [PULL_REQUEST],
  });
  return startWorkflowBranchSyncRun(startWorkflowBranchSync(waiting, { repositoryId: "payments", number: 7, reason: "behind", now: at }), at);
}

describe("what a finished restack is", () => {
  const binding = { repositoryId: "payments", number: 7, baseCommit: BASE, expectedHeadCommit: HEAD_A };
  const github = (overrides: Record<string, unknown> = {}) => ({ state: "open" as const, headBranch: BRANCH, headCommit: NEW_HEAD, headTreeSha: NEW_TREE, parents: [BASE], ...overrides });
  const plan = (overrides: { status?: string; error?: string; reported?: { headSha: string; treeSha: string } | undefined; github?: ReturnType<typeof github> | undefined; buildsOnBase?: boolean | undefined } = {}) => planRestackOutcome({
    workflow: syncing(), binding, terminalStatus: overrides.status ?? "SUCCEEDED", ...(overrides.error === undefined ? {} : { terminalError: overrides.error }),
    reported: "reported" in overrides ? overrides.reported : { headSha: NEW_HEAD, treeSha: NEW_TREE }, github: "github" in overrides ? overrides.github : github(), buildsOnBase: "buildsOnBase" in overrides ? overrides.buildsOnBase : true,
    recordedBranch: BRANCH, now: at,
  });

  it("is recorded when the host shows a new head on the task's branch, on top of the base, with the tree the worker said", () => {
    const outcome = plan();
    expect(outcome).toMatchObject({ kind: "restacked", headSha: NEW_HEAD, headTreeSha: NEW_TREE, previousHeadSha: HEAD_A, baseCommitSha: BASE });
    if (outcome.kind !== "restacked") return;
    expect(outcome.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", candidate: { repositories: [{ commitSha: NEW_HEAD }] } });
    expect(outcome.workflow.branchSync).toBeUndefined();
  });

  it("is a refusal when the host refused the force-push and the head did not move: nothing is rewritten, and the next try is a merge", () => {
    const refused = plan({ status: "FAILED", error: "! [remote rejected] HEAD -> x (protected branch hook declined)", reported: undefined, github: github({ headCommit: HEAD_A }) });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") expect(refused.workflow.branchSync).toBeUndefined();
    // A refusal text while the head has moved to something that is not the restack is the other writer's push, not the refusal.
    expect(plan({ status: "FAILED", error: "protected branch", github: github({ headCommit: "8".repeat(40) }), buildsOnBase: false }).kind).toBe("unchanged");
  });

  it("counts a failure of the restack's own and delays one that is not", () => {
    const real = plan({ status: "FAILED", error: "CONFIG_INVALID: one or more registered readiness checks failed", github: github({ headCommit: HEAD_A }) });
    expect(real).toMatchObject({ kind: "unchanged", workflow: { syncFailures: { headSha: HEAD_A, count: 1 } } });
    const transient = plan({ status: "FAILED", error: "RUNTIME_UNAVAILABLE: timeout", github: github({ headCommit: HEAD_A }) });
    expect(transient).toMatchObject({ kind: "unchanged", workflow: { syncFailures: { headSha: HEAD_A, count: 0 } } });
  });
});
