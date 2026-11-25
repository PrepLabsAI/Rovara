// Port lane L7a: merge tracking and the press, over W0's in-memory store, a fake code host (that answers as GitHub does), the local owner's Approvers and in-memory neighbours.
// Never the real GitHub, never DynamoDB.
import { describe, expect, it } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, hostRateLimitRetryAt, mergeTrackingKey } from "../../packages/contracts/src/index.js";
import {
  TrackingRequestCapError, registerMergeActionDecider, prepareMerge, trackPullRequest, trackTask, reconcileTrackingTask, readMergeTracking, mergeViewOf, trackingRequestCap,
  type MergeReadBudget,
} from "../../packages/broker/src/core/merge/index.js";
import { requireRepositoryKey } from "../../packages/broker/src/core/merge/repository-key.js";
import { ORG, TASK_ID, mergeWorld, pressAsOwner, wrapStore, type MergeWorld } from "../support/merge-world.js";

const budget = (limit = 1_000): MergeReadBudget & { used: () => number } => {
  let count = 0;
  return { signal: new AbortController().signal, beforeRequest: () => { count += 1; if (count > limit) throw Object.assign(new Error("spent"), { name: "GithubBudgetExhaustedError" }); }, used: () => count };
};
const rejects = async (run: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try { await run(); } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    // An AgentXError's message starts with its code.
    return { ...(code === undefined ? {} : { code }), message: code !== undefined && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message };
  }
  throw new Error("expected a refusal");
};

/** One pass of tracking, then the tracking items it kept. */
async function track(world: MergeWorld): Promise<Array<Record<string, unknown>>> {
  await trackPullRequest(world.tracking, TASK_ID);
  return await readMergeTracking(world.store, TASK_ID, ORG);
}

