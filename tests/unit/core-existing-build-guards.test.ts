import { describe, expect, it } from "vitest";
import { change, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE } from "@agentx/contracts";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { startChecksRerun, startImplementation } from "../../packages/broker/src/core/build-step/start.js";
import { openPullRequest } from "../../packages/broker/src/core/build-step/publish.js";
import { startManualPublication } from "../../packages/broker/src/core/task-flow/manual-publication.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { blockedReview, code, operationsOf, report, REQUEST_A, seed, taskOf, TASK_ID } from "../support/task-actions-world.js";
import { definition } from "../support/task-flow-harness.js";

const row = { taskId: TASK_ID, workflowRevision: 6 };
const manual = { requestId: REQUEST_A, instructions: "Retry this step." };

describe("existing manual build authority", () => {
  it("an automatic implementation row cannot spend on a BLOCKED task; the manual retry can", async () => {
    const { h } = await seed({ workflow: blockedReview({ stage: "IMPLEMENT" }) });
    const before = (await taskOf(h)).workflow;
    expect(await startImplementation(h.deps, row)).toBe("STALE");
    expect(await operationsOf(h)).toHaveLength(0);
    expect((await taskOf(h)).workflow).toEqual(before);
    expect(h.grants).toHaveLength(0);
    expect(await startImplementation(h.deps, row, manual)).toBe("STARTED");
    expect(await operationsOf(h)).toEqual([expect.objectContaining({ workflowMode: "IMPLEMENT", requestId: REQUEST_A })]);
  });

  it("automatic checks cannot spend at a BLOCKED publication retry; the manual request can", async () => {
    const { h } = await seed({ workflow: blockedReview({ stage: "PULL_REQUEST", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE,
      reviews: [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])] }) });
    const before = (await taskOf(h)).workflow;
    const retry = { requestId: REQUEST_A, actorId: "local-owner" };
    expect(await startChecksRerun(h.deps, row, retry)).toBe("STALE");
    expect(await operationsOf(h)).toHaveLength(0);
    expect((await taskOf(h)).workflow).toEqual(before);
    expect(h.grants).toHaveLength(0);
    expect(await startChecksRerun(h.deps, row, { ...retry, manual })).toBe("STARTED");
    expect(await operationsOf(h)).toEqual([expect.objectContaining({ workflowMode: "CHECKS", requestId: REQUEST_A })]);
  });

  it("even a manual publication recheck cannot start after a pull request exists", async () => {
    const { h } = await seed({ workflow: blockedReview({ stage: "PULL_REQUEST", blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE,
      reviews: [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])],
      pullRequests: [{ repositoryId: "demo", number: 1, url: "https://examplehost/example/demo/pull/1", state: "OPEN", candidateDigest: code.digest, required: true }] }) });
    const before = (await taskOf(h)).workflow;
    expect(await startChecksRerun(h.deps, row, { requestId: REQUEST_A, actorId: "local-owner", manual })).toBe("STALE");
    expect(await operationsOf(h)).toHaveLength(0);
    expect((await taskOf(h)).workflow).toEqual(before);
    expect(h.grants).toHaveLength(0);
  });

  it("a manual publication for a legacy-closed task without a Close claim creates no PR", async () => {
    const { h, caller } = await seed({ workflow: null });
    await h.registerProject({ ...definition, repositories: definition.repositories.map(repository => ({ ...repository, host: { kind: "fake" } })) });
    const operation = await startManualPublication(h.deps, caller, TASK_ID, { requestId: REQUEST_A, title: "Add retry", draft: true });
    const location = await workspaceKeys(h.deps, operation.workspaceId);
    await h.store.put({ item: { ...location.taskPointerKey(), taskId: TASK_ID } });
    const publication = operation.publication!;
    const model = new FakeHostModel({ url: publication.repositoryUrl, id: "42", fullName: "example/demo" });
    const commit = model.commit(publication.headBranch, { "retry.ts": "retry" });
    const registry = createAdapterRegistry();
    registry.register("code-host", "fake", new FakeCodeHost(model), { isDefault: true });
    h.deps.codeHosts = registry;
    await h.store.update({ key: taskKey(TASK_ID), ops: [change.set("closedAt", "2026-11-11T00:00:00.000Z")] });
    const before = await taskOf(h);
    expect(before.closeOperationId).toBeUndefined();
    expect(before.closedAt).toBeDefined();
    await expect(openPullRequest(h.deps, operation, { repository: publication.repository, repositoryUrl: publication.repositoryUrl,
      headBranch: publication.headBranch, baseBranch: publication.baseBranch, title: publication.title, body: publication.body, commit })).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(model.changeRequests).toHaveLength(0);
    expect(await taskOf(h)).toEqual(before);
  });

  it.each([false, true])("manual publication refuses a foreign company before creating a PR (foreign=%s)", async foreign => {
    const { h, caller } = await seed({ workflow: null });
    await h.registerProject({ ...definition, repositories: definition.repositories.map(repository => ({ ...repository, host: { kind: "fake" } })) });
    const operation = await startManualPublication(h.deps, caller, TASK_ID, { requestId: REQUEST_A, title: "Add retry", draft: true });
    const location = await workspaceKeys(h.deps, operation.workspaceId);
    await h.store.put({ item: { ...location.taskPointerKey(), taskId: TASK_ID } });
    const publication = operation.publication!;
    const model = new FakeHostModel({ url: publication.repositoryUrl, id: "42", fullName: "example/demo" });
    const commit = model.commit(publication.headBranch, { "retry.ts": "retry" });
    const registry = createAdapterRegistry();
    registry.register("code-host", "fake", new FakeCodeHost(model), { isDefault: true });
    h.deps.codeHosts = registry;
    if (foreign) await h.store.update({ key: taskKey(TASK_ID), ops: [change.set("companyId", "org_other00000000000000")] });
    const opened = openPullRequest(h.deps, operation, { repository: publication.repository, repositoryUrl: publication.repositoryUrl,
      headBranch: publication.headBranch, baseBranch: publication.baseBranch, title: publication.title, body: publication.body, commit });
    if (foreign) {
      await expect(opened).rejects.toMatchObject({ code: "STALE_FENCE" });
      expect(model.changeRequests).toHaveLength(0);
    } else {
      await expect(opened).resolves.toMatchObject({ number: 1, draft: true });
      expect(model.changeRequests).toHaveLength(1);
    }
  });
});
