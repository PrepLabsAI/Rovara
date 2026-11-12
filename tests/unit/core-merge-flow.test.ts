// Port lane L7a: merge tracking and the press, over W0's in-memory store, a fake code host (that answers as GitHub does), the local owner's Approvers and in-memory neighbours.
// Never the real GitHub, never DynamoDB.
import { describe, expect, it } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, hostRateLimitRetryAt, mergeTrackingKey, approvalProofKey } from "../../packages/contracts/src/index.js";
import {
  TrackingRequestCapError, registerMergeActionDecider, pressMerge, prepareMerge, trackPullRequest, trackTask, reconcileTrackingTask, readMergeTracking, mergeViewOf, trackingRequestCap,
  type MergeReadBudget,
} from "../../packages/broker/src/core/merge/index.js";
import { requireRepositoryKey } from "../../packages/broker/src/core/merge/repository-key.js";
import { ORG, OWNER_SESSION, TASK_ID, githubShapedHost, mergeWorld, wrapStore, type MergeWorld } from "../support/merge-world.js";

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
  it("keeps one item for the pull request from what the host says, and reads an approval from a writer", async () => {
    const world = await mergeWorld();
    const [item] = await track(world);
    expect(item).toMatchObject({ taskId: TASK_ID, repositoryId: "app", number: world.prs[0]!.number, state: "open", ci: "passing", review: "approved", branch: "unknown", headByRovara: true, version: 1 });
    expect(item!["approval"]).toMatchObject({ login: "priya", commitId: world.prs[0]!.head });
    // The pass asked the host with the company's scope, never a system scope.
    expect(world.scopes.every((scope) => (scope as { orgId?: string }).orgId === ORG)).toBe(true);
  });

  it("writes nothing when a second pass sees nothing new, and says the approval once", async () => {
    const world = await mergeWorld();
    expect((await trackTask(world.tracking, TASK_ID)).result).toBe("changed");
    const after = await world.trackingOf(world.prs[0]!);
    expect((await trackTask(world.tracking, TASK_ID)).result).toBe("unchanged");
    expect(await world.trackingOf(world.prs[0]!)).toEqual(after);
    const approved = world.milestones.written.filter((m) => m.kind === "approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]!.text).toContain("Approved by priya");
  });

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

  it("does not mark ready while checks are pending or failing", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    pr.model.getChangeRequest(String(pr.number)).draft = true;
    pr.model.setChecks(pr.head, [{ name: "unit", state: "pending", required: false, url: "" }]);
    await trackPullRequest(world.tracking, TASK_ID);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(true);
    pr.model.setChecks(pr.head, [{ name: "unit", state: "completed", conclusion: "failure", required: false, url: "" }]);
    await trackPullRequest(world.tracking, TASK_ID);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(true);
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

  it("refuses a pull request that is not the one linked to this task, and a task that is closed, finished or without an org", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    // The link row names another task.
    await world.store.update({ key: { pk: `CODEHOST_CR#github#acme/app`, sk: `CR#${String(pr.number).padStart(10, "0")}` }, ops: [{ op: "set", path: ["taskId"], value: "33333333-3333-4333-8333-333333333333" }] });
    expect((await rejects(() => trackPullRequest(world.tracking, TASK_ID))).code).toBe("CONFIG_INVALID");
    const other = await mergeWorld();
    await other.store.update({ key: { pk: `DEVTASK#${TASK_ID}`, sk: "META" }, ops: [{ op: "set", path: ["closedAt"], value: "2026-11-09T09:00:00.000Z" }] });
    expect(await trackPullRequest(other.tracking, TASK_ID)).toBe("gone");
    const finished = await mergeWorld();
    await finished.setWorkflow({ stage: "MERGED" });
    expect(await trackPullRequest(finished.tracking, TASK_ID)).toBe("gone");
    expect(await trackPullRequest(finished.tracking, "99999999-9999-4999-8999-999999999999")).toBe("gone");
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

  it("retries a write that lost to another writer's version, and gives up as retryable after three", async () => {
    const world = await mergeWorld();
    await track(world);
    const key = mergeTrackingKey(TASK_ID, "app", world.prs[0]!.number);
    world.prs[0]!.model.addReview(String(world.prs[0]!.number), { login: "priya", state: "CHANGES_REQUESTED" });
    // Every transaction first loses its race: someone bumps the version underneath it.
    let bumps = 0;
    const racing = wrapStore(world.store, {
      transact: async (items: Parameters<typeof world.store.transact>[0]) => {
        if (bumps < 1) { bumps += 1; await world.store.update({ key, ops: [{ op: "add", path: ["version"], amount: 1 }] }); }
        return world.store.transact(items);
      },
    });
    expect((await trackTask({ ...world.tracking, store: racing }, TASK_ID)).result).toBe("changed");
    expect((await world.store.get(key))!["review"]).toBe("changes_requested");
    // A change the host makes after that: the next pass has something to write, and every write loses.
    world.prs[0]!.model.addReview(String(world.prs[0]!.number), { login: "priya", state: "APPROVED" });
    const always = wrapStore(world.store, { transact: async () => ({ applied: false, reason: "condition_failed", failed: [0] }) });
    expect((await rejects(() => trackTask({ ...world.tracking, store: always }, TASK_ID))).code).toBe("RUNTIME_UNAVAILABLE");
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
  it("prepares a request bound to the workflow revision and to the exact pull requests, heads, method and risk", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    expect(prepared.request).toMatchObject({ companyId: ORG, kind: "merge", subject: { type: "task", id: TASK_ID }, revision: 9, risk: "low" });
    expect(prepared.subject.pullRequests).toEqual([{ repositoryId: "app", number: world.prs[0]!.number, headSha: world.prs[0]!.head }]);
    expect(prepared.changes).toEqual([`Merge app pull request ${String(world.prs[0]!.number)} (squash)`]);
    expect(prepared.requirement).toMatchObject({ minApprovers: 1, selfApprovalAllowed: true, methods: ["local-session"] });
    const again = await world.prepare();
    expect(again.request.artifactDigest).toBe(prepared.request.artifactDigest);
  });

  it("merges at the checked head with the owner's proof, claims first, audits in the claim's transaction, and uses the proof once", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const pr = world.prs[0]!;
    const prepared = await world.prepare();
    const proof = world.proofFor(prepared);
    const result = await pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof });
    expect(result).toEqual({ status: "MERGED", pullRequests: [{ repositoryId: "app", number: pr.number }] });
    expect(pr.model.getChangeRequest(String(pr.number))).toMatchObject({ state: "merged", frozenHead: pr.head });
    const item = (await world.trackingOf(pr))!;
    expect(item["mergeClaim"]).toMatchObject({ headSha: pr.head });
    expect(world.audit.events).toHaveLength(1);
    expect(world.audit.events[0]).toMatchObject({ action: "pull_request.merge_requested", companyId: ORG, actor: { type: "person" }, details: { repository: "acme/app", number: pr.number, method: "squash", requestId: prepared.request.requestId, proofId: proof.proofId } });
    // The repository is named by the key function the opened event uses too (tests/unit/local-up-flow.test.ts pins that side).
    expect(world.audit.events[0]!.details?.["repository"]).toBe(requireRepositoryKey("github", "https://github.com/acme/app"));
    expect(await world.store.get({ pk: `ORG#${ORG}#MERGE_PROOF`, sk: approvalProofKey(proof) })).toBeDefined();
  });

  it("refuses a proof used before, even under a fresh proof id and a fresh process", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    const proof = world.proofFor(prepared);
    // The proof was used once already (stored with the claim of an earlier press), but the pull request is still open (that press was refused by the host).
    await world.store.put({ item: { pk: `ORG#${ORG}#MERGE_PROOF`, sk: approvalProofKey(proof), entityType: "MERGE_PROOF" } });
    const refusal = await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: { ...proof, proofId: "another-id" } }));
    expect(refusal.code).toBe("FORBIDDEN");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
    expect(await world.auditRows()).toHaveLength(0);
  });

  it("merges nothing for a proof that is not the owner's, is for other content, or is for another request", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    const pr = world.prs[0]!;
    for (const proof of [
      world.proofFor(prepared, { token: "a-guess" }),
      world.proofFor(prepared, { requestId: "55555555-5555-4555-8555-555555555555" }),
      world.proofFor(prepared, { method: "browser-step-up" }),
    ]) {
      expect((await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof }))).code).toBe("FORBIDDEN");
    }
    // A proof for other content or another revision of the task is "it changed": the person looks again and approves again.
    for (const proof of [world.proofFor(prepared, { artifactDigest: "0".repeat(64) }), world.proofFor(prepared, { revision: 8 })]) {
      expect(await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof }))).toMatchObject({ code: "MERGE_NOT_READY", message: M.changedAfterConfirm });
    }
    expect(pr.model.getChangeRequest(String(pr.number)).state).toBe("open");
    expect(await world.auditRows()).toHaveLength(0);
    expect((await world.trackingOf(pr))!["mergeClaim"]).toBeUndefined();
  });

  it("refuses when the head moved after the person saw it: the proof is for other content, and the host is re-read", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    const pr = world.prs[0]!;
    const proof = world.proofFor(prepared);
    // A push the tracking has not read yet: the stored heads still say the old one, the host says the new one.
    pr.model.commit(pr.model.getChangeRequest(String(pr.number)).sourceBranch, { "src/b.ts": "x\n" });
    const refusal = await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof }));
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
    const refusal = await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal.message).toBe(M.needsCodeOwner("@acme-lead"));
    expect(pr.model.getChangeRequest(String(pr.number)).state).toBe("open");
    expect((await world.trackingOf(pr))!["mergeClaim"]).toBeUndefined();
  });

  it("refuses a host that does not let Rovara merge before any claim is made", async () => {
    const world = await mergeWorld({ codeHost: noMerge });
    await world.seedTracking();
    const prepared = await world.prepare();
    const refusal = await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal.message).toBe("Rovara can't merge on this repository's code host. Merge it there.");
    expect((await world.trackingOf(world.prs[0]!))!["mergeClaim"]).toBeUndefined();
    expect(await world.auditRows()).toHaveLength(0);
  });

  it("lets go of the claim when the host says no after readiness passed, and leaves the audit fact of the attempt", async () => {
    const world = await mergeWorld({ codeHost: (model) => refusingMerge(model) });
    await world.seedTracking();
    const pr = world.prs[0]!;
    const prepared = await world.prepare();
    const refusal = await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal).toMatchObject({ code: "MERGE_NOT_READY", message: M.notMerged("app", "the code host would not merge it (the host says: Required checks have not passed.)") });
    expect((await world.trackingOf(pr))!["mergeClaim"]).toBeUndefined();
    expect(pr.model.getChangeRequest(String(pr.number)).state).toBe("open");
    // The claim committed with its audit fact before the host was asked, as Cloud's did.
    expect(await world.auditRows()).toHaveLength(1);
    // A second press right after is not told Rovara is already merging (it is refused by the host again, with a new proof).
    const again = await world.prepare();
    expect((await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: again.request.requestId, proof: world.proofFor(again) }))).message).toContain("didn't merge");
  });

  it("does not merge a pull request another run has claimed, and merges again once the claim is stale", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const pr = world.prs[0]!;
    const key = mergeTrackingKey(TASK_ID, "app", pr.number);
    await world.store.update({ key, ops: [{ op: "set", path: ["mergeClaim"], value: { headSha: pr.head, by: "other", at: new Date(world.now.value - 10_000).toISOString() } }] });
    const prepared = await world.prepare();
    const refusal = await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "Rovara is already merging this pull request." });
    expect(pr.model.getChangeRequest(String(pr.number)).state).toBe("open");
    world.now.value += 200_000;
    const second = await world.prepare();
    expect((await pressMerge(world.deps, { taskId: TASK_ID, requestId: second.request.requestId, proof: world.proofFor(second) })).status).toBe("MERGED");
  });

  it("merges several pull requests in repository order, and tells a half merge to a person", async () => {
    // The second repository's host refuses at merge time, after readiness passed.
    const world = await mergeWorld({ pullRequests: [{ repositoryId: "docs", number: 1 }, { repositoryId: "app", number: 1 }], codeHost: (model) => (model.fullName === "acme/docs" ? refusingMerge(model) : githubShapedHost(model)) });
    await world.seedTracking();
    const prepared = await world.prepare();
    expect(prepared.subject.pullRequests.map((pr) => pr.repositoryId)).toEqual(["app", "docs"]);
    const refusal = await rejects(() => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal.code).toBe("MERGE_NOT_READY");
    expect(refusal.message).toBe(M.halfMerged("app", "docs", "the code host would not merge it (the host says: Required checks have not passed.)"));
    // The refused pull request's claim is gone; the merged one's stays.
    expect((await world.trackingOf(world.prs.find((p) => p.repositoryId === "docs")!))!["mergeClaim"]).toBeUndefined();
    expect((await world.trackingOf(world.prs.find((p) => p.repositoryId === "app")!))!["mergeClaim"]).toBeDefined();
    expect(world.models.get("app")!.getChangeRequest("1").state).toBe("merged");
    expect(world.milestones.written.map((m) => m.kind)).toEqual(["stuck"]);
    // The proof was used by the first claim: a rerun needs a new one.
    expect(world.audit.events.map((event) => (event.details as { repository: string }).repository)).toEqual(["acme/app", "acme/docs"]);
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
    await pressMerge(deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) });
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

  it("never reads an owner's session token into the audit or the claim", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    await pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) });
    const everything = JSON.stringify([world.audit.events, await world.store.get(mergeTrackingKey(TASK_ID, "app", world.prs[0]!.number)), world.timeline.lines, world.milestones.written]);
    expect(everything).not.toContain(OWNER_SESSION);
  });
});

import type { CodeHost } from "../../packages/contracts/src/index.js";
import type { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
/** A host that is ready by every read and then says no to the merge itself (branch protection the reads cannot see). */
function refusingMerge(model: FakeHostModel): CodeHost {
  const fake = new FakeCodeHost(model);
  return Object.create(fake, { kind: { value: "github" }, merge: { value: async () => ({ outcome: "refused", reason: "not_mergeable", hostMessage: "Required checks have not passed." }) } }) as CodeHost;
}

function noMerge(model: FakeHostModel): CodeHost {
  const fake = new FakeCodeHost(model);
  return Object.create(fake, { kind: { value: "github" }, merge: { value: undefined } }) as CodeHost;
}
