import { expect, it } from "vitest";
import { change } from "@agentx/contracts";
import { feedbackWorld } from "../support/pr-feedback-world.js";
import { collectPrFeedback } from "../../packages/broker/src/core/pr-feedback/collect.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { createBuildSteps } from "../../packages/broker/src/core/build-step/index.js";
import { createCallbackHandler, CAPABILITY_HEADER } from "../../packages/broker/src/services/callbacks.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";

it("approved requirements cannot be read from another owner's artifact prefix", async () => {
  const { feedbackRequirements } = await import("../../packages/broker/src/core/pr-feedback/inputs.js");
  const w = await feedbackWorld();
  const plan = w.task.workflow!.artifacts.filter(a => a.type === "plan").at(-1)!;
  const bytes = w.objects.get(plan.objectKey)!;
  plan.objectKey = "private/another-owner/another-workspace/plan.md";
  w.objects.set(plan.objectKey, bytes);
  await expect(feedbackRequirements(w.h.deps, w.task)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});

async function world() {
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" });
  const operation = (await workspaceOperations(w.h.deps, task.workspaceId))[0]!;
  const handler = createCallbackHandler({ flow: w.h.deps, blobs: w.registry.require("object-storage"), grants: w.h.deps.repositoryGrants as never });
  const token = new CallbackCapabilities(Buffer.from(w.h.deps.callbackSigningKey)).issue({ workspaceId: operation.workspaceId, operationId: operation.id,
    fence: operation.fence, actions: ["feedback-bundles"], expiresInSeconds: 100 });
  const request = { method: "POST", path: `/v1/internal/workspaces/${operation.workspaceId}/operations/${operation.id}/feedback-bundles`,
    headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify(operation.workflowFeedbackReview) };
  return { ...w, task, operation, handler, request };
}

it("critic check inputs contain only the owner's selected proposed checks", async () => {
  const { toDocument } = await import("../../packages/broker/src/core/task-flow/records.js");
  const w = await world();
  const proposed = ["approved-check", "unselected-check"].map(id => ({ id, label: id,
    command: { cwd: "repo/app", executable: "npm", args: ["test"], timeoutSeconds: 60 } }));
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  task.workflow!.checkPolicy = { required: [], optional: [], selectedOptionalIds: [], proposed, selectedProposedIds: ["approved-check"] };
  await w.h.store.put({ item: toDocument(task) });
  const response = await w.handler(w.request);
  expect(response.statusCode).toBe(200);
  expect((JSON.parse(response.body) as { taskChecks: { proposed: Array<{ id: string }> } }).taskChecks.proposed.map(c => c.id)).toEqual(["approved-check"]);
});

it("serves the documented feedback-bundles binding and exact bytes to its critic", async () => {
  const w = await world();
  const response = await w.handler(w.request);
  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body) as { taskRequirements: string; bundles: Array<{ bytesBase64: string }> };
  expect(body.taskRequirements).toContain("Handle failures safely");
  expect(body.bundles).toHaveLength(1);
  const bundle = JSON.parse(Buffer.from(body.bundles[0]!.bytesBase64, "base64").toString("utf8")) as { comments: Array<{ body: string }> };
  expect(bundle.comments[0]!.body).toBe("Handle this failure.");
});

it("the existing result callback settles a valid critic report as a complete owner card", async () => {
  const { reviewedFeedbackWorld } = await import("../support/pr-feedback-world.js");
  const w = await reviewedFeedbackWorld("COMPLETE", undefined, async (world, operation, result) => {
    const handler = createCallbackHandler({ flow: world.h.deps, blobs: world.registry.require("object-storage"), grants: world.h.deps.repositoryGrants as never });
    const token = new CallbackCapabilities(Buffer.from(world.h.deps.callbackSigningKey)).issue({ workspaceId: operation.workspaceId,
      operationId: operation.id, fence: operation.fence, actions: ["result"], expiresInSeconds: 100 });
    const request = { method: "POST", path: `/v1/internal/workspaces/${operation.workspaceId}/operations/${operation.id}/result`,
      headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify({ status: "SUCCEEDED", result: { workflowFeedbackReviewResult: result } }) };
    const response = await handler(request);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as unknown).toEqual({ ok: true, duplicate: false });
    const revision = (await readTask(world.h.deps, world.task.taskId))!.workflow!.revision;
    const duplicate = await handler(request);
    expect(duplicate.statusCode).toBe(200);
    expect(JSON.parse(duplicate.body) as unknown).toEqual({ ok: true, duplicate: true });
    expect((await readTask(world.h.deps, world.task.taskId))!.workflow!.revision).toBe(revision);
  });
  expect(w.task.workflow!.feedbackReview).toMatchObject({ status: "PENDING", reviewRef: { status: "COMPLETE" } });
});

