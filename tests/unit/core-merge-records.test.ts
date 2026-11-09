// Port lane L7a: the merge core's records on the document store: the reverse link from a change request to its task, the merge-commit index (what revert detection reads), and the
// state a merge leaves behind (tracking row, pull request record, timeline, merged milestone).
import { describe, expect, it } from "vitest";
import { mergeCommitIndexKey, prHeadKey, type WorkflowSnapshot } from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import {
  changeRequestAddress, codeHostRepositoryKey, findLinkedChangeRequest, findMergeCommit, linkedChangeRequestItem, linkedChangeRequestKey, mergeCommitIndexItem, mergeCommitIndexRecord,
  mergedLines, mergedMilestoneItems, mergedStateItems, prHeadItems, readMergeTracking, storeLinkedChangeRequests, trackingWriteItem, trackingItemOf, plain,
} from "../../packages/broker/src/core/merge/index.js";
import { MemoryMilestones, ORG, SESSION_ID, TASK_ID, mergeWorld } from "../support/merge-world.js";

const SHA = "ab".repeat(20);
const NOW = "2026-11-09T10:00:00.000Z";

describe("repository keys", () => {
  it("keeps GitHub's old spelling (owner/name, lower case) and files any other host under its kind and address", () => {
    expect(codeHostRepositoryKey("github", "https://github.com/Acme/App.git")).toBe("acme/app");
    expect(codeHostRepositoryKey("github", "https://github.com/acme/app/")).toBe("acme/app");
    expect(codeHostRepositoryKey("github", "https://examplehost.test/acme/app")).toBeUndefined();
    expect(codeHostRepositoryKey("github", "http://github.com/acme/app")).toBeUndefined();
    expect(codeHostRepositoryKey("othercode", "https://Examplehost.test/Acme/App.git")).toBe("othercode:https://examplehost.test/Acme/App");
    expect(codeHostRepositoryKey("othercode", "https://user:pw@examplehost.test/a/b")).toBeUndefined();
    expect(codeHostRepositoryKey("othercode", "ftp://examplehost.test/a/b")).toBeUndefined();
    expect(codeHostRepositoryKey("othercode", "not a url")).toBeUndefined();
  });
});

