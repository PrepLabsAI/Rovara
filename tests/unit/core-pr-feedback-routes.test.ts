import { expect, it, vi } from "vitest";
import { createDeveloperTaskBroker, MAYA, bearerFor } from "../support/developer-task-broker.js";

it.each([
  ["GET", "feedback"], ["POST", "feedback-decision"], ["POST", "feedback-retry"], ["POST", "keep-pull-requests"],
])("a retired-engine %s %s request answers exactly as missing, with no feedback side effect", async (method, route) => {
  const w = await createDeveloperTaskBroker();
  const taskId = "99999999-9999-4999-8999-999999999999";
  const path = `/v1/dev/tasks/${taskId}/workflow/${route}`;
  const authorization = await bearerFor(MAYA);
  const send = async () => {
    const response = await w.handler({ version: "2.0", rawPath: path, rawQueryString: "", headers: { authorization }, body: "{}",
      requestContext: { requestId: "pr-feedback-retired-comparison", http: { method } } });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const missing = await send();
  w.db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, developerId: MAYA.developerId,
    ownerKey: MAYA.developerId, companyId: "org_00000000000000000000", project: "payments", workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" } });
  const before = w.db.find(() => true);
  const retired = await send();
  expect(retired).toEqual(missing);
  expect(retired.status).toBe(404);
  expect(w.db.find(item => item.entityType === "WORKFLOW_DISPATCH" || item.entityType === "OPERATION" || item.entityType === "NOTIFICATION")).toEqual([]);
  expect(w.db.find(() => true)).toEqual(before);
});


import { createOwnerRoutes } from "../../packages/broker/src/local/app/routes.js";
import { reviewedFeedbackWorld } from "../support/pr-feedback-world.js";
import { dispatchRowKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { blockWorkflow, WORKFLOW_BLOCK_REASONS, WORKFLOW_KEEP_PULL_REQUESTS_NOTE } from "@agentx/contracts";
import { decidePrFeedback } from "../../packages/broker/src/core/pr-feedback/decide.js";

it.each(["feedback-decision", "feedback-retry", "keep-pull-requests"])("mounted local %s accepts the documented request with one workflow commit", async route => {
  const w = await reviewedFeedbackWorld(route === "feedback-retry" ? "BLOCKED" : "COMPLETE");
  if (route === "keep-pull-requests") {
    w.task.workflow!.feedbackReview!.status = "COLLECTING";
    delete w.task.workflow!.feedbackReview!.reviewRef;
    await w.h.store.put({ item: toDocument(w.task) });
  }
  const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
  const body = route === "feedback-decision" ? { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE }
    : route === "feedback-retry" ? { reviewDigest: w.request.reviewDigest } : { requestId: w.request.requestId, expectedRevision: w.task.workflow!.revision };
  const transact = vi.spyOn(w.h.store, "transact");
  const send = () => routes({ method: "POST", path: `/v1/dev/tasks/${w.task.taskId}/workflow/${route}`, headers: {}, body: JSON.stringify(body) }, w.h.owner);
  const answer = await send();
  expect(answer?.statusCode).toBe(200);
  const response = JSON.parse(answer!.body) as { task: { taskId: string }; started?: boolean };
  expect(Object.keys(response).sort()).toEqual(route === "feedback-retry" ? ["started", "task"] : ["task"]);
  expect(response.task.taskId).toBe(w.task.taskId);
  if (route === "feedback-retry") expect(response.started).toBe(true);
  expect(transact.mock.calls.filter(([items]) => items.some(item => item.kind === "update" && item.key.pk === w.task.pk && item.key.sk === "META"))).toHaveLength(1);
  const revision = (await readTask(w.h.deps, w.task.taskId))!.workflow!.revision;
  const repeated = await send();
  expect(repeated?.statusCode).toBe(200);
  if (route === "feedback-retry") expect(JSON.parse(repeated!.body) as unknown).toMatchObject({ started: false });
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.revision).toBe(revision);
});

it.each(["feedback-decision", "feedback-retry", "keep-pull-requests"])("mounted local %s refuses wrong owner, stale and retired with zero writes", async route => {
  for (const kind of ["wrong-owner", "stale", "retired"] as const) {
    const w = await reviewedFeedbackWorld(route === "feedback-retry" ? "BLOCKED" : "COMPLETE");
    if (kind === "wrong-owner") w.h.deps.access.ownerActing = async () => undefined;
    if (kind === "retired") await w.h.store.delete({ key: engineStampKey(w.task.taskId) });
    const body = route === "feedback-decision" ? { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE, expectedRevision: w.request.expectedRevision - (kind === "stale" ? 1 : 0) }
      : route === "feedback-retry" ? { reviewDigest: kind === "stale" ? "0".repeat(64) : w.request.reviewDigest }
      : { requestId: w.request.requestId, expectedRevision: w.task.workflow!.revision - (kind === "stale" ? 1 : 0) };
    const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
    const transact = vi.spyOn(w.h.store, "transact"), put = vi.spyOn(w.h.store, "put"), update = vi.spyOn(w.h.store, "update");
    const response = await routes({ method: "POST", path: `/v1/dev/tasks/${w.task.taskId}/workflow/${route}`, headers: {}, body: JSON.stringify(body) }, w.h.owner);
    expect(response?.statusCode).toBeGreaterThanOrEqual(400);
    expect(transact).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  }
});


const feedbackActions = ["feedback-decision", "feedback-retry", "keep-pull-requests"] as const;
const refusalCases = ["reader", "non-member", "another-company", "revoked-co-owner", "script-token", "unknown-card", "stale-card", "cross-task-card"] as const;

// Only the task identity META may be read before live owner authorization passes.
it.each(feedbackActions.flatMap(route => refusalCases.map(kind => ({ route, kind }))))(
  "mounted $route refuses $kind with its exact body and no work or writes", async ({ route, kind }) => {
    const w = await reviewedFeedbackWorld(route === "feedback-retry" ? "BLOCKED" : "COMPLETE");
    const caller = structuredClone(w.h.owner);
    caller.principal.personId = "route-auth-member";
    caller.principal.roles = ["member"];
    const live = { member: true, role: "owner" as "owner" | "reader" | "removed" };
    // The caller identity is unchanged after revocation; the host's TaskAccess seam must be consulted anew.
    const actorId = "c".repeat(64);
    let beforeAuthPass: () => void = () => undefined;
    const ownerActing = vi.fn(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      beforeAuthPass();
      return live.member && live.role === "owner" ? { actorId, authority: { actorId, ownerIds: [actorId] } } : undefined;
    });
    w.h.deps.access.ownerActing = ownerActing;
    w.h.deps.access.canAct = async () => true; // Read/drive access alone must never authorize a decision.
    w.h.deps.access.canRead = async () => true;
    if (kind === "reader") live.role = "reader";
    if (kind === "non-member") live.member = false;
    if (kind === "another-company") caller.principal.companyId = "org_bbbbbbbbbbbbbbbbbbbb";
    if (kind === "script-token") caller.scriptToken = { tokenId: "route-script", name: "read-only", permissions: [], projects: [] };
    if (kind === "revoked-co-owner") {
      expect(await ownerActing()).toEqual({ actorId, authority: { actorId, ownerIds: [actorId] } });
      live.role = "removed";
    }
    ownerActing.mockClear();
    const body = route === "feedback-decision" ? { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE }
      : route === "feedback-retry" ? { reviewDigest: w.request.reviewDigest }
      : { requestId: w.request.requestId, expectedRevision: w.task.workflow!.revision };
    if (kind === "unknown-card") {
      if ("expectedRevision" in body) body.expectedRevision = 999_999;
      else body.reviewDigest = "0".repeat(64);
    }
    if (kind === "stale-card") {
      // The submitted card really existed: retain its revision/report while the task advances.
      if (route === "feedback-retry") {
        const oldRef = structuredClone(w.task.workflow!.feedbackReview!.reviewRef!);
        w.task.workflow!.feedbackReviewHistory = [oldRef];
        w.task.workflow!.feedbackReview!.reviewRef!.sha256 = "e".repeat(64);
        w.task.workflow!.feedbackReview!.reviewRef!.objectKey = oldRef.objectKey.replace(oldRef.sha256, "e".repeat(64));
      }
      w.task.workflow!.revision += 1;
      await w.h.store.put({ item: toDocument(w.task) });
    }
    if (kind === "cross-task-card") {
      // A valid foreign card's references must not be followed even when revision/actor match.
      const otherTaskId = "88888888-8888-4888-8888-888888888888";
      w.task.workflow!.feedbackReview!.reviewRef!.taskId = otherTaskId;
      for (const ref of w.task.workflow!.feedbackReview!.bundleRefs) ref.taskId = otherTaskId;
      await w.h.store.put({ item: toDocument(w.task) });
    }
    const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
    const reads = vi.spyOn(w.h.store, "get"), queries = vi.spyOn(w.h.store, "query"), many = vi.spyOn(w.h.store, "getMany");
    const writes = [vi.spyOn(w.h.store, "transact"), vi.spyOn(w.h.store, "put"), vi.spyOn(w.h.store, "update"), vi.spyOn(w.h.store, "delete"), w.put];
    const artifacts = vi.spyOn(w.h.deps.artifacts!, "get");
    const blobs = vi.spyOn(w.registry.require("object-storage"), "get");
    const projects = vi.spyOn(w.h.deps.projects, "revision");
    const paths: { mock: { calls: unknown[] } }[] = [vi.spyOn(w.h.deps.admission, "admit"), vi.spyOn(w.h.deps.machines, "start"), vi.spyOn(w.h.deps.machines, "deliver"),
      vi.spyOn(w.h.deps.queues, "queue"), vi.spyOn(w.h.deps.access, "checkStep")];
    const cap = vi.fn(async () => 10), spend = vi.fn(async () => 0);
    w.h.deps.taskCapUsd = cap;
    w.h.deps.taskSpendUsd = spend;
    paths.push(cap, spend);
    w.put.mockClear();
    w.read.mockClear();
    beforeAuthPass = () => {
      expect(reads.mock.calls).toEqual([[{ pk: w.task.pk, sk: "META" }]]);
      for (const read of [queries, many, artifacts, blobs, projects, ...w.reads.values()]) expect(read).not.toHaveBeenCalled();
      for (const effect of [...writes, ...paths]) expect(effect).not.toHaveBeenCalled();
    };
    const response = await routes({ method: "POST", path: `/v1/dev/tasks/${w.task.taskId}/workflow/${route}`, headers: {}, body: JSON.stringify(body) }, caller);
    const bindingRefusal = kind === "unknown-card" || kind === "stale-card" || kind === "cross-task-card";
    const expected = !bindingRefusal ? { status: 404, code: "TASK_NOT_FOUND", message: "no such task" }
      : kind === "cross-task-card" ? { status: 400, code: "CONFIG_INVALID", message: "workflow snapshot is invalid" }
      : route === "keep-pull-requests" ? { status: 409, code: "IDEMPOTENCY_CONFLICT", message: "The feedback card changed. Refresh the task." }
      : { status: 400, code: "CONFIG_INVALID", message: route === "feedback-decision"
        ? "feedback finding decision is stale, incomplete or already used" : "this PR feedback review is not a failed review waiting for a retry" };
    expect(response?.statusCode).toBe(expected.status);
    expect(JSON.parse(response!.body) as unknown).toEqual({ error: { code: expected.code, message: expected.message } });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    for (const path of paths) expect(path).not.toHaveBeenCalled();
    if (!bindingRefusal) {
      expect(artifacts).not.toHaveBeenCalled();
      expect(blobs).not.toHaveBeenCalled();
      expect(projects).not.toHaveBeenCalled();
      expect(w.read).not.toHaveBeenCalled();
      expect(queries).not.toHaveBeenCalled();
      expect(many).not.toHaveBeenCalled();
      // The authorized META exception does not permit any second task or referenced record.
      expect(reads.mock.calls.map(([key]) => key)).toEqual([{ pk: w.task.pk, sk: "META" }]);
    }
    if (kind === "another-company" || kind === "script-token") {
      expect(ownerActing).not.toHaveBeenCalled();
    } else {
      expect(ownerActing).toHaveBeenCalledTimes(1);
      const authOrder = ownerActing.mock.invocationCallOrder[0]!;
      const beforeAuth = reads.mock.calls.filter((_, index) => reads.mock.invocationCallOrder[index]! < authOrder);
      expect(beforeAuth).toEqual([[{ pk: w.task.pk, sk: "META" }]]);
      for (const read of [queries, many, artifacts, blobs, projects, ...w.reads.values()]) {
        for (const order of read.mock.invocationCallOrder) expect(order).toBeGreaterThan(authOrder);
      }
    }
  });


