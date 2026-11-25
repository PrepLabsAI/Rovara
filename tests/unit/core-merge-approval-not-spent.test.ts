// MERGE-APPROVAL-NOT-SPENT-ON-REFUSAL: an approval is used up only when the merge proceeds (the claim of the first pull request, which writes the use of the proof in its own transaction).
// A refusal anywhere before that claim (the late readiness ask included) leaves the same approval usable; a merge that proceeded uses it exactly once.
import { describe, expect, it } from "vitest";
import { companyScoped, MERGE_NOT_READY_MESSAGES as M, type CodeHost } from "../../packages/contracts/src/index.js";
import { FakeCodeHost, type FakeHostModel } from "@agentx/broker/fakes";
import { createLocalOwnerApprovers, CODE_HOST_COMMENT_METHOD } from "../../packages/broker/src/ports/policy-defaults.js";
import { pressMerge, prepareMerge } from "../../packages/broker/src/core/merge/index.js";
import { ORG, TASK_ID, githubShapedHost, mergeWorld, OWNER_SESSION, type MergeWorld } from "../support/merge-world.js";
import { APPROVAL_PROOF_METHOD, createHostedApprovers } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { commentReads, freshComment } from "../support/comment-fakes.js";

const rejects = async (run: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try { await run(); } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { ...(code === undefined ? {} : { code }), message: code !== undefined && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message };
  }
  throw new Error("expected a refusal");
};
const LATE_WORDS = "A second review did not run. Acknowledge it first.";

/** The merge's second-review wait: `prepareMerge` asks first (odd asks) and the merge's own readiness asks again (even asks); `late.refuse` makes only the late ask refuse. */
function lateAsk(): { late: { refuse: boolean }; mergeWait: () => string | undefined; asks: () => number } {
  const late = { refuse: true };
  let asks = 0;
  return { late, asks: () => asks, mergeWait: () => { asks += 1; return late.refuse && asks % 2 === 0 ? LATE_WORDS : undefined; } };
}
const useRows = async (world: MergeWorld, partition: string): Promise<unknown[]> => (await world.store.query({ pk: companyScoped(ORG, partition) })).items;
const host = (world: MergeWorld) => world.prs[0]!.model.getChangeRequest(String(world.prs[0]!.number)).state;

