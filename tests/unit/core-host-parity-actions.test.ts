import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WorkflowSnapshotSchema, when, agentXError } from "@agentx/contracts";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { definition } from "../support/task-flow-harness.js";
import { routeParityTask } from "../../packages/broker/src/core-host/parity-task-routes.js";
import { runParityTaskAction } from "../../packages/broker/src/core-host/parity-task-actions.js";
import { blockedReview, code, operationsOf, report, seed, stateOf, taskOf, TASK_ID } from "../support/task-actions-world.js";

const body = () => ({ requestId: randomUUID(), instructions: "Retry the checked code", expectedRevision: 6, candidateDigest: code.digest });

describe("the ported core developer actions", () => {
  it("retries a blocked review of the checked candidate", async () => {
    const { h, caller } = await seed();
    const request = body();
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", request);
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", request);
    expect((await taskOf(h)).workflow).toMatchObject({ stage: "REVIEW", state: "RUNNING", revision: 7 });
    const operations = await operationsOf(h);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ requestId: request.requestId, workflowMode: "REVIEW" });
    expect(operations[0]?.dispatch.payload).toMatchObject({ workflowReviewNote: request.instructions });
  });

  it.each([{ expectedRevision: 5 }, { candidateDigest: "f".repeat(64) }])("refuses a stale review fence without writes: %j", async (changed) => {
    const { h, caller } = await seed();
    const before = await stateOf(h);
    await expect(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", { ...body(), ...changed })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await stateOf(h)).toEqual(before);
  });

  it("retains the live People fence in the review's acceptance transaction", async () => {
    const { h, caller } = await seed();
    h.deps.access.ownerActing = async () => ({ actorId: (await taskOf(h)).ownerKey, items: [{ kind: "check", key: { pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE" }, condition: when.eq("revision", 9) }] });
    const before = await stateOf(h);
    await expect(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", body())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await stateOf(h)).toEqual(before);
  });

  it("starts no paid review when the hosted spend cannot be read", async () => {
    const { h, caller } = await seed();
    const before = await stateOf(h);
    await expect(runParityTaskAction(h.deps, { roundCap: async () => ({ limitUsd: 10, spentUsd: undefined }) }, caller, TASK_ID, "workflow/retry", body())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await stateOf(h)).toEqual(before);
  });

  it("commits the owner's approved check selection with a verification retry", async () => {
    const base = blockedReview();
    const workflow = WorkflowSnapshotSchema.parse({ ...base, stage: "VERIFY", checkPolicy: { ...base.checkPolicy, optional: [{ ...base.checkPolicy!.required[0], id: "optional" }] } });
    const { h, caller } = await seed({ workflow });
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", { ...body(), selectedOptionalCheckIds: ["optional"] });
    expect((await taskOf(h)).workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING", checkPolicy: { selectedOptionalIds: ["optional"] } });
    expect(await operationsOf(h)).toEqual([expect.objectContaining({ workflowMode: "CHECKS" })]);
  });

  it("lets the owner recheck a candidate ready to publish without opening a PR", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "PULL_REQUEST", state: "READY", blockReason: undefined, reviews: [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])] }) });
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", body());
    expect((await taskOf(h)).workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
    expect(await operationsOf(h)).toEqual([expect.objectContaining({ workflowMode: "CHECKS" })]);
  });

  it("refuses verification with no selected check before spending or writing", async () => {
    const workflow = blockedReview({ stage: "VERIFY", checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [] } });
    const { h, caller } = await seed({ workflow });
    const before = await stateOf(h);
    await expect(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", body())).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await stateOf(h)).toEqual(before);
  });

  it("retries a blocked planning step through the core dispatcher", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "PLAN", definitionVersion: "1.0.0", candidate: undefined, verification: undefined, reviews: undefined }) });
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/retry", body());
    expect((await taskOf(h)).workflow).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    expect(await operationsOf(h)).toEqual([expect.objectContaining({ workflowMode: "PLAN" })]);
  });

  it("retries publication only at the revision the owner saw", async () => {
    const workflow = blockedReview({ stage: "PULL_REQUEST", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, reviews: [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])] });
    const { h, caller } = await seed({ workflow });
    const registry = createAdapterRegistry();
    registry.register("code-host", "fake", new FakeCodeHost(new FakeHostModel({ url: definition.repositories[0]!.url, id: "1", fullName: "example/demo" })));
    h.deps.codeHosts = registry;
    await h.registerProject({ ...definition, repositories: [{ ...definition.repositories[0]!, host: { kind: "fake" } }] });
    const before = await stateOf(h);
    await expect(runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/publish-retry", { requestId: randomUUID(), expectedRevision: 5 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await stateOf(h)).toEqual(before);
    await runParityTaskAction(h.deps, {}, caller, TASK_ID, "workflow/publish-retry", { requestId: randomUUID(), expectedRevision: 6 });
    expect((await taskOf(h)).workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    expect(await operationsOf(h)).toEqual([expect.objectContaining({ kind: "publish" })]);
  });
  it("forwards D-CORE's preview and discard fields to the close flow without swallowing its stale refusal", async () => {
    const { h, caller } = await seed();
    h.deps.access.ownerActing = async () => ({ actorId: (await taskOf(h)).ownerKey });
    const request = { requestId: randomUUID(), expectedPreviewDigest: "a".repeat(64), discard_unpublished: true };
    let observed: unknown;
    const flow = { ...h.flow, close: async (_who: typeof caller, _id: string, input?: unknown): ReturnType<typeof h.flow.close> => { observed = input; throw agentXError("CHANGE_STALE", "the close preview has changed; review it again"); } };
    const before = await stateOf(h);
    await expect(routeParityTask({ flow, blobs: {} as never, wiring: { origin: () => "https://api.example" }, caller, decisionCaller: { principal: caller.principal, orgId: h.deps.companyId, developerId: "local-owner" }, view: async () => ({}), decide: async () => { throw new Error("not a read"); } }, { taskId: TASK_ID, action: "close" }, { method: "POST", path: `/v1/dev/tasks/${TASK_ID}/close`, headers: {}, body: JSON.stringify(request) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(observed).toEqual(request);
    expect(await stateOf(h)).toEqual(before);
  });

  it("reports a close still pending in the core flow as closed false", async () => {
    const { h, caller } = await seed();
    h.deps.access.ownerActing = async () => ({ actorId: (await taskOf(h)).ownerKey });
    const flow = { ...h.flow, close: async () => h.flow.get(caller, TASK_ID) };
    const reply = await routeParityTask({ flow, blobs: {} as never, wiring: { origin: () => "https://api.example" }, caller, decisionCaller: { principal: caller.principal, orgId: h.deps.companyId, developerId: "local-owner" }, view: async (task) => ({ taskId: task.taskId }), decide: async () => { throw new Error("not a read"); } }, { taskId: TASK_ID, action: "close" }, { method: "POST", path: `/v1/dev/tasks/${TASK_ID}/close`, headers: {}, body: JSON.stringify({ requestId: randomUUID() }) });
    expect(JSON.parse(reply!.body)).toMatchObject({ closed: false, task: { taskId: TASK_ID }, message: "Rovara is closing this task. Read it again in a moment." });
    expect((await taskOf(h)).closedAt).toBeUndefined();
  });

});

it("keeps local Code's approve-on-the-page refusal for tool tokens", async () => {
  const { createOwnerRoutes, APPROVE_ON_THE_PAGE } = await import("../../packages/broker/src/local/app/routes.js");
  const { h, caller } = await seed();
  const before = await stateOf(h);
  const route = createOwnerRoutes({ flow: h.flow, blobs: {} as never, openPage: async () => undefined, version: "test" });
  const reply = await route({ method: "POST", path: `/v1/dev/tasks/${TASK_ID}/workflow/decision`, headers: {}, body: JSON.stringify({ requestId: randomUUID(), decision: "APPROVE" }) }, caller);
  expect(reply?.statusCode).toBe(403);
  expect(JSON.parse(reply!.body)).toMatchObject({ error: { code: "FORBIDDEN", message: APPROVE_ON_THE_PAGE } });
  expect(await stateOf(h)).toEqual(before);
});