it.each(feedbackActions)("mounted %s rechecks revoked ownership before the final commit", async route => {
  const w = await reviewedFeedbackWorld(route === "feedback-retry" ? "BLOCKED" : "COMPLETE");
  let task = w.task;
  if (route === "keep-pull-requests") {
    await decidePrFeedback(w.h.deps, w.h.owner, task.taskId, w.request);
    task = (await readTask(w.h.deps, task.taskId))!;
    task.workflow = blockWorkflow(task.workflow, WORKFLOW_BLOCK_REASONS.fixChangedNothing, new Date(w.clock.ms).toISOString());
    await w.h.store.put({ item: toDocument(task) });
  }
  const ownerActing = vi.fn<NonNullable<typeof w.h.deps.access.ownerActing>>();
  ownerActing.mockResolvedValueOnce({ actorId: task.ownerKey }).mockResolvedValue(undefined);
  w.h.deps.access.ownerActing = ownerActing;
  const body = route === "feedback-decision" ? { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE }
    : route === "feedback-retry" ? { reviewDigest: w.request.reviewDigest }
    : { requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: task.workflow!.revision };
  const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
  const writes = [vi.spyOn(w.h.store, "transact"), vi.spyOn(w.h.store, "put"), vi.spyOn(w.h.store, "update"), vi.spyOn(w.h.store, "delete"), w.put];
  const start = vi.spyOn(w.h.deps.machines, "start"), queue = vi.spyOn(w.h.deps.queues, "queue");
  w.put.mockClear();
  const response = await routes({ method: "POST", path: `/v1/dev/tasks/${task.taskId}/workflow/${route}`, headers: {}, body: JSON.stringify(body) }, w.h.owner);
  expect(response?.statusCode).toBe(404);
  expect(JSON.parse(response!.body) as unknown).toEqual({ error: { code: "TASK_NOT_FOUND", message: "no such task" } });
  expect(ownerActing).toHaveBeenCalledTimes(2);
  for (const write of writes) expect(write).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled(); expect(queue).not.toHaveBeenCalled();
});