describe("an approval is not spent by a refusal before the merge proceeds", () => {
  it("a refusal at the late ask leaves the SAME approval usable: the retry merges, and the proof is used exactly once", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const waits = lateAsk();
    const deps = { ...world.deps, mergeWait: waits.mergeWait };
    const prepared = await prepareMerge(world.deps, { taskId: TASK_ID, requestId: world.requestId() });
    const proof = world.proofFor(prepared);
    const press = () => pressMerge(deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof });
    expect(await rejects(press)).toMatchObject({ code: "MERGE_NOT_READY", message: LATE_WORDS });
    // Nothing was claimed, merged, audited or used up.
    expect(host(world)).toBe("open");
    expect((await world.trackingOf(world.prs[0]!))!["mergeClaim"]).toBeUndefined();
    expect(await world.auditRows()).toHaveLength(0);
    expect(await useRows(world, "MERGE_PROOF")).toHaveLength(0);
    // The wait is over: the same approval merges.
    waits.late.refuse = false;
    expect((await press()).status).toBe("MERGED");
    expect(host(world)).toBe("merged");
    expect(await useRows(world, "MERGE_PROOF")).toHaveLength(1);
    expect(await world.auditRows()).toHaveLength(1);
  });

  it("a replay after the merge is still refused as already used, and merges and audits nothing more", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    const proof = world.proofFor(prepared);
    const press = () => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof });
    expect((await press()).status).toBe("MERGED");
    expect(await rejects(press)).toMatchObject({ code: "FORBIDDEN", message: M.approvalUsed });
    expect(await useRows(world, "MERGE_PROOF")).toHaveLength(1);
    expect(await world.auditRows()).toHaveLength(1);
  });

  it("a replay after the merge is refused even when the adapter forgot the proof (a restart): the merge's own rows remember", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    const proof = world.proofFor(prepared);
    expect((await pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof })).status).toBe("MERGED");
    const restarted = createLocalOwnerApprovers({ verifySession: (token) => token === OWNER_SESSION });
    expect(await rejects(() => pressMerge({ ...world.deps, approvers: restarted }, { taskId: TASK_ID, requestId: prepared.request.requestId, proof }))).toMatchObject({ code: "FORBIDDEN", message: M.approvalUsed });
    expect(await world.auditRows()).toHaveLength(1);
  });

  it("a one-act proof (an approving comment) refused at the late ask is not used up either, and a merge uses its token once", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const approvers = createLocalOwnerApprovers({ ...commentReads(freshComment({ provider: "github", tenant: "", accountId: "priya" })), verifySession: (token) => token === OWNER_SESSION });
    const waits = lateAsk();
    const deps = { ...world.deps, approvers, mergeWait: waits.mergeWait };
    const prepared = await prepareMerge({ ...world.deps, approvers }, { taskId: TASK_ID, requestId: world.requestId() });
    const proof = world.proofFor(prepared, { method: CODE_HOST_COMMENT_METHOD, token: "comment-9001" });
    const press = () => pressMerge(deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof });
    expect((await rejects(press)).message).toBe(LATE_WORDS);
    expect(await useRows(world, "MERGE_PROOF_TOKEN")).toHaveLength(0);
    waits.late.refuse = false;
    expect((await press()).status).toBe("MERGED");
    expect(await useRows(world, "MERGE_PROOF_TOKEN")).toHaveLength(1);
    expect((await rejects(press)).message).toBe(M.approvalUsed);
  });

  it("two presses of the same approval at once merge once and use the proof once", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const prepared = await world.prepare();
    const proof = world.proofFor(prepared);
    const press = () => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof });
    const results = await Promise.allSettled([press(), press()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(host(world)).toBe("merged");
    expect(await useRows(world, "MERGE_PROOF")).toHaveLength(1);
    expect(await world.auditRows()).toHaveLength(1);
  });

  // ---- a code-host refusal after the claim

  /** A host that counts merges and can refuse the first one (nothing merged), or fail with an unknown outcome. */
  const hostThat = (mode: { calls: number; refuseOnce?: boolean; unknown?: boolean }) => (model: FakeHostModel): CodeHost => {
    const fake = new FakeCodeHost(model);
    return Object.create(fake, {
      kind: { value: "github" },
      merge: { value: async (...args: Parameters<NonNullable<CodeHost["merge"]>>) => {
        mode.calls += 1;
        if (mode.unknown === true) throw new Error("socket hang up");
        if (mode.refuseOnce === true) { mode.refuseOnce = false; return { outcome: "refused" as const, reason: "not_mergeable" as const, hostMessage: "Required checks have not passed." }; }
        return fake.merge(...args);
      } },
    }) as CodeHost;
  };

  it("a host refusal that merged nothing frees the approval for the same head: the same proof retries and merges once", async () => {
    const mode = { calls: 0, refuseOnce: true };
    const world = await mergeWorld({ codeHost: hostThat(mode) });
    await world.seedTracking();
    const prepared = await world.prepare();
    const proof = world.proofFor(prepared);
    const press = () => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof });
    expect((await rejects(press)).message).toContain("didn't merge");
    // The claim and the use of the approval are both gone; the audit fact of the refused try stays.
    expect((await world.trackingOf(world.prs[0]!))!["mergeClaim"]).toBeUndefined();
    expect(await useRows(world, "MERGE_PROOF")).toHaveLength(0);
    expect((await press()).status).toBe("MERGED");
    expect(await useRows(world, "MERGE_PROOF")).toHaveLength(1);
    expect(mode.calls).toBe(2);
    // Freed once, used for good after the merge: a replay is refused in words that say what happened.
    expect(await rejects(press)).toMatchObject({ code: "FORBIDDEN", message: M.approvalUsed });
    expect(mode.calls).toBe(2);
  });

  it("a freed approval is dead once the head moves: a push after the refusal needs a new approval, and nothing merges", async () => {
    const mode = { calls: 0, refuseOnce: true };
    const world = await mergeWorld({ codeHost: hostThat(mode) });
    await world.seedTracking();
    const prepared = await world.prepare();
    const proof = world.proofFor(prepared);
    const press = () => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof });
    expect((await rejects(press)).message).toContain("didn't merge");
    // A push: tracking now holds another head, so what would be merged is another digest than the one the approval is bound to.
    await world.seedTracking({ headSha: "e".repeat(40) });
    expect(await rejects(press)).toMatchObject({ code: "MERGE_NOT_READY", message: M.staleApproval });
    expect(mode.calls).toBe(1);
    expect(host(world)).toBe("open");
  });

  it("an unknown host outcome keeps the approval used, and the person is told what happened and what to do, not just 'used'", async () => {
    const mode = { calls: 0, unknown: true };
    const world = await mergeWorld({ codeHost: hostThat(mode) });
    await world.seedTracking();
    const prepared = await world.prepare();
    const proof = world.proofFor(prepared);
    const press = () => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof });
    await expect(press()).rejects.toThrow("socket hang up");
    const again = await rejects(press);
    expect(again).toMatchObject({ code: "FORBIDDEN", message: M.approvalUsed });
    expect(again.message).toContain("approve it again");
    expect(mode.calls).toBe(1);
  });

  it("a half merge keeps its approval used (never freed after a merge)", async () => {
    const mode = { calls: 0, refuseOnce: true };
    const world = await mergeWorld({
      pullRequests: [{ repositoryId: "app", number: 1 }, { repositoryId: "docs", number: 1 }],
      codeHost: (model) => (model.fullName === "acme/docs" ? hostThat(mode)(model) : githubShapedHost(model)),
    });
    await world.seedTracking();
    const prepared = await world.prepare();
    const proof = world.proofFor(prepared);
    const press = () => pressMerge(world.deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof });
    expect((await rejects(press)).message).toContain("merged, but docs didn't");
    expect(await useRows(world, "MERGE_PROOF")).toHaveLength(1);
    expect(await rejects(press)).toMatchObject({ code: "FORBIDDEN", message: M.approvalUsed });
  });

  it("a comment that approved request A (outcome unknown, so it stays used) is refused for request B in the words for a used approval, not as 'already merging'", async () => {
    const mode = { calls: 0, unknown: true };
    const world = await mergeWorld({ codeHost: hostThat(mode) });
    await world.seedTracking();
    const approvers = createLocalOwnerApprovers({ ...commentReads(freshComment({ provider: "github", tenant: "", accountId: "priya" })), verifySession: (token) => token === OWNER_SESSION });
    const deps = { ...world.deps, approvers };
    const comment = (prepared: Awaited<ReturnType<typeof prepareMerge>>) => world.proofFor(prepared, { method: CODE_HOST_COMMENT_METHOD, token: "comment-9001" });
    const a = await prepareMerge(deps, { taskId: TASK_ID, requestId: world.requestId() });
    await expect(pressMerge(deps, { taskId: TASK_ID, requestId: a.request.requestId, proof: comment(a) })).rejects.toThrow("socket hang up");
    // The claim of A is still held (the outcome is unknown), so only the proof's own rows can say "used" for B: the token row of what the comment IS.
    expect(await useRows(world, "MERGE_PROOF_TOKEN")).toHaveLength(1);
    const b = await prepareMerge(deps, { taskId: TASK_ID, requestId: world.requestId() });
    expect(await rejects(() => pressMerge(deps, { taskId: TASK_ID, requestId: b.request.requestId, proof: comment(b) }))).toMatchObject({ code: "FORBIDDEN", message: M.approvalUsed });
    expect(mode.calls).toBe(1);
  });

  it("on the hosted approvers a merge press with a proof is REFUSED (the hosted verify needs a caller that settles claims, which the merge press is not), and nothing is claimed or used", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const hosted = createHostedApprovers({ store: world.store, identity: { getPrincipal: async () => undefined }, key: Buffer.from("k".repeat(32)), now: () => new Date(world.now.value) });
    const deps = { ...world.deps, approvers: hosted };
    const prepared = await prepareMerge(deps, { taskId: TASK_ID, requestId: world.requestId() });
    const refusal = await rejects(() => pressMerge(deps, { taskId: TASK_ID, requestId: prepared.request.requestId, proof: world.proofFor(prepared, { method: APPROVAL_PROOF_METHOD, token: "x" }) }));
    expect(refusal).toMatchObject({ code: "FORBIDDEN", message: "Nobody approved this merge, so nothing was merged." });
    expect(host(world)).toBe("open");
    expect(await useRows(world, "MERGE_PROOF")).toHaveLength(0);
  });
});