it("terminal usage alone is booked once and returned before any output handling", async () => {
  const { vi } = await import("vitest");
  const w = await world();
  await w.h.store.update({ key: w.operation, ops: [change.set("status", "SUCCEEDED")] });
  const book = vi.fn(async () => undefined);
  const handler = createCallbackHandler({ flow: w.h.deps, blobs: w.registry.require("object-storage"), grants: w.h.deps.repositoryGrants as never, bookUsage: book });
  const token = new CallbackCapabilities(Buffer.from(w.h.deps.callbackSigningKey)).issue({ workspaceId: w.operation.workspaceId,
    operationId: w.operation.id, fence: w.operation.fence, actions: ["events"], expiresInSeconds: 100 });
  const response = await handler({ ...w.request, path: w.request.path.replace("feedback-bundles", "events"), headers: { [CAPABILITY_HEADER]: token },
    body: JSON.stringify({ events: [{ type: "usage", timestamp: new Date(w.clock.ms).toISOString(), payload: {} }] }) });
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body) as unknown).toEqual({ accepted: 1 });
  expect(book).toHaveBeenCalledOnce();
});

it("non-review publication output retains its existing published result kind", async () => {
  const { readOutcome } = await import("../../packages/broker/src/services/callbacks.js");
  const w = await world();
  const operation = { ...w.operation, kind: "publish" as const };
  delete operation.workflowMode;
  const result = { published: true };
  await expect(readOutcome({ flow: w.h.deps, blobs: w.registry.require("object-storage"), grants: w.h.deps.repositoryGrants as never }, operation, result)).resolves.toEqual({ kind: "published", result });
});