it("mounted feedback-retry rechecks revoked ownership before reading a failed commit's replay", async () => {
  const w = await reviewedFeedbackWorld("BLOCKED");
  const ownerActing = vi.fn<NonNullable<typeof w.h.deps.access.ownerActing>>();
  ownerActing.mockResolvedValueOnce({ actorId: w.task.ownerKey }).mockResolvedValueOnce({ actorId: w.task.ownerKey }).mockResolvedValue(undefined);
  w.h.deps.access.ownerActing = ownerActing;
  const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
  const transact = vi.spyOn(w.h.store, "transact").mockResolvedValue({ applied: false, reason: "condition_failed", failed: [0] });
  const writes = [vi.spyOn(w.h.store, "put"), vi.spyOn(w.h.store, "update"), vi.spyOn(w.h.store, "delete"), w.put];
  w.put.mockClear();
  const response = await routes({ method: "POST", path: `/v1/dev/tasks/${w.task.taskId}/workflow/feedback-retry`, headers: {}, body: JSON.stringify({ reviewDigest: w.request.reviewDigest }) }, w.h.owner);
  expect(response?.statusCode).toBe(404);
  expect(JSON.parse(response!.body) as unknown).toEqual({ error: { code: "TASK_NOT_FOUND", message: "no such task" } });
  expect(ownerActing).toHaveBeenCalledTimes(3);
  expect(transact).toHaveBeenCalledTimes(1);
  for (const write of writes) expect(write).not.toHaveBeenCalled();
});


