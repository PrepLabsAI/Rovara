import { describe, expect, it } from "vitest";
import { change, type CodeBuildCheckResult } from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { codeBuildCheckRunner } from "../../packages/broker/src/plugins/check-runner/codebuild/index.js";
import { startManualPublication } from "../../packages/broker/src/core/task-flow/manual-publication.js";
import { assertPublicationGates, publicationGateCallback } from "../../packages/broker/src/core/build-step/publication-gates.js";
import { openPullRequest } from "../../packages/broker/src/core/build-step/publish.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { CAPABILITY_HEADER, createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { CallbackCapabilities, type CallbackAction } from "../../packages/broker/src/callbacks.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { REQUEST_A, seed, TASK_ID } from "../support/task-actions-world.js";

async function world(options: { draft?: boolean } = {}) {
  const { h, caller } = await seed({ workflow: null });
  const projects = h.deps.projects;
  h.deps.projects = { ...projects, revision: async (name, revision) => {
    const found = await projects.revision(name, revision);
    return found === undefined ? undefined : { ...found, definition: { ...found.definition, repositories: found.definition.repositories.map(repo => ({ ...repo, host: { kind: "fake" }, codeBuildGates: [{ name: "unit", projectName: "unit-project", timeoutMinutes: 10 }] })) } };
  } };
  const op = await startManualPublication(h.deps, caller, TASK_ID, { requestId: REQUEST_A, title: "Add retry", draft: options.draft ?? true });
  const location = await workspaceKeys(h.deps, op.workspaceId);
  await h.store.put({ item: { ...location.taskPointerKey(), taskId: TASK_ID } });
  const model = new FakeHostModel({ url: op.publication!.repositoryUrl, id: "42", fullName: "example/demo" });
  const commit = model.commit(op.publication!.headBranch, { "retry.ts": "retry" });
  const result: CodeBuildCheckResult = { gate: "unit", projectName: "unit-project", buildId: "unit-project:123", requestedSourceVersion: commit, resolvedSourceVersion: commit, status: "SUCCEEDED" };
  const registry = createAdapterRegistry();
  const codeHost = new FakeCodeHost(model);
  registry.register("code-host", "fake", codeHost, { isDefault: true });
  registry.register("check-runner", "codebuild", { kind: "codebuild", create: context => codeBuildCheckRunner({ ...context, gateway: { start: async () => result, status: async () => result } }) });
  h.deps.codeHosts = registry;
  const input = { action: "start", gate: "unit", projectName: "unit-project", repository: "demo", commit };
  const callback = { repository: "demo", repositoryUrl: op.publication!.repositoryUrl, headBranch: op.publication!.headBranch, baseBranch: "main", title: "Add retry", body: "", commit };
  return { h, op, location, commit, result, input, callback, model, codeHost };
}

