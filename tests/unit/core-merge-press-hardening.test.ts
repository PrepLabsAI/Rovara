// Port lane L7a, review round 1: what the press must keep when the adapter, the host or the store behave badly. Authority and money cases from Cloud's merge tests that the first round of
// tests did not cover: a race, a change after prepare, an unknown host outcome, a rerun after a half merge, a proof from another company, a replayed comment proof.
import { describe, expect, it } from "vitest";
import { MERGE_NOT_READY_MESSAGES as M, type Approvers, type CodeHost } from "../../packages/contracts/src/index.js";
import { createLocalOwnerApprovers, localOwnerPrincipal, CODE_HOST_COMMENT_METHOD } from "../../packages/core/src/ports/policy-defaults.js";
import { FakeCodeHost, type FakeHostModel } from "@rovara-code/core/fakes";
import { pressMerge, prepareMerge } from "../../packages/core/src/core/merge/index.js";
import { ORG, TASK_ID, githubShapedHost, mergeWorld, wrapStore, OWNER_SESSION, type MergeWorld } from "../support/merge-world.js";
import { commentReads, freshComment } from "../support/comment-fakes.js";

const rejects = async (run: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try { await run(); } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { ...(code === undefined ? {} : { code }), message: code !== undefined && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message };
  }
  throw new Error("expected a refusal");
};
const go = (world: MergeWorld, prepared: Awaited<ReturnType<typeof prepareMerge>>, proof = world.proofFor(prepared)) =>
  pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof });

/** A host that counts merges, and can be told to refuse them, fail them with an unknown outcome, or refuse only the first. */
function countingHost(model: FakeHostModel, mode: { value: "ok" | "refuse" | "unknown"; calls: number; refuseOnce?: boolean }): CodeHost {
  const fake = new FakeCodeHost(model);
  return Object.create(fake, {
    kind: { value: "github" },
    merge: { value: async (...args: Parameters<NonNullable<CodeHost["merge"]>>) => {
      mode.calls += 1;
      if (mode.value === "unknown") throw new Error("socket hang up");
      if (mode.value === "refuse" || mode.refuseOnce === true) { mode.refuseOnce = false; return { outcome: "refused" as const, reason: "not_mergeable" as const, hostMessage: "Required checks have not passed." }; }
      return fake.merge(...args);
    } },
  }) as CodeHost;
}