it("mounted feedback routes reject malformed JSON and leave other methods and paths untouched", async () => {
  const w = await reviewedFeedbackWorld();
  const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
  const path = `/v1/dev/tasks/${w.task.taskId}/workflow/feedback-decision`;
  const transact = vi.spyOn(w.h.store, "transact");
  const invalid = await routes({ method: "POST", path, headers: {}, body: "{" }, w.h.owner);
  expect(invalid?.statusCode).toBe(400);
  expect(JSON.parse(invalid!.body) as unknown).toEqual({ error: { code: "CONFIG_INVALID", message: "the request body is not JSON" } });
  expect(await routes({ method: "DELETE", path, headers: {}, body: "{}" }, w.h.owner)).toBeUndefined();
  expect(await routes({ method: "POST", path: path + "/unknown", headers: {}, body: "{}" }, w.h.owner)).toBeUndefined();
  expect(transact).not.toHaveBeenCalled();
});


it("mounted failed review Keep accepts the documented DISMISS body with a missing report blob", async () => {
  const w = await reviewedFeedbackWorld("BLOCKED");
  w.objects.delete(w.task.workflow!.feedbackReview!.reviewRef!.objectKey);
  const actorId = "c".repeat(64);
  w.h.deps.access.ownerActing = async () => ({ actorId, authority: { actorId, ownerIds: [actorId] } });
  const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
  const body = { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE };
  const admit = vi.spyOn(w.h.deps.admission, "admit");
  const response = await routes({ method: "POST", path: `/v1/dev/tasks/${w.task.taskId}/workflow/feedback-decision`, headers: {}, body: JSON.stringify(body) }, w.h.owner);
  expect(response?.statusCode).toBe(200);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  expect(task.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "DISMISSED" } });
  expect(task.workflow!.feedbackDecisions!.at(-1)).toMatchObject({ actorId, decision: "DISMISS" });
  expect(admit).not.toHaveBeenCalled();
});