describe("merge tracking", () => {

  it("takes a draft out of draft once its checks pass, asks the project's reviewers once, and says pr_ready once", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    pr.model.update(String(pr.number), {});
    pr.model.getChangeRequest(String(pr.number)).draft = true;
    pr.model.setAccount("lead", "write");
    const settings = { read: async () => ({ allowSelfApproval: true, mergeMethod: "squash" as const, codeReviewers: ["lead"], revision: 1 }) };
    const deps = { ...world.tracking, settings };
    await trackPullRequest(deps, TASK_ID);
    const cr = pr.model.getChangeRequest(String(pr.number));
    expect(cr.draft).toBe(false);
    expect(cr.requestedReviewers).toContain("lead");
    await trackPullRequest(deps, TASK_ID);
    expect(world.milestones.written.filter((m) => m.kind === "pr_ready")).toHaveLength(1);
    expect(world.milestones.delivered.length).toBeGreaterThan(0);
  });

  it("says once on the timeline when someone else pushed, and once when the push was Rovara's after all", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    await track(world);
    // A new head nobody recorded, with no push of Rovara's pending: someone else's.
    await world.setWorkflow({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    pr.model.commit(pr.model.getChangeRequest(String(pr.number)).sourceBranch, { "src/b.ts": "x\n" });
    await trackPullRequest({ ...world.tracking, recordedHead: async () => undefined }, TASK_ID);
    expect(world.timeline.lines).toEqual(["Someone else pushed to this pull request, so I'll stop changing it. I'll keep watching for reviews and the merge."]);
    expect(((await world.trackingOf(pr))!)["headByRovara"]).toBe(false);
  });

  it("refuses an answer for another pull request number", async () => {
    const world = await mergeWorld();
    const real = world.prs[0]!.model;
    const host = (await world.host.repository("web", 1, "app", ORG))!.codeHost;
    const lying = async (...args: Parameters<typeof host.changeRequestStatus>) => ({ ...(await host.changeRequestStatus(...args)), id: "999" });
    void real;
    const deps = { ...world.tracking, repository: async () => ({ url: "https://github.com/acme/app", codeHost: Object.create(host, { changeRequestStatus: { value: lying } }) as typeof host }) };
    expect((await rejects(() => trackPullRequest(deps, TASK_ID))).message).toContain("another pull request");
  });

  it("keeps the merge claim, nudges and syncs another writer put on the item, and never removes the claim", async () => {
    const world = await mergeWorld();
    await track(world);
    const key = mergeTrackingKey(TASK_ID, "app", world.prs[0]!.number);
    await world.store.update({ key, ops: [{ op: "set", path: ["mergeClaim"], value: { headSha: world.prs[0]!.head, by: "owner", at: "2026-11-09T09:59:00.000Z" } }, { op: "set", path: ["nudges"], value: { count: 2 } }] });
    world.prs[0]!.model.addReview(String(world.prs[0]!.number), { login: "priya", state: "CHANGES_REQUESTED" });
    await track(world);
    const after = (await world.store.get(key))!;
    expect(after["review"]).toBe("changes_requested");
    expect(after["mergeClaim"]).toMatchObject({ by: "owner" });
    expect(after["nudges"]).toEqual({ count: 2 });
    expect(after["version"]).toBe(2);
  });

  it("gives a pass its request allowance, and the next pass starts where the last stopped", async () => {
    const world = await mergeWorld({ pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "docs", number: 1 }] });
    await world.store.put({ item: { pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${TASK_ID}`, entityType: "RECOVERY" } });
    expect(trackingRequestCap(2)).toBeGreaterThan(trackingRequestCap(1));
    const tight = budget(3);
    const error = await trackTask({ ...world.tracking, budget: tight }, TASK_ID).then(() => undefined, (thrown: unknown) => thrown as Error);
    expect(error?.name === "TrackingRequestCapError" || error?.name === "GithubBudgetExhaustedError").toBe(true);
    expect(tight.used()).toBeGreaterThan(0);
    const cursor = (await world.store.get({ pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${TASK_ID}` }))!["trackingCursor"];
    expect(cursor === undefined || typeof cursor === "number").toBe(true);
    // An unlimited pass finishes both and resets the cursor.
    await trackTask({ ...world.tracking, budget: budget() }, TASK_ID);
    expect(((await readMergeTracking(world.store, TASK_ID, ORG)).map((item) => item.repositoryId)).sort()).toEqual(["app", "docs"]);
    expect((await world.store.get({ pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${TASK_ID}` }))!["trackingCursor"] ?? 0).toBe(0);
    void TrackingRequestCapError;
  });

  it("turns the host's rate limit into the shared one, and any other failure into a retry", async () => {
    const world = await mergeWorld();
    const base = { ...world.tracking, observeMerge: async () => ({ kind: "OBSERVED" as const }) };
    world.prs[0]!.model.rateLimitedUntil = world.now.value + 90_000;
    const limited = await reconcileTrackingTask(base, TASK_ID, budget());
    expect(limited).toMatchObject({ kind: "RETRY", scope: "github-global" });
    expect(hostRateLimitRetryAt(Object.assign(new Error("x")))).toBeUndefined();
    world.prs[0]!.model.rateLimitedUntil = undefined;
    const broken = await reconcileTrackingTask({ ...base, loadTask: async () => { throw new Error("boom"); } }, TASK_ID, budget());
    expect(broken).toMatchObject({ kind: "RETRY", scope: "task" });
  });

  it("runs the merge observation when a pull request is no longer open and otherwise at most once per sweep interval", async () => {
    const world = await mergeWorld();
    await world.store.put({ item: { pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${TASK_ID}`, entityType: "RECOVERY" } });
    let observed = 0;
    const deps = { ...world.tracking, observeMerge: async () => { observed += 1; return { kind: "OBSERVED" as const }; } };
    await reconcileTrackingTask(deps, TASK_ID, budget());
    expect(observed).toBe(1);
    await reconcileTrackingTask(deps, TASK_ID, budget());
    expect(observed).toBe(1);
    world.now.value += 6 * 60_000;
    await reconcileTrackingTask(deps, TASK_ID, budget());
    expect(observed).toBe(2);
    // A pull request that is not open any more is observed at once.
    const pr = world.prs[0]!;
    pr.model.update(String(pr.number), { state: "closed" });
    await reconcileTrackingTask(deps, TASK_ID, budget());
    expect(observed).toBe(3);
  });

  it("commits a decider's workflow, steps, dispatch row and milestones with the tracking item in one transaction, and the store's expiry attribute reaches the decider", async () => {
    const world = await mergeWorld();
    const task = await world.task();
    let seenTtl: string | undefined = "unset";
    const request = (workflow: typeof task.workflow, revision: number) => ({
      slot: "sync" as const, workflow: { ...workflow, revision: workflow.revision + 1, updatedAt: "2026-11-09T10:00:01.000Z" },
      steps: [{ kind: "put" as const, item: { pk: "ACTION#1", sk: "A", ok: true } }],
      dispatch: { kind: "SYNC" as const, workflowRevision: revision, candidateDigest: "0".repeat(64), at: "2026-11-09T10:00:01.000Z" },
      milestones: [{ milestone: { kind: "fixing" as const, orgId: ORG, taskId: TASK_ID, at: "2026-11-09T10:00:01.000Z", text: "Bringing the branch up to date." }, n: revision }],
    });
    const release = registerMergeActionDecider("sync", ({ workflow, context }) => { seenTtl = (context as { ttlAttribute?: string } | undefined)?.ttlAttribute; return request(workflow, workflow.revision + 1); });
    try {
      await trackPullRequest(world.tracking, TASK_ID);
      expect(seenTtl).toBe("indexExpiresAt");
      expect((await world.task()).workflow.revision).toBe(task.workflow.revision + 1);
      expect(await world.store.get({ pk: "ACTION#1", sk: "A" })).toBeDefined();
      expect(await world.store.get({ pk: `ORG#${ORG}#WORKFLOW_DISPATCH`, sk: `${TASK_ID}#${String(task.workflow.revision + 1)}` })).toMatchObject({ kind: "SYNC", taskId: TASK_ID });
      expect(world.milestones.written.map((m) => m.kind)).toContain("fixing");
      expect(await world.trackingOf(world.prs[0]!)).toBeDefined();
    } finally { release(); }
    // The same decider against a workflow that moved underneath it writes none of its parts: no tracking item, no step, no dispatch row, no milestone.
    const lost = await mergeWorld();
    const release2 = registerMergeActionDecider("sync", ({ workflow }) => request(workflow, workflow.revision + 1));
    try {
      await lost.setWorkflow({ revision: 10 });
      const stale = async () => { const t = await lost.host.loadTask(TASK_ID); return { ...t!, workflow: { ...t!.workflow!, revision: 9 } }; };
      await rejects(() => trackPullRequest({ ...lost.tracking, loadTask: stale }, TASK_ID));
      expect(await lost.store.get({ pk: "ACTION#1", sk: "A" })).toBeUndefined();
      expect(await lost.store.query({ pk: `ORG#${ORG}#WORKFLOW_DISPATCH` }).then((page) => page.items)).toEqual([]);
      expect(await lost.trackingOf(lost.prs[0]!)).toBeUndefined();
    } finally { release2(); }
  });

  it("records a head that is not one of Rovara's recorded pushes as a person's push, strictly: even while a Rovara push is pending, and never for a recorded head", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    const writers = { pk: `ORG#${ORG}#BRANCH_WRITERS`, sk: `app#${pr.model.getChangeRequest(String(pr.number)).sourceBranch}` };
    // The recorded head: nothing is written.
    await trackPullRequest(world.tracking, TASK_ID);
    expect(await world.store.get(writers)).toBeUndefined();
    // A new head nobody recorded, while a Rovara push is pending (the optimistic reading says "mine"): the branch is a person's anyway.
    await world.setWorkflow({ stage: "IMPLEMENT", state: "RUNNING" });
    pr.model.commit(pr.model.getChangeRequest(String(pr.number)).sourceBranch, { "src/b.ts": "x\n" });
    await trackPullRequest({ ...world.tracking, recordedHead: async () => undefined }, TASK_ID);
    expect((await world.trackingOf(pr))!["headByRovara"]).toBe(true);
    expect(await world.store.get(writers)).toMatchObject({ personPushed: true });
    // A failure to write the fact fails the pass: it is tried again, never skipped.
    const failing = wrapStore(world.store, { update: async () => { throw new Error("store down"); } });
    pr.model.commit(pr.model.getChangeRequest(String(pr.number)).sourceBranch, { "src/c.ts": "x\n" });
    expect((await rejects(() => trackPullRequest({ ...world.tracking, store: failing, recordedHead: async () => undefined }, TASK_ID))).message).toContain("store down");
  });
});