describe("the press under pressure", () => {
  it("makes exactly one host merge call when two presses race", async () => {
    const mode = { value: "ok" as "ok" | "refuse" | "unknown", calls: 0 };
    const world = await mergeWorld({ codeHost: (model) => countingHost(model, mode) });
    await world.seedTracking();
    const a = await world.prepare();
    const b = await world.prepare();
    const results = await Promise.allSettled([go(world, a), go(world, b)]);
    expect(mode.calls).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("merged");
  });

  it("re-reads the host at merge time: a review that asked for changes, red checks or a lost approval after the person approved stop the merge, and nothing is claimed", async () => {
    for (const [name, change, words] of [
      ["changes requested", (w: MergeWorld) => w.prs[0]!.model.addReview(String(w.prs[0]!.number), { login: "priya", state: "CHANGES_REQUESTED" }), M.changesRequested],
      ["red checks", (w: MergeWorld) => w.prs[0]!.model.setChecks(w.prs[0]!.head, [{ name: "unit", state: "completed", conclusion: "failure", required: false, url: "" }]), M.checks],
      ["approval dismissed", (w: MergeWorld) => w.prs[0]!.model.addReview(String(w.prs[0]!.number), { login: "priya", state: "DISMISSED" }), M.needsWriteApproval("app")],
    ] as const) {
      const world = await mergeWorld();
      await world.seedTracking();
      const prepared = await world.prepare();
      change(world);
      expect((await rejects(() => go(world, prepared))).message, name).toBe(words);
      expect((await world.trackingOf(world.prs[0]!))!["mergeClaim"], name).toBeUndefined();
      expect(await world.auditRows(), name).toHaveLength(0);
    }
  });

  it("refuses a pull request added to the task after the person approved", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    const task = await world.task();
    await world.setWorkflow({ pullRequests: [...task.workflow.pullRequests!, { ...task.workflow.pullRequests![0]!, repositoryId: "docs", number: 9 }] });
    const refusal = await rejects(() => go(world, prepared));
    expect(refusal.code).toBe("MERGE_NOT_READY");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });

  it("keeps the claim and the proof when the host's outcome is unknown, and a rerun finds the pull request merged without asking the host to merge again", async () => {
    const mode = { value: "unknown" as "ok" | "refuse" | "unknown", calls: 0 };
    const world = await mergeWorld({ codeHost: (model) => countingHost(model, mode) });
    await world.seedTracking();
    const pr = world.prs[0]!;
    const prepared = await world.prepare();
    await expect(go(world, prepared)).rejects.toThrow("socket hang up");
    expect((await world.trackingOf(pr))!["mergeClaim"]).toBeDefined();
    expect(await world.auditRows()).toHaveLength(1);
    // The same proof cannot be used again.
    expect((await rejects(() => go(world, prepared))).code).toBe("FORBIDDEN");
    // The host did merge it after all; once the claim has aged, a new press with a new proof finds that out.
    pr.model.merge(String(pr.number), { revision: pr.head, method: "squash" });
    world.now.value += 200_000;
    mode.value = "ok";
    const again = await world.prepare();
    expect((await go(world, again)).pullRequests).toEqual([{ repositoryId: "app", number: pr.number }]);
    expect(mode.calls).toBe(1);
  });

  it("finishes a half merge with a new proof, merging only what is left, and refuses the old proof", async () => {
    const mode = { value: "ok" as const, calls: 0, refuseOnce: false };
    const world = await mergeWorld({
      pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "docs", number: 1 }],
      codeHost: (model) => (model.fullName === "acme/docs" ? countingHost(model, Object.assign(mode, { refuseOnce: true })) : githubShapedHost(model)),
    });
    await world.seedTracking();
    const prepared = await world.prepare();
    const proof = world.proofFor(prepared);
    const half = await rejects(() => go(world, prepared, proof));
    expect(half.message).toContain("merged, but docs didn't");
    expect(world.models.get("app")!.getChangeRequest("1").state).toBe("merged");
    // The old proof is used up; the claim of the refused one was released, the merged one's stays.
    expect((await rejects(() => go(world, prepared, proof))).code).toBe("FORBIDDEN");
    // The workflow records the first pull request as merged (the sweep does that), and a new proof merges the rest.
    const task = await world.task();
    await world.setWorkflow({ pullRequests: task.workflow.pullRequests!.map((entry) => (entry.repositoryId === "app" ? { ...entry, state: "MERGED" } : entry)) });
    await world.store.update({ key: { pk: `DEVTASK#${TASK_ID}`, sk: `MERGE_TRACKING#app#1` }, ops: [{ op: "set", path: ["state"], value: "merged" }] });
    const second = await world.prepare();
    expect((await go(world, second)).pullRequests.map((entry) => entry.repositoryId)).toEqual(["app", "docs"]);
    expect(world.models.get("docs")!.getChangeRequest("1").state).toBe("merged");
  });

  it("refuses a task that was closed between the approval and the merge", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    let reads = 0;
    const deps = { ...world.deps, host: { ...world.host, loadTask: async (id: string) => { reads += 1; const t = await world.host.loadTask(id); return reads >= 2 && t !== undefined ? { ...t, closedAt: "2026-11-09T10:00:01.000Z" } : t; } } };
    const refusal = await rejects(() => pressMerge(deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal.message).toBe(M.taskClosed);
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });

  it("refuses a task whose workflow moved to another revision between the approval and the merge", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    let reads = 0;
    const deps = { ...world.deps, host: { ...world.host, loadTask: async (id: string) => { reads += 1; const t = await world.host.loadTask(id); return reads >= 2 && t?.workflow !== undefined ? { ...t, workflow: { ...t.workflow, revision: t.workflow.revision + 1 } } : t; } } };
    const refusal = await rejects(() => pressMerge(deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal.message).toBe(M.changedAfterConfirm);
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });

  it("refuses a proof for another company, and a proof made for another task's request", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    const foreign = createLocalOwnerApprovers({ owner: localOwnerPrincipal({ companyId: "org_zzzzzzzzzzzzzzzzzzzz" }), verifySession: (token) => token === OWNER_SESSION });
    expect((await rejects(() => pressMerge({ ...world.deps, approvers: foreign }, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }))).code).toBe("FORBIDDEN");
    const other = await world.prepare();
    expect((await rejects(() => go(world, other, world.proofFor(prepared)))).code).toBe("FORBIDDEN");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });

  it("merges by the method the person was shown: a setting changed in between is a new question", async () => {
    const world = await mergeWorld({ mergeMethod: "squash" });
    await world.seedTracking();
    const prepared = await world.prepare();
    let reads = 0;
    const settings = { read: async () => ({ allowSelfApproval: true, mergeMethod: (reads += 1) > 1 ? ("merge" as const) : ("squash" as const), codeReviewers: [], revision: 1 }) };
    const refusal = await rejects(() => pressMerge({ ...world.deps, settings }, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal.message).toBe(M.changedAfterConfirm);
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });
});