it.each(["wrong-binding", "wrong-mode", "wrong-fence", "terminal", "foreign-company", "missing-bytes", "wrong-revision", "closed-task", "wrong-holder", "corrupt-bundle", "missing-stamp", "extra-field", "wrong-candidate", "wrong-feedback-state", "access-denied", "no-artifact-port"])("refuses %s feedback callback without evidence", async kind => {
  const w = await world();
  if (kind === "wrong-binding") w.request.body = JSON.stringify({ ...w.operation.workflowFeedbackReview, taskId: "99999999-9999-4999-8999-999999999999" });
  if (kind === "wrong-mode") await w.h.store.update({ key: w.operation, ops: [change.set("workflowMode", "IMPLEMENT")] });
  if (kind === "wrong-fence") await w.h.store.update({ key: { pk: `WORKSPACE#${w.task.workspaceId}`, sk: "META" }, ops: [change.set("fence", w.operation.fence + 1)] });
  if (kind === "terminal") await w.h.store.update({ key: w.operation, ops: [change.set("status", "SUCCEEDED")] });
  if (kind === "foreign-company") await w.h.store.update({ key: { pk: w.task.pk, sk: w.task.sk }, ops: [change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb")] });
  if (kind === "missing-bytes") w.objects.clear();
  if (kind === "wrong-revision") await w.h.store.update({ key: w.task, ops: [change.set(["workflow", "revision"], 999)] });
  if (kind === "closed-task") await w.h.store.update({ key: w.task, ops: [change.set("closedAt", new Date(w.clock.ms).toISOString())] });
  if (kind === "wrong-holder") await w.h.store.update({ key: { pk: `WORKSPACE#${w.task.workspaceId}`, sk: "META" }, ops: [change.set("activeOperationId", "99999999-9999-4999-8999-999999999999")] });
  if (kind === "corrupt-bundle") w.objects.set(w.task.workflow!.feedbackReview!.bundleRefs[0]!.objectKey, Buffer.from("{}"));
  if (kind === "missing-stamp") await w.h.store.delete({ key: { pk: `TASK_ENGINE#${w.task.taskId}`, sk: "STAMP" } });
  if (kind === "extra-field") w.request.body = JSON.stringify({ ...w.operation.workflowFeedbackReview, injected: true });
  if (kind === "wrong-candidate") w.request.body = JSON.stringify({ ...w.operation.workflowFeedbackReview, candidateDigest: "0".repeat(64) });
  if (kind === "wrong-feedback-state") await w.h.store.update({ key: w.task, ops: [change.set(["workflow", "feedbackReview", "status"], "DISMISSED")] });
  if (kind === "access-denied") w.h.deps.access.checkStep = async () => ({ allowed: false, code: "access_denied", message: "Access revoked" });
  if (kind === "no-artifact-port") delete w.h.deps.feedbackArtifacts;
  const response = await w.handler(w.request);
  expect(response.statusCode).not.toBe(200);
  expect(response.body).not.toContain("Handle this failure.");
});

it.each([200_001, 1_000_001])("the critic report callback retains its existing one-million-byte bound (%i)", async size => {
  const w = await world();
  const { feedbackDigest } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const content = "x".repeat(size);
  const token = new CallbackCapabilities(Buffer.from(w.h.deps.callbackSigningKey)).issue({ workspaceId: w.operation.workspaceId,
    operationId: w.operation.id, fence: w.operation.fence, actions: ["artifacts"], expiresInSeconds: 100 });
  const response = await w.handler({ ...w.request, path: w.request.path.replace("feedback-bundles", "artifacts"), headers: { [CAPABILITY_HEADER]: token },
    body: JSON.stringify({ name: `workflow-feedback-review-${feedbackDigest(content)}.json`, mediaType: "application/json", content }) });
  expect(response.statusCode).toBe(size <= 1_000_000 ? 200 : 400);
});

async function artifactWorld() {
  const w = await world();
  const { WorkflowFeedbackBundleSchema } = await import("@agentx/contracts");
  const ref = w.task.workflow!.feedbackReview!.bundleRefs[0]!;
  const bundle = WorkflowFeedbackBundleSchema.parse(JSON.parse(Buffer.from(w.objects.get(ref.objectKey)!).toString("utf8")));
  return { ...w, ref, bundle };
}

it.each(["foreign-task", "too-large"])("bundle persistence refuses %s before object writes", async kind => {
  const { saveFeedbackBundle, feedbackDigest } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const w = await artifactWorld();
  if (kind === "foreign-task") w.bundle.taskId = "99999999-9999-4999-8999-999999999999";
  if (kind === "too-large") {
    w.bundle.comments[0]!.body = "x".repeat(1_000_000);
    w.bundle.comments[0]!.bodyBytes = 1_000_000;
    w.bundle.comments[0]!.bodyDigest = feedbackDigest(w.bundle.comments[0]!.body);
    w.bundle.commentSetDigest = feedbackDigest(JSON.stringify(w.bundle.comments));
  }
  w.put.mockClear();
  await expect(saveFeedbackBundle(w.deps.blobs, w.task, w.bundle)).rejects.toBeDefined();
  expect(w.put).not.toHaveBeenCalled();
});

it.each(["permission-error", "missing", "corrupt", "identical"])("immutable evidence collision verifies %s", async kind => {
  const { ObjectConflictError } = await import("@agentx/contracts");
  const { saveFeedbackBundle } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const w = await artifactWorld();
  if (kind === "missing") w.objects.delete(w.ref.objectKey);
  if (kind === "corrupt") w.objects.set(w.ref.objectKey, Buffer.from("different bytes"));
  w.put.mockRejectedValue(kind === "permission-error" ? new Error("write denied") : new ObjectConflictError(w.ref.objectKey));
  const result = saveFeedbackBundle(w.deps.blobs, w.task, w.bundle);
  if (kind === "identical") await expect(result).resolves.toEqual(w.ref);
  else await expect(result).rejects.toBeDefined();
});

it.each(["foreign-key", "foreign-task", "missing", "digest", "metadata", "empty"])("bundle reads refuse %s without accepting unverifiable evidence", async kind => {
  const { readFeedbackBundles, feedbackDigest, feedbackPrefix } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const w = await artifactWorld();
  const bytes = w.objects.get(w.ref.objectKey)!;
  if (kind === "foreign-key") {
    const key = `private/other/workspace/${w.ref.sha256}.json`;
    w.objects.set(key, bytes);
    w.task.workflow!.feedbackReview!.bundleRefs[0] = { ...w.ref, objectKey: key };
  }
  if (kind === "foreign-task") {
    w.bundle.taskId = "99999999-9999-4999-8999-999999999999";
    const text = JSON.stringify(w.bundle), sha256 = feedbackDigest(text), objectKey = `${feedbackPrefix(w.task)}${sha256}.json`;
    w.objects.set(objectKey, Buffer.from(text));
    w.task.workflow!.feedbackReview!.bundleRefs[0] = { ...w.ref, taskId: w.bundle.taskId, objectKey, sha256 };
  }
  if (kind === "missing") w.objects.delete(w.ref.objectKey);
  if (kind === "digest") w.objects.set(w.ref.objectKey, Buffer.from(`\n${Buffer.from(bytes).toString("utf8")}`));
  if (kind === "metadata") w.task.workflow!.feedbackReview!.bundleRefs[0]!.comments[0]!.author = "another reviewer";
  if (kind === "empty") w.task.workflow!.feedbackReview = undefined;
  if (kind === "missing") await expect(readFeedbackBundles(w.deps.blobs, w.task)).rejects.toThrow("feedback bundle integrity mismatch");
  else await expect(readFeedbackBundles(w.deps.blobs, w.task)).rejects.toBeDefined();
});

it("an absent immutable object never counts as an identical empty write", async () => {
  const { writeFeedbackBytes, feedbackDigest } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const { ObjectConflictError } = await import("@agentx/contracts");
  const { vi } = await import("vitest");
  const error = new ObjectConflictError("empty.json");
  const blobs = { put: vi.fn(async () => { throw error; }), get: vi.fn(async () => undefined) };
  await expect(writeFeedbackBytes(blobs, "empty.json", new Uint8Array(), feedbackDigest(""))).rejects.toBe(error);
});

it.each(["collision", "read"])("%s verifies exact bundle bytes rather than replacement-decoded text", async kind => {
  const { saveFeedbackBundle, readFeedbackBundles, feedbackDigest, feedbackPrefix } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const { corruptReplacementByte } = await import("../support/pr-feedback-world.js");
  const { ObjectConflictError } = await import("@agentx/contracts");
  const w = await artifactWorld();
  w.bundle.comments[0]!.body = "\uFFFD";
  w.bundle.comments[0]!.bodyBytes = 3;
  w.bundle.comments[0]!.bodyDigest = feedbackDigest("\uFFFD");
  w.bundle.commentSetDigest = feedbackDigest(JSON.stringify(w.bundle.comments));
  if (kind === "collision") {
    const text = JSON.stringify(w.bundle), sha = feedbackDigest(text), key = `${feedbackPrefix(w.task)}${sha}.json`;
    const bad = corruptReplacementByte(Buffer.from(text));
    expect(Buffer.from(bad).toString("utf8")).toBe(text);
    w.objects.set(key, bad);
    w.put.mockRejectedValue(new ObjectConflictError(key));
    await expect(saveFeedbackBundle(w.deps.blobs, w.task, w.bundle)).rejects.toBeDefined();
  } else {
    const ref = await saveFeedbackBundle(w.deps.blobs, w.task, w.bundle);
    w.objects.set(ref.objectKey, corruptReplacementByte(w.objects.get(ref.objectKey)!));
    w.task.workflow!.feedbackReview!.bundleRefs = [ref];
    await expect(readFeedbackBundles(w.deps.blobs, w.task)).rejects.toThrow("integrity mismatch");
  }
});

it("the aggregate input-byte bound rejects individually valid bundles over eight million bytes", async () => {
  const { saveFeedbackBundle, readFeedbackBundles, feedbackDigest } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const w = await artifactWorld();
  const refs = [];
  for (let i = 0; i < 9; i++) {
    const comments = w.bundle.comments.map(c => ({ ...c, body: "x".repeat(900_000), bodyBytes: 900_000, bodyDigest: feedbackDigest("x".repeat(900_000)) }));
    refs.push(await saveFeedbackBundle(w.deps.blobs, w.task, { ...w.bundle, number: i + 1, comments, commentSetDigest: feedbackDigest(JSON.stringify(comments)) }));
  }
  w.task.workflow!.feedbackReview = { status: "COLLECTING", bundleRefs: refs, threadObservations: [] };
  await expect(readFeedbackBundles(w.deps.blobs, w.task)).rejects.toBeDefined();
});

it.each(["unapproved-plan", "requirements-too-large"])("critic inputs refuse %s before serving untrusted evidence", async kind => {
  const { feedbackRequirements } = await import("../../packages/broker/src/core/pr-feedback/inputs.js");
  const { feedbackDigest } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const w = await world();
  if (kind === "unapproved-plan") w.task.workflow!.decisions = [];
  else {
    const plan = w.task.workflow!.artifacts.find(a => a.type === "plan")!;
    const text = "# Plan\n" + "x".repeat(199_000);
    plan.sha256 = feedbackDigest(text);
    w.objects.set(plan.objectKey, Buffer.from(text));
    w.task.workflow!.decisions[0]!.artifactDigest = plan.sha256;
    w.task.workflow!.feedbackNotes = [{ schemaVersion: 1, requestId: "77777777-7777-4777-8777-777777777777", actorId: w.task.ownerKey,
      source: "REQUEST_CHANGES", sourceId: "77777777-7777-4777-8777-777777777777", text: "x".repeat(2000), at: new Date(w.clock.ms).toISOString() }];
  }
  await expect(feedbackRequirements(w.h.deps, w.task)).rejects.toThrow(kind === "unapproved-plan" ? "approved requirements" : "input limit");
});