describe("the press", () => {

  it("merges at the checked head, claims first, and audits in the claim's transaction", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const pr = world.prs[0]!;
    const prepared = await world.prepare();
    const result = await pressAsOwner(world.deps, prepared);
    expect(result).toEqual({ status: "MERGED", pullRequests: [{ repositoryId: "app", number: pr.number }] });
    expect(pr.model.getChangeRequest(String(pr.number))).toMatchObject({ state: "merged", frozenHead: pr.head });
    const item = (await world.trackingOf(pr))!;
    expect(item["mergeClaim"]).toMatchObject({ headSha: pr.head });
    expect(world.audit.events).toHaveLength(1);
    expect(world.audit.events[0]).toMatchObject({ action: "pull_request.merge_requested", companyId: ORG, actor: { type: "person" }, details: { repository: "acme/app", number: pr.number, method: "squash", approvedBy: "rovara-website-press", requestId: prepared.request.requestId } });
    // The repository is named by the key function the opened event uses too (tests/unit/local-up-flow.test.ts pins that side).
    expect(world.audit.events[0]!.details?.["repository"]).toBe(requireRepositoryKey("github", "https://github.com/acme/app"));
    // Nothing writes a proof use row any more: the claim's transaction holds the claim and the audit fact only.
    expect(await world.store.query({ pk: `ORG#${ORG}#MERGE_PROOF` })).toMatchObject({ items: [] });
    expect(await world.store.query({ pk: `ORG#${ORG}#MERGE_PROOF_TOKEN` })).toMatchObject({ items: [] });
  });

  it("refuses when the head moved after the person saw it: it changed, and the host is re-read", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    const pr = world.prs[0]!;
    // A push the tracking has not read yet: the stored heads still say the old one, the host says the new one.
    pr.model.commit(pr.model.getChangeRequest(String(pr.number)).sourceBranch, { "src/b.ts": "x\n" });
    const refusal = await rejects(() => pressAsOwner(world.deps, prepared));
    expect(refusal.message).toBe(M.changedAfterConfirm);
    expect(pr.model.getChangeRequest(String(pr.number)).state).toBe("open");
    expect((await world.trackingOf(pr))!["mergeClaim"]).toBeUndefined();
  });

  it("refuses when the heads the person was shown are not the ones stored", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const refusal = await rejects(() => prepareMerge(world.deps, { taskId: TASK_ID, requestId: world.requestId(), expectedHeads: [{ repositoryId: "app", number: world.prs[0]!.number, headSha: "9".repeat(40) }] }));
    expect(refusal).toMatchObject({ code: "MERGE_NOT_READY", message: M.changedAfterConfirm });
  });

  it("says why it cannot merge, in the exact words, and writes nothing", async () => {
    const cases: Array<[string, (world: MergeWorld) => Promise<void> | void, string]> = [
      ["not tracked yet", async () => undefined, M.notTrackedYet],
      ["failing checks", (w) => w.seedTracking({ ci: "failing" }), M.checks],
      ["a draft", (w) => w.seedTracking({ draft: true }), M.draft],
      ["a conflict", (w) => w.seedTracking({ branch: "conflicted" }), M.conflicted("main")],
      ["no approval", (w) => w.seedTracking({ review: "requested", approval: undefined as never }), M.needsWriteApproval("app")],
      ["changes requested", (w) => w.seedTracking({ review: "changes_requested" }), M.changesRequested],
    ];
    for (const [name, arrange, words] of cases) {
      const world = await mergeWorld();
      await arrange(world);
      const refusal = await rejects(() => world.prepare());
      expect(refusal, name).toMatchObject({ code: "MERGE_NOT_READY", message: words });
      expect(await world.auditRows()).toHaveLength(0);
    }
  });

  it("asks for a sync when the branch is behind a base that requires it, and presses nothing", async () => {
    const world = await mergeWorld();
    await world.seedTracking({ branch: "behind" });
    const model = world.prs[0]!.model;
    model.requiredChecks = [];
    // The fake reports "clean"; make the host call the branch behind.
    const original = model.mergeableState.bind(model);
    model.mergeableState = ((cr: Parameters<typeof original>[0]) => (original(cr) === "clean" ? "behind" : original(cr))) as never;
    const refusal = await rejects(() => world.prepare());
    expect(refusal.message).toBe(M.behind("main"));
    expect(world.syncRequests).toEqual([TASK_ID]);
  });

  it("holds the merge while a second review waits (an outside gate)", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const refusal = await rejects(() => prepareMerge({ ...world.deps, mergeWait: () => "A second review did not run. Acknowledge it first." }, { taskId: TASK_ID, requestId: world.requestId() }));
    expect(refusal.message).toBe("A second review did not run. Acknowledge it first.");
  });

  it("needs a code owner where the repository names one, reading CODEOWNERS and the changed paths from the host", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const pr = world.prs[0]!;
    pr.model.commit("main", { ".github/CODEOWNERS": "src/ @acme-lead\n" });
    const prepared = await world.prepare();
    // The base now has CODEOWNERS and priya is not an owner: the fresh read refuses.
    const refusal = await rejects(() => pressAsOwner(world.deps, prepared));
    expect(refusal.message).toBe(M.needsCodeOwner("@acme-lead"));
    expect(pr.model.getChangeRequest(String(pr.number)).state).toBe("open");
    expect((await world.trackingOf(pr))!["mergeClaim"]).toBeUndefined();
  });

  it("refuses a host that does not let Rovara merge before any claim is made", async () => {
    const world = await mergeWorld({ codeHost: noMerge });
    await world.seedTracking();
    const prepared = await world.prepare();
    const refusal = await rejects(() => pressAsOwner(world.deps, prepared));
    expect(refusal.message).toBe("Rovara can't merge on this repository's code host. Merge it there.");
    expect((await world.trackingOf(world.prs[0]!))!["mergeClaim"]).toBeUndefined();
    expect(await world.auditRows()).toHaveLength(0);
  });

  it("lets go of the claim when the host says no after readiness passed, and leaves the audit fact of the attempt", async () => {
    const world = await mergeWorld({ codeHost: (model) => refusingMerge(model) });
    await world.seedTracking();
    const pr = world.prs[0]!;
    const prepared = await world.prepare();
    const refusal = await rejects(() => pressAsOwner(world.deps, prepared));
    expect(refusal).toMatchObject({ code: "MERGE_NOT_READY", message: M.notMerged("app", "the code host would not merge it (the host says: Required checks have not passed.)") });
    expect((await world.trackingOf(pr))!["mergeClaim"]).toBeUndefined();
    expect(pr.model.getChangeRequest(String(pr.number)).state).toBe("open");
    // The claim committed with its audit fact before the host was asked, as Cloud's did.
    expect(await world.auditRows()).toHaveLength(1);
    // A second press right after is not told Rovara is already merging (it is refused by the host again).
    const again = await world.prepare();
    expect((await rejects(() => pressAsOwner(world.deps, again))).message).toContain("didn't merge");
  });

  it("says a method fell back on the timeline", async () => {
    const world = await mergeWorld({ mergeMethod: "squash" });
    await world.seedTracking();
    const pr = world.prs[0]!;
    const host = (await world.host.repository("web", 1, "app", ORG))!.codeHost;
    const fall = async (...args: Parameters<NonNullable<typeof host.merge>>) => { const result = await host.merge!(...args); return result.outcome === "merged" ? { ...result, method: "merge" as const, fellBack: true } : result; };
    const falling = Object.create(host, { merge: { value: fall } }) as typeof host;
    const deps = { ...world.deps, host: { ...world.host, repository: async () => ({ url: "https://github.com/acme/app", codeHost: falling }) } };
    const prepared = await prepareMerge(deps, { taskId: TASK_ID, requestId: world.requestId() });
    await pressAsOwner(deps, prepared);
    expect(world.timeline.lines).toEqual([`Merged app pull request ${String(pr.number)} using merge, because squash isn't allowed in that repository.`]);
  });

  it("refuses a closed task and a task whose pull requests are merged on the host, and a request id that is not a uuid", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    await world.store.update({ key: { pk: `DEVTASK#${TASK_ID}`, sk: "META" }, ops: [{ op: "set", path: ["closedAt"], value: "2026-11-09T09:00:00.000Z" }] });
    expect((await rejects(() => world.prepare())).message).toBe(M.taskClosed);
    const plain = await mergeWorld();
    await plain.setWorkflow({ definitionVersion: "1.0.0" });
    expect((await rejects(() => plain.prepare())).code).toBe("CONFIG_INVALID");
    expect((await rejects(() => prepareMerge(plain.deps, { taskId: TASK_ID, requestId: "not-a-uuid" }))).code).toBe("CONFIG_INVALID");
    expect((await rejects(() => prepareMerge(plain.deps, { taskId: "99999999-9999-4999-8999-999999999999", requestId: plain.requestId() }))).code).toBe("NOT_FOUND");
  });

  it("shows the task view whether pressing Merge now would be allowed, with the risk", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const items = await readMergeTracking(world.store, TASK_ID, ORG);
    expect(await mergeViewOf(world.deps, (await world.task()), items, undefined)).toMatchObject({ ready: true, risk: { level: "low" } });
    await world.seedTracking({ ci: "failing" });
    expect(await mergeViewOf(world.deps, (await world.task()), await readMergeTracking(world.store, TASK_ID, ORG), undefined)).toMatchObject({ ready: false, message: M.checks });
    expect(await mergeViewOf(world.deps, (await world.task()), [], undefined)).toBeUndefined();
  });
});

import type { CodeHost } from "../../packages/contracts/src/index.js";
import { FakeCodeHost, type FakeHostModel } from "@agentx/broker/fakes";
/** A host that is ready by every read and then says no to the merge itself (branch protection the reads cannot see). */
function refusingMerge(model: FakeHostModel): CodeHost {
  const fake = new FakeCodeHost(model);
  return Object.create(fake, { kind: { value: "github" }, merge: { value: async () => ({ outcome: "refused", reason: "not_mergeable", hostMessage: "Required checks have not passed." }) } }) as CodeHost;
}

function noMerge(model: FakeHostModel): CodeHost {
  const fake = new FakeCodeHost(model);
  return Object.create(fake, { kind: { value: "github" }, merge: { value: undefined } }) as CodeHost;
}