it.each(["", "?source=tool"])("a plain machine bearer cannot APPROVE feedback%s or start paid work", async suffix => {
  const w = await reviewedFeedbackWorld();
  const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
  const before = await readTask(w.h.deps, w.task.taskId);
  const operations = await workspaceOperations(w.h.deps, w.task.workspaceId);
  const writes = [vi.spyOn(w.h.store, "transact"), vi.spyOn(w.h.store, "put"), vi.spyOn(w.h.store, "update"), vi.spyOn(w.h.store, "delete"), w.put];
  const work = [vi.spyOn(w.h.deps.admission, "admit"), vi.spyOn(w.h.deps.machines, "start"), vi.spyOn(w.h.deps.machines, "deliver"), vi.spyOn(w.h.deps.queues, "queue")];
  w.put.mockClear();
  const send = (action: string) => routes({ method: "POST", path: `/v1/dev/tasks/${w.task.taskId}/workflow/${action}${suffix}`, headers: {}, body: JSON.stringify(w.request) }, w.h.owner);
  const response = await send("feedback-decision");
  expect(response?.statusCode).toBe(403);
  expect(JSON.parse(response!.body) as unknown).toEqual({ error: { code: "FORBIDDEN", message: "A plan is approved on its local review page, by you. Run `rovara open <task>` to open it; an assistant cannot approve for you." } });
  expect(response).toEqual(await send("decision"));
  for (const effect of [...writes, ...work]) expect(effect).not.toHaveBeenCalled();
  expect(await readTask(w.h.deps, w.task.taskId)).toEqual(before);
  expect(await workspaceOperations(w.h.deps, w.task.workspaceId)).toEqual(operations);
  expect(await w.h.store.get(dispatchRowKey(w.h.deps.companyId, w.task.taskId, w.task.workflow!.revision + 1))).toBeUndefined();
});

