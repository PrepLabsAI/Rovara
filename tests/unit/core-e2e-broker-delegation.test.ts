// The hosted loaders must select the company-bound core result service before any legacy projection.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as BrokerExports from "../../packages/broker/src/aws/broker.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { applicationResultsPresentation, unavailableApplicationView } from "../../packages/broker/src/core-host/e2e-results.js";
import { pageTask } from "../support/page-tasks.js";
import { memoryS3 } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { results, SHOT, SHOT_SHA } from "../support/e2e-scenario-results.js";

type BrokerModule = typeof BrokerExports;
type BrokerDeps = Parameters<BrokerModule["loadWorkflowE2EPresentation"]>[0];
let broker: BrokerModule;
beforeAll(async () => { await loadSlackBroker(); broker = await import("../../packages/broker/src/aws/broker.js"); });
const COMPANY = "org_11111111111111111111";

function world() {
  const page = pageTask();
  const task = { ...page.db.get(`DEVTASK#${page.taskId}`, "META"), companyId: COMPANY } as unknown as DeveloperTaskRecord;
  const presentation = applicationResultsPresentation(task.taskId, unavailableApplicationView());
  const scenarioResults = results();
  const artifact = { contentType: "image/jpeg" as const, bytes: new Uint8Array(SHOT) };
  const read = vi.fn(async () => ({ presentation, scenarioResults }));
  const artifactRead = vi.fn(async () => artifact);
  const store = { get: vi.fn(async () => task as unknown) };
  const flow: { store: typeof store; applicationE2E?: { results: { read: typeof read; artifact: typeof artifactRead } } } = { store, applicationE2E: { results: { read, artifact: artifactRead } } };
  const registry = vi.fn(async () => ({ require: vi.fn(() => store) }));
  const engineOfTask = vi.fn(async () => "core");
  const runtimeFor = vi.fn(async () => ({ flow: { deps: flow } }));
  const deps = { core: { app: { registry, engineOfTask, runtimeFor } }, documentClient: page.deps.documentClient,
    tableName: "state", artifactBucketName: "artifacts", s3: memoryS3() } as unknown as BrokerDeps;
  return { task, presentation, scenarioResults, artifact, read, artifactRead, store, flow, registry, engineOfTask, runtimeFor, deps };
}

describe("hosted core result delegation", () => {
  it("delegates presentation, scenario rows and the requested artifact with their existing inputs", async () => {
    const w = world();
    expect(await broker.loadWorkflowE2EPresentation(w.deps, w.task, [], "owner")).toEqual(w.presentation);
    expect(await broker.loadWorkflowE2EScenarioResults(w.deps, w.task, [], "viewer")).toEqual(w.scenarioResults);
    expect(await broker.loadWorkflowE2EArtifact(w.deps, w.task, SHOT_SHA)).toEqual(w.artifact);
    expect(w.runtimeFor.mock.calls).toEqual([[COMPANY], [COMPANY], [COMPANY]]);
    expect(w.read.mock.calls).toEqual([[w.task, "owner"], [w.task, "viewer"]]);
    expect(w.artifactRead).toHaveBeenCalledExactlyOnceWith(w.task, SHOT_SHA);
  });

  for (const absent of ["core", "company"] as const) it(`uses the legacy projection without reading core storage when ${absent} is absent`, async () => {
    const w = world();
    if (absent === "core") delete w.deps.core;
    else delete w.task.companyId;
    expect(await broker.loadWorkflowE2EPresentation(w.deps, w.task, [])).toBeUndefined();
    expect(await broker.loadWorkflowE2EScenarioResults(w.deps, w.task, [], "viewer")).toBeUndefined();
    expect(await broker.loadWorkflowE2EArtifact(w.deps, w.task, SHOT_SHA)).toBeUndefined();
    expect(w.registry).not.toHaveBeenCalled();
    expect(w.runtimeFor).not.toHaveBeenCalled();
    expect(w.read).not.toHaveBeenCalled();
  });

  it("keeps a workflow-engine task on its legacy projection before any core runtime read", async () => {
    const w = world(); w.engineOfTask.mockResolvedValue("workflow");
    expect(await broker.loadWorkflowE2EPresentation(w.deps, w.task, [])).toBeUndefined();
    expect(await broker.loadWorkflowE2EScenarioResults(w.deps, w.task, [], "viewer")).toBeUndefined();
    expect(await broker.loadWorkflowE2EArtifact(w.deps, w.task, SHOT_SHA)).toBeUndefined();
    expect(w.runtimeFor).not.toHaveBeenCalled();
    expect(w.read).not.toHaveBeenCalled();
  });

  for (const stale of ["missing", "company", "workflow", "service"] as const) it(`refuses ${stale} core state before result data is read`, async () => {
    const w = world();
    if (stale === "missing") w.store.get.mockResolvedValue(undefined);
    if (stale === "company") w.store.get.mockResolvedValue({ ...w.task, companyId: "org_22222222222222222222" });
    if (stale === "workflow") { const { workflow: _workflow, ...stored } = w.task; void _workflow; w.store.get.mockResolvedValue(stored); }
    if (stale === "service") delete w.flow.applicationE2E;
    for (const request of [() => broker.loadWorkflowE2EPresentation(w.deps, w.task, []),
      () => broker.loadWorkflowE2EScenarioResults(w.deps, w.task, []), () => broker.loadWorkflowE2EArtifact(w.deps, w.task, SHOT_SHA)]) {
      await expect(request()).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    }
    expect(w.read).not.toHaveBeenCalled();
    expect(w.artifactRead).not.toHaveBeenCalled();
  });
});
