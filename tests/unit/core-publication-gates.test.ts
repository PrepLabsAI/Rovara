import { describe, expect, it } from "vitest";
import { change, type CodeBuildCheckResult } from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { codeBuildCheckRunner } from "../../packages/broker/src/plugins/check-runner/codebuild/index.js";
import { startManualPublication } from "../../packages/broker/src/core/task-flow/manual-publication.js";
import { assertPublicationGates, publicationGateCallback } from "../../packages/broker/src/core/build-step/publication-gates.js";
import { openPullRequest } from "../../packages/broker/src/core/build-step/publish.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { REQUEST_A, seed, TASK_ID } from "../support/task-actions-world.js";

async function world() {
  const { h, caller } = await seed({ workflow: null });
  const projects = h.deps.projects;
  h.deps.projects = { ...projects, revision: async (name, revision) => {
    const found = await projects.revision(name, revision);
    return found === undefined ? undefined : { ...found, definition: { ...found.definition, repositories: found.definition.repositories.map(repo => ({ ...repo, host: { kind: "fake" }, codeBuildGates: [{ name: "unit", projectName: "unit-project", timeoutMinutes: 10 }] })) } };
  } };
  const op = await startManualPublication(h.deps, caller, TASK_ID, { requestId: REQUEST_A, title: "Add retry", draft: true });
  const location = await workspaceKeys(h.deps, op.workspaceId);
  await h.store.put({ item: { ...location.taskPointerKey(), taskId: TASK_ID } });
  const model = new FakeHostModel({ url: op.publication!.repositoryUrl, id: "42", fullName: "example/demo" });
  const commit = model.commit(op.publication!.headBranch, { "retry.ts": "retry" });
  const result: CodeBuildCheckResult = { gate: "unit", projectName: "unit-project", buildId: "unit-project:123", requestedSourceVersion: commit, resolvedSourceVersion: commit, status: "SUCCEEDED" };
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", new FakeCodeHost(model), { isDefault: true });
  registry.register("check-runner", "codebuild", { kind: "codebuild", create: context => codeBuildCheckRunner({ ...context, gateway: { start: async () => result, status: async () => result } }) });
  h.deps.codeHosts = registry;
  const input = { action: "start", gate: "unit", projectName: "unit-project", repository: "demo", commit };
  const callback = { repository: "demo", repositoryUrl: op.publication!.repositoryUrl, headBranch: op.publication!.headBranch, baseBranch: "main", title: "Add retry", body: "", commit };
  return { h, op, location, commit, result, input, callback, model };
}

describe("publication gate exact-source proof", () => {
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
