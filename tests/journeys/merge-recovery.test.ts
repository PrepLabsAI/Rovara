// journey-gate: 12
// Journey 12: merge recovery. A pull request is merged on the code host without Rovara's press (no webhook: the merge tracking poll must see it), at a head Rovara did not check, or refused by the
// host. On the real core and the real worker; see briefs/arch-cleanup/A1-JOURNEY-TESTS-PLAN.md. D1 deletes tests/integration/workflow-e2e/12-merge-recovery.test.ts, which this replaces in part.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createJourneyWorld, MAYA, type JourneyWorld } from "./harness/hosted-core.js";
import { buildUntilPullRequest, hostReady, planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

async function openPullRequest(w: JourneyWorld) {
  const taskId = await startTask(w);
  await planUntilCard(w, taskId);
  await w.approvePlan(taskId);
  const pullRequest = await buildUntilPullRequest(w, taskId);
  return { taskId, pullRequest };
}
const taskOf = async (w: JourneyWorld, taskId: string) => (await w.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string; workflow: { stage: string; state: string; blockReason?: string } };

describe("journey 12: merge recovery", () => {
  it("someone merges the pull request on the code host with no webhook: the merge tracking poll sees it, the task reads merged, and closing it afterwards works", async () => {
    world = await createJourneyWorld();
    const { taskId, pullRequest } = await openPullRequest(world);
    await hostReady(world, pullRequest);
    expect(pullRequest.draft.state).toBe("open");
    // The merge happens on the host, outside Rovara (a teammate's button on the host).
    expect(world.harness.world.host.model.merge(pullRequest.draft.id, { revision: pullRequest.commit, method: "squash" }, "octocat")).toMatchObject({ outcome: "merged" });
    // Nothing tells Rovara; its poll finds out.
    await world.runJobs(120);
    await world.runJobs(120);
    const merged = await taskOf(world, taskId);
    expect({ stage: merged.workflow.stage, state: merged.workflow.state }).toEqual({ stage: "MERGED", state: "COMPLETE" });
    const closed = await world.maya("POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    expect(closed.body).toMatchObject({ closed: true });
    world.proof.assertAllCore();
  }, 180_000);

  it("a merge at a head Rovara did not check (someone pushed another commit first) is not taken for Rovara's work: the task does not read merged", async () => {
    world = await createJourneyWorld();
    const { taskId, pullRequest } = await openPullRequest(world);
    await hostReady(world, pullRequest);
    const model = world.harness.world.host.model;
    const foreignHead = model.commit(pullRequest.draft.sourceBranch, { "extra.txt": "someone else wrote this" });
    expect(model.merge(pullRequest.draft.id, { revision: foreignHead, method: "squash" }, "octocat")).toMatchObject({ outcome: "merged" });
    await world.runJobs(120);
    await world.runJobs(120);
    const after = await taskOf(world, taskId);
    expect(after.workflow.stage, "the task is not called merged: the merged code is not what Rovara checked").not.toBe("MERGED");
    expect({ stage: after.workflow.stage, state: after.workflow.state, reason: after.workflow.blockReason }, "what the owner sees").toEqual({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", reason: "The pull request was merged with commits Rovara did not check, so this is not a merge of the code Rovara checked. Look at what was merged, then close this task." });
    world.proof.assertAllCore();
  }, 180_000);

  it("the host refuses the merge at the moment of the press (conflicts appeared after the owner looked): the owner is told in words and nothing merges; once the conflict is gone the same owner merges", async () => {
    world = await createJourneyWorld();
    const { taskId, pullRequest } = await openPullRequest(world);
    // Default rules; since 27c (8c288c790) the requester is the creator while a member, so her own linked account is enough (the old fixture linked the per-task owner key too).
    await world.linkGithubAsConnected(MAYA, "maya-gh");
    await hostReady(world, pullRequest);
    const ready = await world.maya("GET", `/v1/app/tasks/${taskId}/merge`);
    expect(ready.body, JSON.stringify(ready.body)).toMatchObject({ mayMerge: true, ready: true });
    pullRequest.draft.conflicts = true;
    const refused = await world.maya("POST", `/v1/app/tasks/${taskId}/merge`, { requestId: randomUUID(), expectedHeads: ready.body.heads, risk: ready.body.risk });
    expect({ status: refused.status, error: refused.body.error }, "the owner is told").toEqual({ status: 409, error: { code: "MERGE_NOT_READY", message: "The branch conflicts with main. I'm resolving it." } });
    expect(pullRequest.draft.state, "nothing merged").toBe("open");
    pullRequest.draft.conflicts = false;
    await world.runJobs(120);
    const again = await world.maya("GET", `/v1/app/tasks/${taskId}/merge`);
    const merged = await world.maya("POST", `/v1/app/tasks/${taskId}/merge`, { requestId: randomUUID(), expectedHeads: again.body.heads, risk: again.body.risk });
    expect(merged.body, JSON.stringify(merged)).toMatchObject({ status: "MERGED" });
    world.proof.assertAllCore();
  }, 180_000);
});
