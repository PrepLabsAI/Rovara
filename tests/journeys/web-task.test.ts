// journey-gate: 1, 5, 9
// A1-0 spike: journey 1 (QUICK path) on the real core, with the real-core proof. See briefs/arch-cleanup/A1-JOURNEY-TESTS-PLAN.md.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createJourneyWorld, MAYA, type JourneyWorld } from "./harness/hosted-core.js";
import { buildUntilPullRequest, hostReady, planFullToImplement, planUntilCard, startTask } from "./harness/task.js";
import { decide, fixUntilPush, openPullRequest, reviewRound } from "./harness/feedback.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

describe("journey 1: the web task, start to close", () => {
  it("start, plan, approve, build, review, pull request, merge, close, all on the core", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await planUntilCard(world, taskId);
    await world.approvePlan(taskId);
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "IMPLEMENT" });
    const pullRequest = await buildUntilPullRequest(world, taskId);
    expect(pullRequest.draft).toMatchObject({ draft: true, state: "open" });
    // The project's DEFAULT merge rules (self-approval off). Since 27c (8c288c790) the requester is the task's creator while a member, so linking her own account the way Connect GitHub does is enough.
    await world.linkGithubAsConnected(MAYA, "maya-gh");
    await hostReady(world, pullRequest);
    const mergeView = await world.maya("GET", `/v1/app/tasks/${taskId}/merge`);
    expect(mergeView.body, JSON.stringify(mergeView)).toMatchObject({ mayMerge: true, ready: true });
    const merged = await world.maya("POST", `/v1/app/tasks/${taskId}/merge`, { requestId: randomUUID(), expectedHeads: mergeView.body.heads, risk: mergeView.body.risk });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body).toMatchObject({ status: "MERGED" });
    expect(pullRequest.draft.state).toBe("merged");
    await world.runJobs(120);
    await world.runJobs(120);
    const afterMerge = await world.maya("GET", `/v1/dev/tasks/${taskId}`);
    const view = afterMerge.body.task as { status: string; pullRequests: Array<{ state: string }>; workflow: { stage: string; state: string } };
    expect({ status: view.status, stage: view.workflow.stage, state: view.workflow.state }, "after merge").toEqual({ status: "SUCCEEDED", stage: "MERGED", state: "COMPLETE" });
    const closed = await world.maya("POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    expect(closed.status, JSON.stringify(closed.body).slice(0, 300)).toBe(200);
    const { closed: isClosed, message } = closed.body as { closed?: boolean; message?: string };
    expect({ isClosed, message }, "close answer").toEqual({ isClosed: true, message: undefined });
    const reread = (await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { closedAt?: string };
    expect(reread, "the task reads closed").toMatchObject({ status: "CLOSED" });

    world.proof.assertAllCore();
  }, 120_000);

  it("the real-core proof fails the journey when the core declines a request (an old handler would have answered)", async () => {
    world = await createJourneyWorld();
    world.proof.decline(/^\/v1\/dev\/tasks$/u);
    await world.maya("POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Add a health endpoint", workflow: true, workflowPath: "QUICK" });
    expect(() => world!.proof.assertAllCore()).toThrow(/the old handler answered, not the core: POST \/v1\/dev\/tasks/u);
  }, 60_000);

  it("the FULL path: requirements, design and the implementation plan each wait for the owner's approval on the decision card, then the same road to a draft pull request", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world, { path: "FULL" });
    const { approvals } = await planFullToImplement(world, taskId);
    expect(approvals).toEqual(["REQUIREMENTS", "DESIGN", "IMPLEMENTATION_PLAN"]);
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ path: "FULL", stage: "IMPLEMENT" });
    const pullRequest = await buildUntilPullRequest(world, taskId);
    expect(pullRequest.draft).toMatchObject({ draft: true, state: "open" });
    world.proof.assertAllCore();
  }, 180_000);

  it("merge under the DEFAULT rules (self-approval off), the requester linked the way Connect GitHub links them: her own approval, an unlinked reviewer's and a linked colleague's count differently", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await planUntilCard(world, taskId);
    await world.approvePlan(taskId);
    const pullRequest = await buildUntilPullRequest(world, taskId);
    const maya = await world.linkGithubAsConnected(MAYA, "maya-gh");
    const model = world.harness.world.host.model;
    await hostReady(world, pullRequest, { approve: false });
    const mergeView = async () => (await world!.maya("GET", `/v1/app/tasks/${taskId}/merge`)).body as { mayMerge: boolean; ready: boolean; message: string; heads: unknown; risk: string };
    const waiting = (view: { mayMerge: boolean; ready: boolean; message: string }) => ({ mayMerge: view.mayMerge, ready: view.ready, message: view.message });
    expect(waiting(await mergeView()), "no approval yet").toMatchObject({ mayMerge: true, ready: false });
    // The requester's own approval does not count with self-approval off. Since 27c she is named as the requester (no more "Link your GitHub account" for an ordinary linked requester: HOSTED-MERGE-CHECK.md's gap is closed).
    model.addReview(pullRequest.draft.id, { login: maya.login, state: "APPROVED", revision: pullRequest.commit });
    await world.runJobs(120);
    const own = await mergeView();
    expect(waiting(own), "her own approval").toMatchObject({ mayMerge: true, ready: false });
    expect(own.message).not.toContain("Link your GitHub account");
    // A reviewer with write access whose account is linked to no member does not count either (27d, f0fd5280d: only a current member's approval counts, in both modes).
    model.setAccount("outsider", "write");
    model.addReview(pullRequest.draft.id, { login: "outsider", state: "APPROVED", revision: pullRequest.commit });
    await world.runJobs(120);
    expect(waiting(await mergeView()), "an unlinked reviewer").toMatchObject({ mayMerge: true, ready: false });
    // A colleague who is a current member and linked her account: her approval counts, and the owner's press merges.
    const priya = await world.linkColleagueGithub("priya");
    model.addReview(pullRequest.draft.id, { login: priya.login, state: "APPROVED", revision: pullRequest.commit });
    await world.runJobs(120);
    const ready = await mergeView();
    expect(waiting(ready), "a linked colleague's approval").toMatchObject({ mayMerge: true, ready: true });
    const pressed = await world.maya("POST", `/v1/app/tasks/${taskId}/merge`, { requestId: randomUUID(), expectedHeads: ready.heads, risk: ready.risk });
    expect({ status: pressed.status, merged: pullRequest.draft.state }, JSON.stringify(pressed.body)).toEqual({ status: 200, merged: "merged" });
    world.proof.assertAllCore();
  }, 180_000);

  it("merge with self-approval ON (the project's saved rule): the requester's own approval counts when she is a linked current member; an unlinked reviewer's still counts for nothing", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await planUntilCard(world, taskId);
    await world.approvePlan(taskId);
    const pullRequest = await buildUntilPullRequest(world, taskId);
    world.saveMergeRules("payments", { allowSelfApproval: true });
    const maya = await world.linkGithubAsConnected(MAYA, "maya-gh");
    const model = world.harness.world.host.model;
    await hostReady(world, pullRequest, { approve: false });
    model.setAccount("outsider", "write");
    model.addReview(pullRequest.draft.id, { login: "outsider", state: "APPROVED", revision: pullRequest.commit });
    await world.runJobs(120);
    const unlinked = (await world.maya("GET", `/v1/app/tasks/${taskId}/merge`)).body as { mayMerge: boolean; ready: boolean };
    expect(unlinked, "an unlinked reviewer's approval (27d: members only, in both modes)").toMatchObject({ mayMerge: true, ready: false });
    model.addReview(pullRequest.draft.id, { login: maya.login, state: "APPROVED", revision: pullRequest.commit });
    await world.runJobs(120);
    const own = (await world.maya("GET", `/v1/app/tasks/${taskId}/merge`)).body as { mayMerge: boolean; ready: boolean };
    expect(own, "her own approval, self-approval on").toMatchObject({ mayMerge: true, ready: true });
    world.proof.assertAllCore();
  }, 180_000);

  it("journey 5 (web): the owner stops a running step; another company's member and a repeat change nothing", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await world.prepare(taskId);
    // The step is really running on the worker: its model call is waiting.
    let began!: () => void;
    const modelBegan = new Promise<void>((resolve) => { began = resolve; });
    const running = await world.startStep("UNDERSTAND", [(_context: unknown, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => { began(); options?.signal?.addEventListener("abort", () => { reject(new Error("aborted")); }); })]);
    await modelBegan;
    const before = (await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string };
    expect(before.status, "the step is running").toBe("RUNNING");
    // Another company's member is told what a missing task is told, and nothing is stopped.
    const stranger = await world.omar("POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
    const missingId = randomUUID();
    const missing = await world.omar("POST", `/v1/dev/tasks/${missingId}/cancel`, { requestId: randomUUID() });
    const unnamed = (reply: { status: number; body: unknown }, id: string) => ({ status: reply.status, body: { ...(JSON.parse(JSON.stringify(reply.body).replaceAll(id, "<task>")) as Record<string, unknown>), requestId: undefined } });
    expect(unnamed(stranger, taskId)).toEqual(unnamed(missing, missingId));
    expect((await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task, "still running after the stranger's press").toMatchObject({ status: "RUNNING" });
    // A colleague in the owner's own company, with the project grant but not the task's owner, cannot stop it either.
    const colleague = await world.proof.probe(() => world!.priya("POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() }));
    const colleagueMissing = await world.proof.probe(() => world!.priya("POST", `/v1/dev/tasks/${missingId}/cancel`, { requestId: randomUUID() }));
    expect(unnamed(colleague, taskId), "told what a missing task is told").toEqual(unnamed(colleagueMissing, missingId));
    expect(colleague.status).toBe(404);
    expect((await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task, "still running after the colleague's press").toMatchObject({ status: "RUNNING" });
    const requestId = randomUUID();
    const pumping = world.pumpDispatcher();
    const stopped = await world.maya("POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId }).finally(pumping);
    const ended = await world.stepEnd("UNDERSTAND", running);
    expect(ended.operation.status, "the worker's step ended cancelled").toBe("CANCELLED");
    expect(stopped.status, JSON.stringify(stopped.body).slice(0, 400)).toBe(200);
    const after = (await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string; workflow: { state: string; blockReason?: string } };
    expect({ status: after.status, state: after.workflow.state, reason: after.workflow.blockReason }, "after the owner's stop").toEqual({ status: "CANCELLED", state: "BLOCKED", reason: "You stopped this step. Retry to run it again." });
    // The same request again stops nothing more and answers the task as it is.
    const repeated = await world.maya("POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId });
    expect(repeated.status).toBe(200);
    expect((await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task, "after the repeat").toMatchObject({ status: "CANCELLED" });
    world.proof.assertAllCore();
  }, 120_000);

  // G1 (grant exchange binding): what a Stop buys. The worker's repository grant lives 15 minutes; the owner's Stop ends what it may do at once.
  const grantOf = (invocation: { payload: Record<string, unknown> }): string => String(invocation.payload["repositoryGrant"]);
  const expectRefusedWithTheGrantsId = (w: JourneyWorld, refusals: Array<{ status: number; body: Record<string, unknown>; id: string }>, accesses: Array<"clone" | "push">) => {
    for (const refused of refusals) expect({ status: refused.status, code: (refused.body.error as { code: string }).code }, "refused with the stable code").toEqual({ status: 403, code: "FORBIDDEN" });
    const lines = w.coreLogs.filter((line) => line["event"] === "repository.credential_refused");
    expect(lines.map((line) => [line["kind"], line["grantId"], line["reason"] === "stopping" || line["reason"] === "ended"]), "one refusal line per attempt, naming the grant").toEqual(accesses.map((access) => [access, refusals[0]!.id, true]));
    const everything = JSON.stringify(w.coreLogs);
    expect(everything, "no credential in any line").not.toContain("synthetic-local-host-token");
  };

  it("journey 5 (Git exchange, push): after the owner's Stop, the pushing worker's grant buys no push credential; the refusal is logged with the grant's id", async () => {
    world = await createJourneyWorld();
    const w = world;
    // A pull request is open, a teammate's comment is approved as a fix, and the core asks the machine to push it (the maintain step): the worker holds a push grant.
    const { taskId, pullRequest } = await openPullRequest(w);
    w.harness.world.host.model.addDiscussionComment(pullRequest.draft.id, "priya", "Please trim the name.");
    const card = await reviewRound(w, taskId);
    expect((await decide(w, taskId, card, "APPROVE")).status).toBe(200);
    const push = await fixUntilPush(w, "mv repo/demo/health.txt repo/demo/status.txt");
    const { workspaceId } = w.taskRow(taskId)!;
    const grant = grantOf(push.invocation);
    const before = await w.exchangeGrant(workspaceId, push.invocation.operationId, grant, "push");
    expect({ status: before.status, credential: Boolean(before.body.credential) }, "live: given").toEqual({ status: 200, credential: true });
    const pumping = w.pumpDispatcher();
    // TODO(STOP-DURING-PUBLISH, the lane that is being built): when it lands, send this press as an ordinary one (drop `proof.probe`), assert it answers 200 and the operation CANCELLED, and delete the FINDING below.
    // The press is a probe because of the finding below: the core's answer to it is a 400, which the real-core proof would call the old handler's.
    const stopped = await w.proof.probe(() => w.maya("POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() })).finally(pumping);
    // FINDING (not this lane's): today the press on a running push is answered 400 CONFIG_INVALID "pull request stage must be ready" (the workflow cannot take the "You stopped this step" block at that stage), after the
    // operation was already asked to stop. What this journey holds is the safety property: whatever the answer, the operation is no longer live, and its grant buys nothing.
    expect(["CANCEL_REQUESTED", "CANCELLED"], `the press was answered ${String(stopped.status)}`).toContain(String(w.harness.db.find((row) => row.entityType === "OPERATION" && row.id === push.invocation.operationId)[0]!.status));
    const after = await w.exchangeGrant(workspaceId, push.invocation.operationId, grant, "push");
    expectRefusedWithTheGrantsId(w, [after], ["push"]);
    w.proof.assertAllCore();
  }, 240_000);

  it("journey 5 (Git exchange, clone): after the owner's Stop, the preparing worker's grant buys no clone credential; the refusal is logged with the grant's id", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    const { workspaceId } = world.taskRow(taskId)!;
    // The preparation is issued to a machine and is running when the owner presses Stop.
    const preparing = await world.holdPrepare(taskId);
    const grant = grantOf(preparing.invocation);
    const before = await world.exchangeGrant(workspaceId, preparing.invocation.operationId, grant, "clone");
    expect({ status: before.status, credential: Boolean(before.body.credential) }, "live: given").toEqual({ status: 200, credential: true });
    const pumping = world.pumpDispatcher();
    const stopped = await world.maya("POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() }).finally(pumping);
    expect(stopped.status, JSON.stringify(stopped.body).slice(0, 300)).toBe(200);
    const after = await world.exchangeGrant(workspaceId, preparing.invocation.operationId, grant, "clone");
    expectRefusedWithTheGrantsId(world, [after], ["clone"]);
    world.proof.assertAllCore();
  }, 120_000);

  it("journey 9: another company's member cannot read, answer, approve, stop, merge or close this company's task, and is told what a missing task is told", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await planUntilCard(world, taskId);
    const listed = await world.maya("GET", "/v1/app/decisions");
    // The owner's own view first: the plan waits for them.
    const card = (listed.body.cards as Array<{ id: string; taskId?: string }>).find((item) => item.taskId === taskId);
    expect(card, "the owner sees the plan card").toBeDefined();
    const cardPath = card!.id.replace(":", "/");
    const otherCardPath = cardPath.replace(taskId, randomUUID());
    const digest = (listed.body.digests as Record<string, string>)[card!.id]!;
    const missingId = randomUUID();
    const unnamed = (reply: { status: number; body: unknown }, id: string) => ({ status: reply.status, body: { ...(JSON.parse(JSON.stringify(reply.body).replaceAll(id, "<task>")) as Record<string, unknown>), requestId: undefined } });
    const probes: Array<[string, string, (id: string) => string, unknown]> = [
      ["read", "GET", (id) => `/v1/dev/tasks/${id}`, undefined],
      ["the plan", "GET", (id) => `/v1/dev/tasks/${id}/plan`, undefined],
      ["stop", "POST", (id) => `/v1/dev/tasks/${id}/cancel`, { requestId: randomUUID() }],
      ["answer", "POST", (id) => `/v1/dev/tasks/${id}/answers`, { requestId: randomUUID(), round: 1, answers: [{ question: "q1", pick: "a" }] }],
      ["close", "POST", (id) => `/v1/dev/tasks/${id}/close`, { requestId: randomUUID() }],
      ["merge view", "GET", (id) => `/v1/app/tasks/${id}/merge`, undefined],
    ];
    for (const [label, method, path, body] of probes) {
      const theirs = await world.omar(method, path(taskId), body);
      const missing = await world.omar(method, path(missingId), body);
      expect({ label, ...unnamed(theirs, taskId) }, `${label}: another company is told what a missing task is told`).toEqual({ label, ...unnamed(missing, missingId) });
    }
    // Their decision list never shows it, and a press on its card is refused as a missing card is.
    const theirList = await world.omarAsk("GET", "/v1/app/decisions");
    expect(JSON.stringify(theirList.body), "the other company's list").not.toContain(taskId);
    const press = await world.omar("POST", `/v1/app/decisions/${cardPath}/approve`, { shownDigest: digest, requestId: randomUUID() });
    const missingPress = await world.omar("POST", `/v1/app/decisions/${otherCardPath}/approve`, { shownDigest: digest, requestId: randomUUID() });
    expect(unnamed(press, taskId)).toEqual(unnamed(missingPress, otherCardPath.split("/")[1]!));
    // Nothing changed for the owner: the plan still waits, and the owner's own approval works.
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    await world.approvePlan(taskId);
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "IMPLEMENT" });
    world.proof.assertAllCore();
  }, 120_000);
});
