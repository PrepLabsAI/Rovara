import { describe, expect, it, vi } from "vitest";
import { getTaskDocumentView, getTaskFreshness } from "../../packages/broker/src/aws/developer-tasks.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { pageTask, pagePlan, PRIYA } from "../support/page-tasks.js";

function fixture(statusCode = 200) {
  const h = pageTask();
  h.addVersion("plan", pagePlan());
  h.deps.companyId = "org_corehost00000000000a";
  h.db.set({ ...h.db.get(`DEVTASK#${h.taskId}`, "META")!, companyId: h.deps.companyId });
  h.db.set({ ...engineStampKey(h.taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "all", stampedAt: new Date().toISOString() } });
  const route = vi.fn(async () => ({ statusCode, headers: {}, body: "{}" }));
  h.deps.coreTasks = { route };
  return { ...h, route };
}

describe("merged document and freshness access", () => {
  it("keeps documented core owner reads on the live core route", async () => {
    const h = fixture();
    expect(await getTaskFreshness(h.deps, PRIYA, h.taskId)).toMatchObject({ revision: h.workflow().revision });
    expect(await getTaskDocumentView(h.deps, PRIYA, h.taskId)).toMatchObject({ taskId: h.taskId });
    expect(h.route).toHaveBeenCalledTimes(2);
  });

  it("a core refusal prevents document and freshness reads even when the legacy record is readable", async () => {
    const h = fixture(404);
    const read = vi.spyOn(h.deps.actions, "readArtifact");
    for (const get of [getTaskFreshness, getTaskDocumentView]) {
      await expect(get(h.deps, PRIYA, h.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    }
    expect(h.route).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
  });
});

it("gives core document E2E results no legacy workspace operations", async () => {
  const h = fixture();
  h.setWorkflow({ ...h.workflow(), e2e: { required: true, contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentGroupRunIds: [], resultRefs: [] } });
  const results = vi.fn<NonNullable<typeof h.deps.workflowE2EScenarioResults>>(async () => undefined);
  h.deps.workflowE2EScenarioResults = results;
  h.deps.actions.workspace = async () => { throw new Error("core results must not read a legacy workspace"); };
  const operations = vi.spyOn(h.deps.actions, "operations");
  expect(await getTaskDocumentView(h.deps, PRIYA, h.taskId)).toMatchObject({ taskId: h.taskId });
  expect(results).toHaveBeenCalledTimes(1);
  expect(results.mock.calls[0]![0]).toMatchObject({ task: { taskId: h.taskId }, operations: [], actor: "owner" });
  expect(operations).not.toHaveBeenCalled();
});
