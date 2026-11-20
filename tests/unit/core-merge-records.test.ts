import { workspacePartition } from "../../packages/broker/src/core/task-flow/keys.js";
// Port lane L7a: the merge core's records on the document store: the reverse link from a change request to its task, the merge-commit index (what revert detection reads), and the
// state a merge leaves behind (tracking row, pull request record, timeline, merged milestone).
import { describe, expect, it } from "vitest";
import { prHeadKey, type WorkflowSnapshot } from "../../packages/contracts/src/index.js";
import {
  codeHostRepositoryKey, mergedMilestoneItems, mergedStateItems, prHeadItems, readMergeTracking, trackingWriteItem, trackingItemOf,
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
    await world.store.put({ item: { pk: workspacePartition(ORG, "ws-1"), sk: `PULL_REQUEST#app#${String(pr.number).padStart(12, "0")}`, state: "open" } });
    return { world, pr, item };
  }

  it("says as a fact that a pull request was merged on the host with no approval recorded, naming only a login the host could have issued", async () => {
    const { world, pr } = await arranged({ approval: undefined, review: "requested" });
    const make = (n: number) => ({ ...workflow("OPEN"), pullRequests: [{ ...workflow("OPEN").pullRequests![0]!, number: n, url: `https://github.com/acme/app/pull/${String(n)}` }] }) as WorkflowSnapshot;
    const merged = (n: number) => ({ ...workflow("MERGED"), pullRequests: [{ ...workflow("MERGED").pullRequests![0]!, number: n, url: `https://github.com/acme/app/pull/${String(n)}` }] }) as WorkflowSnapshot;
    const deps = { store: world.store, timeline: world.timeline, audit: world.audit };
    await mergedStateItems(deps, { taskId: TASK_ID, orgId: ORG, sessionId: SESSION_ID }, make(pr.number), merged(pr.number), NOW, [{ repositoryId: "app", number: pr.number, mergedBy: "ana-dev" }]);
    await mergedStateItems(deps, { taskId: TASK_ID, orgId: ORG, sessionId: SESSION_ID }, make(pr.number), merged(pr.number), NOW, [{ repositoryId: "app", number: pr.number, mergedBy: "ana @everyone" }]);
    expect(world.timeline.lines).toEqual(["Merged on the code host by ana-dev; no approval was recorded.", "Merged on the code host; no approval was recorded."]);
  });

  describe("the pull_request.merged audit event", () => {
    const at = (n: number, state: "OPEN" | "MERGED" | "CLOSED") => ({ ...workflow("OPEN"), pullRequests: [{ ...workflow("OPEN").pullRequests![0]!, number: n, state, url: `https://github.com/acme/app/pull/${String(n)}` }] }) as unknown as WorkflowSnapshot;

    it("is not written again when the same merge is delivered again, and a replayed save cannot commit it twice", async () => {
      const { world, pr } = await arranged();
      const deps = { store: world.store, timeline: world.timeline, audit: world.audit };
      const first = await mergedStateItems(deps, { taskId: TASK_ID, orgId: ORG, workspaceId: "ws-1" }, at(pr.number, "OPEN"), at(pr.number, "MERGED"), NOW);
      expect((await world.store.transact(first)).applied).toBe(true);
      // Redelivery: the stored workflow already says merged, so the save has nothing to add.
      expect(await mergedStateItems(deps, { taskId: TASK_ID, orgId: ORG, workspaceId: "ws-1" }, at(pr.number, "MERGED"), at(pr.number, "MERGED"), NOW)).toEqual([]);
      expect(world.audit.events).toHaveLength(1);
      // A replay of the first save (a stale reader) hits the same event id and is refused as a whole.
      expect((await world.store.transact(first)).applied).toBe(false);
      expect(await world.auditRows()).toHaveLength(1);
    });
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

describe("the tracking item's neutral spellings (item C4)", () => {
  it("reads an item written before the host account id got its neutral name, and writes it back under the new one", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const key = { pk: `DEVTASK#${TASK_ID}`, sk: `MERGE_TRACKING#app#${String(world.prs[0]!.number)}` };
    const stored = (await world.store.get(key))!;
    const approval = stored["approval"] as { hostUserId: string; login: string; commitId: string };
    const { hostUserId, ...rest } = approval;
    await world.store.put({ item: { ...stored, approval: { ...rest, githubUserId: hostUserId } } });
    const read = trackingItemOf(await world.store.get(key), ORG, TASK_ID)!;
    expect(read.approval).toEqual({ hostUserId, login: "priya", commitId: world.prs[0]!.head });
    // The new spelling still reads, and an item that names the account both ways keeps the new one.
    expect(trackingItemOf({ ...stored, approval: { ...approval, githubUserId: "stale" } }, ORG, TASK_ID)?.approval?.hostUserId).toBe(hostUserId);
  });
});