it("mounted feedback-retry only queues review and starts no paid run", async () => {
  const w = await reviewedFeedbackWorld("BLOCKED");
  const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
  const before = await workspaceOperations(w.h.deps, w.task.workspaceId);
  const work = [vi.spyOn(w.h.deps.machines, "start"), vi.spyOn(w.h.deps.machines, "deliver"), vi.spyOn(w.h.deps.queues, "queue")];
  const response = await routes({ method: "POST", path: `/v1/dev/tasks/${w.task.taskId}/workflow/feedback-retry`, headers: {}, body: JSON.stringify({ reviewDigest: w.request.reviewDigest }) }, w.h.owner);
  expect(response?.statusCode).toBe(200);
  expect(JSON.parse(response!.body) as unknown).toMatchObject({ started: true });
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  expect(task.workflow!.feedbackReview).toMatchObject({ status: "COLLECTING" });
  expect(task.workflow!.feedbackDecisions).toEqual(w.task.workflow!.feedbackDecisions);
  expect(task.workflow!.fixSource).toBe(w.task.workflow!.fixSource);
  expect(task.charge).toEqual(w.task.charge);
  expect(await w.h.store.get(dispatchRowKey(w.h.deps.companyId, w.task.taskId, task.workflow!.revision))).toMatchObject({ kind: "REVIEW" });
  expect(await workspaceOperations(w.h.deps, w.task.workspaceId)).toEqual(before);
  for (const effect of work) expect(effect).not.toHaveBeenCalled();
});


it.each(["missing", "another-company", "cannot-act"])("feedback approval keeps the plan refusal's %s task boundary", async kind => {
  const w = await reviewedFeedbackWorld();
  const caller = structuredClone(w.h.owner);
  if (kind === "another-company") caller.principal.companyId = "org_bbbbbbbbbbbbbbbbbbbb";
  if (kind === "cannot-act") w.h.deps.access.canAct = async () => false;
  const taskId = kind === "missing" ? "99999999-9999-4999-8999-999999999999" : w.task.taskId;
  const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
  const transact = vi.spyOn(w.h.store, "transact"), admit = vi.spyOn(w.h.deps.admission, "admit");
  const response = await routes({ method: "POST", path: `/v1/dev/tasks/${taskId}/workflow/feedback-decision`, headers: {}, body: JSON.stringify(w.request) }, caller);
  expect(response?.statusCode).toBe(404);
  expect(JSON.parse(response!.body) as unknown).toEqual({ error: { code: "TASK_NOT_FOUND", message: "no such task" } });
  expect(transact).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
});

it.each(["APPROVE", "DISMISS"])("the existing plan %s refusal still requires the page", async decision => {
  const w = await reviewedFeedbackWorld();
  const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
  const response = await routes({ method: "POST", path: `/v1/dev/tasks/${w.task.taskId}/workflow/decision`, headers: {}, body: JSON.stringify({ ...w.request, decision }) }, w.h.owner);
  expect(response?.statusCode).toBe(403);
  expect(JSON.parse(response!.body) as unknown).toMatchObject({ error: { code: "FORBIDDEN", message: "A plan is approved on its local review page, by you. Run `rovara open <task>` to open it; an assistant cannot approve for you." } });
});

it.each([
  { method: "GET", action: "decision", status: 404, code: "NOT_FOUND", message: "route not found" },
  { method: "POST", action: "feedback-decision", status: 400, code: "CONFIG_INVALID", message: "the request body is not JSON" },
])("local $method $action preserves its refusal before any write", async ({ method, action, status, code, message }) => {
  const w = await reviewedFeedbackWorld();
  const routes = createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" });
  const effects = [vi.spyOn(w.h.store, "transact"), vi.spyOn(w.h.store, "put"), vi.spyOn(w.h.store, "update"), vi.spyOn(w.h.store, "delete"), vi.spyOn(w.h.deps.admission, "admit")];
  const response = await routes({ method, path: `/v1/dev/tasks/${w.task.taskId}/workflow/${action}`, headers: {}, body: "{" }, w.h.owner);
  expect(response?.statusCode).toBe(status);
  expect(JSON.parse(response!.body) as unknown).toEqual({ error: { code, message } });
  for (const effect of effects) expect(effect).not.toHaveBeenCalled();
});