describe("what the approver adapter requires is enforced by the press", () => {
  const stub = (requirement: { methods: string[]; minApprovers: number }, calls: { verify: number }): Approvers => ({
    requirement: async () => ({ ...requirement, selfApprovalAllowed: true }),
    verify: async (_request, proof) => { calls.verify += 1; return { approved: true, approver: localOwnerPrincipal(), method: proof.method, proofId: proof.proofId }; },
  });

  it("refuses a method the adapter does not list, before the proof is looked at", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const calls = { verify: 0 };
    const deps = { ...world.deps, approvers: stub({ methods: ["browser-step-up"], minApprovers: 1 }, calls) };
    const prepared = await prepareMerge(deps, { taskId: TASK_ID, requestId: world.requestId() });
    expect((await rejects(() => pressMerge(deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }))).code).toBe("FORBIDDEN");
    expect(calls.verify).toBe(0);
  });

  it("refuses when the adapter needs more than one approver, which cannot be collected yet", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const calls = { verify: 0 };
    const deps = { ...world.deps, approvers: stub({ methods: ["local-session"], minApprovers: 2 }, calls) };
    const prepared = await prepareMerge(deps, { taskId: TASK_ID, requestId: world.requestId() });
    const refusal = await rejects(() => pressMerge(deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal).toMatchObject({ code: "FORBIDDEN" });
    expect(refusal.message).toContain("more than one approver");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });

  it("refuses a verdict whose method the adapter does not list, even when verify approved it", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const deps = { ...world.deps, approvers: { requirement: async () => ({ methods: ["local-session"], minApprovers: 1, selfApprovalAllowed: true }), verify: async (_r: unknown, proof: { proofId: string }) => ({ approved: true as const, approver: localOwnerPrincipal(), method: "something-else", proofId: proof.proofId }) } as Approvers };
    const prepared = await prepareMerge(deps, { taskId: TASK_ID, requestId: world.requestId() });
    expect((await rejects(() => pressMerge(deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }))).code).toBe("FORBIDDEN");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });

  it("calls a claim transaction that failed on its audit step a fault, not 'already used'", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    // The claim (0) and the proof row (1) hold; the audit step (2) fails.
    const failing = wrapStore(world.store, { transact: async (items: Parameters<typeof world.store.transact>[0]) => (items.length === 3 && items[2]!.kind === "put" ? { applied: false as const, reason: "condition_failed" as const, failed: [2] } : world.store.transact(items)) });
    const refusal = await rejects(() => pressMerge({ ...world.deps, store: failing }, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared) }));
    expect(refusal.code).toBe("RUNTIME_UNAVAILABLE");
    expect(world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state).toBe("open");
  });

  it("hands the adapter the risk level, so a stricter rule for a high-risk merge is the adapter's to make", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    await world.setWorkflow({ risk: { level: "high", reasons: ["auth"], candidateDigest: "c".repeat(64) } });
    const prepared = await world.prepare();
    expect(prepared.request.risk).toBe("high");
  });
});

describe("a proof that names one act is used up by what it is", () => {
  it("does not let one approving comment approve a second request, even with a new request id, and does not burn a local session", async () => {
    const mode = { value: "ok" as "ok" | "refuse" | "unknown", calls: 0, refuseOnce: true };
    const world = await mergeWorld({ codeHost: (model) => countingHost(model, mode) });
    await world.seedTracking();
    const approvers = createLocalOwnerApprovers({
      ...commentReads(freshComment({ provider: "github", tenant: "", accountId: "priya" })),
      verifySession: (token) => token === OWNER_SESSION,
    });
    const deps = { ...world.deps, approvers };
    const comment = (prepared: Awaited<ReturnType<typeof prepareMerge>>) => world.proofFor(prepared, { method: CODE_HOST_COMMENT_METHOD, token: "comment-9001" });
    // The first request: the host refuses the merge after the claim consumed the comment.
    const first = await prepareMerge(deps, { taskId: TASK_ID, requestId: world.requestId() });
    expect((await rejects(() => pressMerge(deps, { taskId: TASK_ID, requestId: first.request.requestId, proof: comment(first) }))).message).toContain("didn't merge");
    // A new request id (and the same comment) is refused, and nothing is claimed.
    const second = await prepareMerge(deps, { taskId: TASK_ID, requestId: world.requestId() });
    const refusal = await rejects(() => pressMerge(deps, { taskId: TASK_ID, requestId: second.request.requestId, proof: comment(second) }));
    expect(refusal).toMatchObject({ code: "FORBIDDEN", message: "This approval was already used. Ask for a new one." });
    expect((await world.trackingOf(world.prs[0]!))!["mergeClaim"]).toBeUndefined();
    // The owner's local session is a standing secret by design: it approves the next request.
    const third = await prepareMerge(deps, { taskId: TASK_ID, requestId: world.requestId() });
    expect((await pressMerge(deps, { taskId: TASK_ID, requestId: third.request.requestId, proof: world.proofFor(third) })).status).toBe("MERGED");
    void ORG;
  });
});