describe("publication gate exact-source proof", () => {
  it("serves the documented CodeBuild and pull-request callback inputs through the public callback handler", async () => {
    const w = await world();
    const capabilities = new CallbackCapabilities(Buffer.from(w.h.deps.callbackSigningKey));
    const token = capabilities.issue({ workspaceId: w.op.workspaceId, operationId: w.op.id, fence: w.op.fence, actions: ["events", ...w.op.dispatch.extraActions!] as CallbackAction[], expiresInSeconds: 600 });
    const handler = createCallbackHandler({ flow: w.h.deps, blobs: createDocumentObjectStorage(w.h.store, { companyId: w.h.deps.companyId }), grants: { exchange: async () => ({ token: "fixture" }), inspect: () => { throw new Error("unused"); } } });
    const post = (action: string, body: unknown) => handler({ method: "POST", path: `/v1/internal/workspaces/${w.op.workspaceId}/operations/${w.op.id}/${action}`, headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify(body) });
    const events = await post("events", { events: [{ type: "progress", timestamp: "2026-11-09T10:00:00.000Z", payload: {} }] });
    expect(events.statusCode).toBe(200);
    expect(JSON.parse(events.body)).toMatchObject({ accepted: 1 });
    expect((await post("codebuild", w.input)).statusCode).toBe(200);
    expect((await post("pull-request", w.callback)).statusCode).toBe(200);
    expect(w.model.changeRequests).toHaveLength(1);
  });
  it("keeps the documented non-draft manual input working alongside workflow publication fences", async () => {
    const w = await world({ draft: false });
    await publicationGateCallback(w.h.deps, w.op, w.input);
    expect(await openPullRequest(w.h.deps, w.op, w.callback)).toMatchObject({ number: 1, draft: false });
    expect(w.model.changeRequests).toHaveLength(1);
  });

  for (const phase of ["before-open", "before-record"] as const) {
    for (const field of ["closedAt", "closeOperationId", "workflow", "companyId", "workspaceId"] as const) {
      it(`refuses manual publication when ${field} moves ${phase}`, async () => {
        const w = await world();
        await publicationGateCallback(w.h.deps, w.op, w.input);
        const transact = w.h.store.transact.bind(w.h.store);
        let checks = 0;
        w.h.store.transact = async (items) => {
          if (items.some(item => item.kind === "check" && item.key.pk === taskKey(TASK_ID).pk)) {
            checks += 1;
            if (checks === (phase === "before-open" ? 1 : 3)) {
              await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set(field, field === "workflow" ? { stage: "PLAN_REVIEW" } : "moved")] });
            }
          }
          return transact(items);
        };
        await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "STALE_FENCE" });
        expect(w.model.changeRequests).toHaveLength(phase === "before-open" ? 0 : 1);
        const records = await w.h.store.query({ pk: w.location.workspaceKey.pk, sk: { op: "beginsWith", prefix: "PULL_REQUEST#" } });
        expect(records.items).toEqual([]);
      });
    }
  }

  it("refuses the manual callback if a workflow was attached before the task read", async () => {
    const w = await world();
    await publicationGateCallback(w.h.deps, w.op, w.input);
    await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set("workflow", { stage: "PULL_REQUEST", state: "READY" })] });
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(w.model.changeRequests).toHaveLength(0);
  });

  it.each(["missing", "workspace"] as const)("refuses a %s task binding before opening a manual pull request", async drift => {
    const w = await world();
    await publicationGateCallback(w.h.deps, w.op, w.input);
    if (drift === "missing") await w.h.store.delete({ key: taskKey(TASK_ID) });
    else await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set("workspaceId", "another-workspace")] });
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(w.model.changeRequests).toHaveLength(0);
  });

  it("refuses revoked step access before the code-host effect", async () => {
    const w = await world();
    await publicationGateCallback(w.h.deps, w.op, w.input);
    w.h.deps.access.checkStep = async () => ({ allowed: false, message: "Access revoked" });
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(w.model.changeRequests).toHaveLength(0);
  });

  it("refuses a moved branch before opening any pull request, even if a later head read could close it", async () => {
    const w = await world();
    await publicationGateCallback(w.h.deps, w.op, w.input);
    w.model.branches.set(w.op.publication!.headBranch, w.model.headOf("main"));
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(w.model.changeRequests).toHaveLength(0);
  });

  it("closes an opened pull request whose head moved after the first branch read", async () => {
    const w = await world();
    await publicationGateCallback(w.h.deps, w.op, w.input);
    const reconcile = w.codeHost.reconcileChangeRequest.bind(w.codeHost);
    w.codeHost.reconcileChangeRequest = async (...args) => {
      const result = await reconcile(...args);
      w.model.branches.set(w.op.publication!.headBranch, w.model.headOf("main"));
      return result;
    };
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(w.model.changeRequests).toHaveLength(1);
    expect(w.model.changeRequests[0]).toMatchObject({ state: "closed" });
    expect((await w.h.store.query({ pk: w.location.workspaceKey.pk, sk: { op: "beginsWith", prefix: "PULL_REQUEST#" } })).items).toEqual([]);
  });

  it("rechecks task authority after reading the branch and before opening the pull request", async () => {
    const w = await world();
    await publicationGateCallback(w.h.deps, w.op, w.input);
    const branchHead = w.codeHost.branchHead.bind(w.codeHost);
    w.codeHost.branchHead = async (...args) => {
      const head = await branchHead(...args);
      await w.h.store.update({ key: taskKey(TASK_ID), ops: [change.set("closedAt", "2026-11-22T12:00:00Z")] });
      return head;
    };
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(w.model.changeRequests).toHaveLength(0);
  });

  it.each(["FAILED", "IN_PROGRESS"] as const)("refuses a %s build even when its source matches the commit", async status => {
    const w = await world();
    w.result.status = status;
    await publicationGateCallback(w.h.deps, w.op, w.input);
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(w.model.changeRequests).toHaveLength(0);
  });
  it.each(["FAILED", "IN_PROGRESS", "RUNNING", "FAULT", "STOPPED", "TIMED_OUT", "UNKNOWN", "succeeded", ""])("refuses stored %s evidence with otherwise exact publication proof", async status => {
    const w = await world();
    await publicationGateCallback(w.h.deps, w.op, w.input);
    const key = { pk: w.location.workspaceKey.pk, sk: `CODEBUILD#${w.op.id}#unit` };
    await w.h.store.update({ key, ops: [change.set("evidence.status", status)] });
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(w.model.changeRequests).toHaveLength(0);
  });
  it.each(["evidence", "evidence.status"])("refuses missing %s on an existing gate row", async field => {
    const w = await world();
    await publicationGateCallback(w.h.deps, w.op, w.input);
    const key = { pk: w.location.workspaceKey.pk, sk: `CODEBUILD#${w.op.id}#unit` };
    await w.h.store.update({ key, ops: [change.remove(field)] });
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(w.model.changeRequests).toHaveLength(0);
  });
  it("refuses an absent gate, records the existing CODEBUILD wire, and opens the manual draft only after exact proof", async () => {
    const w = await world();
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(w.model.changeRequests).toHaveLength(0);
    expect(await publicationGateCallback(w.h.deps, w.op, w.input)).toMatchObject({ status: "SUCCEEDED", requestedSourceVersion: w.commit, resolvedSourceVersion: w.commit });
    await assertPublicationGates(w.h.deps, w.op, w.commit);
    const opened = await openPullRequest(w.h.deps, w.op, w.callback);
    expect(opened).toMatchObject({ number: 1, draft: true });
    expect(w.model.changeRequests).toHaveLength(1);
  });
  it.each([undefined, "f".repeat(40)])("refuses missing/mismatched provider source %s even when the run succeeded", async resolved => {
    const w = await world();
    if (resolved === undefined) delete w.result.resolvedSourceVersion; else w.result.resolvedSourceVersion = resolved;
    await publicationGateCallback(w.h.deps, w.op, w.input);
    await expect(openPullRequest(w.h.deps, w.op, w.callback)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(w.model.changeRequests).toHaveLength(0);
  });
  it("pins the candidate and the build id, refuses other gates and projects, and binds operation and fence", async () => {
    const w = await world();
    await publicationGateCallback(w.h.deps, w.op, w.input);
    for (const changed of [{ commit: "e".repeat(40) }, { repository: "another" }, { gate: "other" }, { projectName: "other" }, { action: "status", buildId: "forged" }]) {
      await expect(publicationGateCallback(w.h.deps, w.op, { ...w.input, ...changed })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    }
    const key = { pk: w.location.workspaceKey.pk, sk: `CODEBUILD#${w.op.id}#unit` };
    for (const [field, bad] of [["operationId", "other"], ["fence", 99], ["repository", "another"], ["projectName", "other"]] as const) {
      const original = (await w.h.store.get(key))!;
      await w.h.store.update({ key, ops: [change.set(field, bad)] });
      await expect(assertPublicationGates(w.h.deps, w.op, w.commit)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
      await w.h.store.put({ item: original });
    }
  });
});