describe("the link from a change request to its task", () => {
  const input = { hostKind: "github", repositoryAddress: "https://github.com/acme/app", changeRequestId: "7", repositoryId: "app", number: 7, url: "https://github.com/acme/app/pull/7", taskId: TASK_ID, workspaceId: "ws", candidateDigest: "c".repeat(64), createdAt: NOW };

  it("is written once (a second task can never take a change request) and read back by the same key", async () => {
    const store = new MemoryDocumentStore();
    const item = linkedChangeRequestItem(input)!;
    expect((await store.transact([item])).applied).toBe(true);
    expect((await store.transact([{ ...item, item: plain({ ...(item as { item: object }).item, taskId: "other" }) } as never])).applied).toBe(false);
    expect(await findLinkedChangeRequest(store, { hostKind: "github", repositoryAddress: "https://github.com/ACME/app.git", id: "7" })).toMatchObject({ source: "neutral", taskId: TASK_ID, number: 7 });
    expect(await findLinkedChangeRequest(store, { hostKind: "github", repositoryAddress: "https://github.com/acme/other", id: "7" })).toBeUndefined();
    expect(await storeLinkedChangeRequests(store).find({ hostKind: "github", repositoryAddress: "https://github.com/acme/app", id: "7" })).toEqual({ taskId: TASK_ID, repositoryId: "app", url: input.url });
  });

  it("reads the older GitHub row too, and only when it says what its key says", async () => {
    const store = new MemoryDocumentStore();
    const legacy = { pk: "GITHUB_PR#acme/app", sk: "PR#0000000007", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/app", repositoryId: "app", number: 7, url: input.url, taskId: TASK_ID, workspaceId: "ws", candidateDigest: "c".repeat(64), createdAt: NOW };
    await store.put({ item: legacy });
    expect(await findLinkedChangeRequest(store, { hostKind: "github", repositoryAddress: "https://github.com/acme/app", id: "7" })).toMatchObject({ source: "github-legacy", taskId: TASK_ID });
    // Only GitHub has older rows; a row that names another repository, number or kind is no link.
    expect(await findLinkedChangeRequest(store, { hostKind: "othercode", repositoryAddress: "https://examplehost.test/acme/app", id: "7" })).toBeUndefined();
    await store.put({ item: { ...legacy, number: 8 } });
    expect(await findLinkedChangeRequest(store, { hostKind: "github", repositoryAddress: "https://github.com/acme/app", id: "7" })).toBeUndefined();
  });

  it("is not a link when the row under the neutral key does not say what its key says, and does not fall back to the older row", async () => {
    const store = new MemoryDocumentStore();
    const key = linkedChangeRequestKey("github", input.repositoryAddress, "7")!;
    await store.put({ item: { ...key, entityType: "SOMETHING_ELSE", taskId: TASK_ID } });
    await store.put({ item: { pk: "GITHUB_PR#acme/app", sk: "PR#0000000007", entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "acme/app", repositoryId: "app", number: 7, url: input.url, taskId: TASK_ID, workspaceId: "ws", candidateDigest: "c".repeat(64) } });
    expect(await findLinkedChangeRequest(store, { hostKind: "github", repositoryAddress: input.repositoryAddress, id: "7" })).toBeUndefined();
  });

  it("cannot key an id with a separator or an address the host cannot name", () => {
    expect(linkedChangeRequestKey("github", input.repositoryAddress, "7#8")).toBeUndefined();
    expect(linkedChangeRequestKey("github", "https://examplehost.test/a/b", "7")).toBeUndefined();
    expect(linkedChangeRequestKey("othercode", "https://examplehost.test/a/b", "abc-1")).toEqual({ pk: "CODEHOST_CR#othercode#othercode:https://examplehost.test/a/b", sk: "CR#abc-1" });
  });
});

describe("the merge-commit index", () => {
  const record = { orgId: ORG, repositoryFullName: "Acme/App", repositoryId: "app", number: 7, url: "https://github.com/acme/app/pull/7", taskId: TASK_ID, mergeCommit: SHA.toUpperCase(), now: NOW };

  it("keys a company's repository and commit in lower case, and refuses what GitHub could not have issued", () => {
    expect(mergeCommitIndexRecord(record)).toMatchObject({ ...mergeCommitIndexKey(ORG, "Acme/App", SHA), repositoryFullName: "acme/app", mergeCommit: SHA });
    expect(mergeCommitIndexRecord({ ...record, mergeCommit: "not-a-sha" })).toBeUndefined();
    expect(mergeCommitIndexRecord({ ...record, repositoryFullName: "no-slash" })).toBeUndefined();
    expect(mergeCommitIndexRecord({ ...record, now: "later" })).toBeUndefined();
    expect(mergeCommitIndexRecord(record)!["indexExpiresAt"]).toBe(Math.floor(Date.parse(NOW) / 1000) + 400 * 86_400);
  });

  it("is found by repository and commit, for this company only, and a row that does not say what its key says is not a row", async () => {
    const store = new MemoryDocumentStore();
    await store.transact([mergeCommitIndexItem(record)!]);
    expect(await findMergeCommit(store, { orgId: ORG, repositoryFullName: "acme/app", sha: SHA })).toMatchObject({ taskId: TASK_ID, number: 7 });
    expect(await findMergeCommit(store, { orgId: ORG, repositoryFullName: "acme/other", sha: SHA })).toBeUndefined();
    expect(await findMergeCommit(store, { orgId: "org_zzzzzzzzzzzzzzzzzzzz", repositoryFullName: "acme/app", sha: SHA })).toBeUndefined();
    const key = mergeCommitIndexKey(ORG, "acme/app", SHA);
    await store.put({ item: { ...key, entityType: "GITHUB_WORKFLOW_MERGE", orgId: ORG, repositoryFullName: "acme/app", mergeCommit: "cd".repeat(20), repositoryId: "app", url: "u", taskId: TASK_ID, number: 7 } });
    expect(await findMergeCommit(store, { orgId: ORG, repositoryFullName: "acme/app", sha: SHA })).toBeUndefined();
  });

  it("reads a change request address by its host kind", () => {
    expect(changeRequestAddress("github", "https://github.com/acme/app/pull/7")).toEqual({ repositoryFullName: "acme/app", number: 7 });
    expect(changeRequestAddress("github", "https://examplehost.test/acme/app/pull/7")).toBeUndefined();
    expect(changeRequestAddress("github", "https://github.com/acme/app/issues/7")).toBeUndefined();
  });
});

describe("what a merge leaves behind", () => {
  const workflow = (state: "OPEN" | "MERGED", stage = "WAIT_FOR_MERGE"): WorkflowSnapshot => ({
    definitionVersion: "1.1.0", stage, state: stage === "MERGED" ? "COMPLETE" : "WAITING", outcome: stage === "MERGED" ? "MERGED" : undefined, taskId: TASK_ID, revision: 9,
    pullRequests: [{ repositoryId: "app", number: 7, url: "https://github.com/acme/app/pull/7", required: true, state }],
  }) as unknown as WorkflowSnapshot;

  async function arranged(over: Record<string, unknown> = {}) {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    await world.seedTracking(over);
    const item = (await readMergeTracking(world.store, TASK_ID, ORG))[0]!;
    await world.store.put({ item: { pk: "WORKSPACE#ws-1", sk: `PULL_REQUEST#app#${String(pr.number).padStart(12, "0")}`, state: "open" } });
    return { world, pr, item };
  }

  it("marks the tracking row and the pull request record merged, indexes the merge commit, and says nothing when an approval was recorded", async () => {
    const { world, pr } = await arranged();
    const before = { ...workflow("OPEN"), pullRequests: [{ ...workflow("OPEN").pullRequests![0]!, number: pr.number, url: `https://github.com/acme/app/pull/${String(pr.number)}` }] } as WorkflowSnapshot;
    const after = { ...workflow("MERGED"), pullRequests: [{ ...workflow("MERGED").pullRequests![0]!, number: pr.number, url: before.pullRequests![0]!.url }] } as WorkflowSnapshot;
    const items = await mergedStateItems({ store: world.store, timeline: world.timeline }, { taskId: TASK_ID, orgId: ORG, sessionId: SESSION_ID, workspaceId: "ws-1" }, "github", before, after, NOW, [{ repositoryId: "app", number: pr.number, mergeCommit: SHA }]);
    expect((await world.store.transact(items)).applied).toBe(true);
    expect(((await readMergeTracking(world.store, TASK_ID, ORG))[0])!.state).toBe("merged");
    expect((await world.store.get({ pk: "WORKSPACE#ws-1", sk: `PULL_REQUEST#app#${String(pr.number).padStart(12, "0")}` }))!["state"]).toBe("merged");
    expect(await findMergeCommit(world.store, { orgId: ORG, repositoryFullName: "acme/app", sha: SHA })).toMatchObject({ taskId: TASK_ID });
    expect(world.timeline.lines).toEqual([]);
  });

  it("says as a fact that a pull request was merged on the host with no approval recorded, naming only a login the host could have issued", async () => {
    const { world, pr } = await arranged({ approval: undefined, review: "requested" });
    const make = (n: number) => ({ ...workflow("OPEN"), pullRequests: [{ ...workflow("OPEN").pullRequests![0]!, number: n, url: `https://github.com/acme/app/pull/${String(n)}` }] }) as WorkflowSnapshot;
    const merged = (n: number) => ({ ...workflow("MERGED"), pullRequests: [{ ...workflow("MERGED").pullRequests![0]!, number: n, url: `https://github.com/acme/app/pull/${String(n)}` }] }) as WorkflowSnapshot;
    const deps = { store: world.store, timeline: world.timeline };
    await mergedStateItems(deps, { taskId: TASK_ID, orgId: ORG, sessionId: SESSION_ID }, "github", make(pr.number), merged(pr.number), NOW, [{ repositoryId: "app", number: pr.number, mergedBy: "ana-dev" }]);
    await mergedStateItems(deps, { taskId: TASK_ID, orgId: ORG, sessionId: SESSION_ID }, "github", make(pr.number), merged(pr.number), NOW, [{ repositoryId: "app", number: pr.number, mergedBy: "ana @everyone" }]);
    expect(world.timeline.lines).toEqual(["Merged on the code host by ana-dev; no approval was recorded.", "Merged on the code host; no approval was recorded."]);
  });

  it("is nothing for a pull request already merged, a task without a company, or one that was not moved to merged", async () => {
    const { world } = await arranged();
    const deps = { store: world.store, timeline: world.timeline };
    expect(await mergedStateItems(deps, { taskId: TASK_ID, orgId: ORG }, "github", workflow("MERGED"), workflow("MERGED"), NOW)).toEqual([]);
    expect(await mergedStateItems(deps, { taskId: TASK_ID }, "github", workflow("OPEN"), workflow("MERGED"), NOW)).toEqual([]);
    expect(await mergedStateItems(deps, { taskId: TASK_ID, orgId: ORG }, "github", workflow("OPEN"), workflow("OPEN"), NOW)).toEqual([]);
  });

  it("writes the merged milestone once, with the session's bindings, and never without them when the read fails", async () => {
    const milestones = new MemoryMilestones();
    const bindings = { read: async () => [{ kind: "slack_thread" as const, teamId: "T1", channelId: "C1", threadTs: "1.2" }] };
    const items = await mergedMilestoneItems({ milestones, bindings }, { taskId: TASK_ID, orgId: ORG, sessionId: SESSION_ID }, workflow("OPEN"), workflow("MERGED", "MERGED"), NOW);
    expect(items).toHaveLength(1);
    expect(milestones.written[0]).toMatchObject({ kind: "merged", text: "Merged: https://github.com/acme/app/pull/7", bindings: [{ kind: "slack_thread" }], pullRequests: [{ repository: "app", number: 7 }] });
    // Not a move to MERGED, or already merged, or no company: none.
    expect(await mergedMilestoneItems({ milestones, bindings }, { taskId: TASK_ID, orgId: ORG }, workflow("OPEN"), workflow("OPEN"), NOW)).toEqual([]);
    expect(await mergedMilestoneItems({ milestones, bindings }, { taskId: TASK_ID, orgId: ORG }, workflow("MERGED", "MERGED"), workflow("MERGED", "MERGED"), NOW)).toEqual([]);
    expect(await mergedMilestoneItems({ milestones, bindings }, { taskId: TASK_ID }, workflow("OPEN"), workflow("MERGED", "MERGED"), NOW)).toEqual([]);
    await expect(mergedMilestoneItems({ milestones, bindings: { read: async () => { throw new Error("unreadable"); } } }, { taskId: TASK_ID, orgId: ORG, sessionId: SESSION_ID }, workflow("OPEN"), workflow("MERGED", "MERGED"), NOW)).rejects.toThrow("unreadable");
  });

  it("prints a merged line only for a link that is a pull request link on the host", () => {
    expect(mergedLines([{ url: "https://github.com/acme/app/pull/7", state: "MERGED" }, { url: "https://evil.example.test/x", state: "MERGED" }, { url: "https://github.com/acme/app/pull/8", state: "OPEN" }])).toEqual(["Merged: https://github.com/acme/app/pull/7"]);
  });
});

describe("the head index and the tracking item's writes", () => {
  it("indexes a head and, when named, the branch, under the company-scoped key", () => {
    const [head, branch] = prHeadItems({ orgId: ORG, repositoryKey: "Acme/App", headSha: SHA, taskId: TASK_ID, repositoryId: "app", number: 7, branch: "agentx/x" }, Date.parse(NOW));
    expect((head as { item: { pk: string; sk: string } }).item).toMatchObject(prHeadKey(ORG, "acme/app", SHA));
    expect((branch as { item: { sk: string } }).item.sk).toBe("branch:agentx/x");
    expect((head as { item: Record<string, unknown> }).item["indexExpiresAt"]).toBe(Math.floor(Date.parse(NOW) / 1000) + 90 * 86_400);
  });

  it("creates a tracking item only when absent, and updates it only at the version read, for the same company and task", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const item = (await readMergeTracking(world.store, TASK_ID, ORG))[0]!;
    const next = { ...item, version: item.version + 1, review: "requested" as const };
    expect((await world.store.transact([trackingWriteItem(undefined, next)])).applied).toBe(false);
    expect((await world.store.transact([trackingWriteItem(item, next)])).applied).toBe(true);
    expect((await world.store.transact([trackingWriteItem(item, next)])).applied).toBe(false);
    expect(trackingItemOf(await world.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `MERGE_TRACKING#app#${String(item.number)}` }), "org_zzzzzzzzzzzzzzzzzzzz", TASK_ID)).toBeUndefined();
    expect(trackingItemOf({ orgId: ORG, taskId: TASK_ID, junk: true }, ORG, TASK_ID)).toBeUndefined();
  });
});
