import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCandidateManifest, workflowFindingFingerprint } from "../../packages/contracts/src/task-workflow.js";
import { taskGraphDigest, type WorkItemProgressV1 } from "../../packages/contracts/src/workflow-dependencies.js";
import { executeSerialWorkflowDependencies } from "../../packages/worker/src/workflow-dependencies.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64),
  checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }],
  extraTry: "not_needed", agentClaim: "success" });

async function approvedGraph(includeGraphDigest = true, itemCount = 1) {
  const harness = await createDeveloperTaskBroker({ developerExtra: { workflowDependenciesEnabled: true },
    brokerExtra: { githubPullRequests: { getCommitTree: vi.fn(async () => "a".repeat(40)) } } });
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", {
    requestId: randomUUID(), project: "payments", instructions: "Implement the ordered change", client: "test-client", workflow: true, workflowPath: "QUICK",
  });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; workflow: { revision: number; artifacts: Array<{ sha256: string }> } };
  const workspaceId = task.workspaceId;
  const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  await harness.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", {
    result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] },
  });
  const graphItems = [
    { id: "11111111-1111-4111-8111-111111111111", title: "Implement first", description: "Implement the first change", repository: "demo", dependsOn: [] as string[] },
    { id: "22222222-2222-4222-8222-222222222222", title: "Implement second", description: "Implement the second change", repository: "demo", dependsOn: ["11111111-1111-4111-8111-111111111111"] },
  ];
  const graph = { schemaVersion: 1 as const, taskId, version: 1, items: graphItems.slice(0, itemCount) };
  const planning = operations().find((item) => item.workflowMode === "PLAN");
  if (planning === undefined) throw new Error("planning operation missing");
  await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ workBreakdown: graph })));
  await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  const current = harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: { revision: number; artifacts: Array<{ sha256: string }> } };
  const artifactDigest = current.workflow.artifacts.at(-1)!.sha256;
  const approved = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
    requestId: randomUUID(), expectedRevision: current.workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest,
    ...(includeGraphDigest ? { workBreakdownDigest: taskGraphDigest(graph) } : {}),
  });
  if (approved.status !== 200 && !includeGraphDigest) return { harness, taskId, workspaceId, graph, operations, approvalResponse: approved };
  if (approved.status !== 200) throw new Error(`approval failed: ${JSON.stringify(approved.body)}`);
  const implementation = operations().find((item) => item.workflowMode === "IMPLEMENT");
  if (implementation === undefined) throw new Error("implementation operation missing");
  return { harness, taskId, workspaceId, graph, implementation, operations, approvalResponse: approved };
}

type ApprovedGraphSetup = Awaited<ReturnType<typeof approvedGraph>>;
function implementationId(setup: ApprovedGraphSetup): string {
  if (setup.implementation === undefined) throw new Error("implementation operation missing from approved graph setup");
  return String(setup.implementation.id);
}

describe("broker work-breakdown callback integrity", () => {
  it("refuses graph approval unless the owner request names the exact graph digest", async () => {
    const setup = await approvedGraph(false);
    expect(setup.approvalResponse.status).toBe(400);
    expect(setup.operations().filter((item) => item.workflowMode === "IMPLEMENT")).toEqual([]);
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval?: unknown } }).workflow;
    expect(workflow.workflowDependenciesApproval).toBeUndefined();
  });

  it("rejects a progress callback with a wrong graph, run, item, sequence, or operation binding", async () => {
    const setup = await approvedGraph();
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string } } }).workflow;
    const good = { schemaVersion: 1, graphDigest: workflow.workflowDependenciesApproval.graphDigest, runId: workflow.workflowDependenciesApproval.runId,
      itemId: setup.graph.items[0]!.id, sequence: 1, state: "STARTED", operationId: implementationId(setup),
      baseTreeSha: "a".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" };
    const invalid = [
      { ...good, graphDigest: "0".repeat(64) }, { ...good, runId: randomUUID() }, { ...good, itemId: randomUUID() },
      { ...good, sequence: 99 }, { ...good, operationId: randomUUID() },
    ];
    for (const workItemProgress of invalid) {
      await expect(setup.harness.events(setup.workspaceId, implementationId(setup), [{ type: "progress", payload: { workItemProgress } }]))
        .rejects.toThrow();
    }
    expect((setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesProgress?: unknown[] } }).workflow.workflowDependenciesProgress ?? []).toEqual([]);
  });

  it("accepts an identical acknowledged progress replay and refuses conflicting content at the same sequence", async () => {
    const setup = await approvedGraph();
    const approval = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string } } }).workflow.workflowDependenciesApproval;
    const started = { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: setup.graph.items[0]!.id,
      sequence: 1, state: "STARTED", operationId: implementationId(setup), baseTreeSha: "a".repeat(40),
      at: new Date().toISOString(), producer: "agentx-worker" };
    const event = { type: "progress", payload: { workItemProgress: started } };
    await expect(setup.harness.events(setup.workspaceId, implementationId(setup), [event])).resolves.toMatchObject({ accepted: 1 });
    await expect(setup.harness.events(setup.workspaceId, implementationId(setup), [event])).resolves.toMatchObject({ accepted: 1 });
    const conflicting = { ...started, at: new Date(Date.now() + 1000).toISOString() };
    await expect(setup.harness.events(setup.workspaceId, implementationId(setup), [{ type: "progress", payload: { workItemProgress: conflicting } }]))
      .rejects.toThrow(/sequence was reused with different content/);
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesProgress?: unknown[] } }).workflow;
    expect(workflow.workflowDependenciesProgress).toHaveLength(1);
  });

  it("refuses new item progress after the approved graph is complete", async () => {
    const setup = await approvedGraph();
    const approval = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string } } }).workflow.workflowDependenciesApproval;
    const operationId = implementationId(setup);
    const started = { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: setup.graph.items[0]!.id,
      sequence: 1, state: "STARTED", operationId, baseTreeSha: "a".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" };
    const implemented = { ...started, sequence: 2, state: "IMPLEMENTED", candidateTreeSha: "b".repeat(40) };
    await setup.harness.events(setup.workspaceId, operationId, [
      { type: "progress", payload: { workItemProgress: started } },
      { type: "progress", payload: { workItemProgress: implemented } },
    ]);
    const extraStart = { ...started, sequence: 3, baseTreeSha: "b".repeat(40) };
    await expect(setup.harness.events(setup.workspaceId, operationId, [{ type: "progress", payload: { workItemProgress: extraStart } }]))
      .rejects.toThrow(/order/);
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesProgress?: unknown[] } }).workflow;
    expect(workflow.workflowDependenciesProgress).toHaveLength(2);
  });

  it("restarts a completed approved graph from the failed-check candidate on owner send-back", async () => {
    const setup = await approvedGraph();
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string; workflowRevision: number }; workflowDependenciesOperationId?: string } }).workflow;
    const approval = workflow.workflowDependenciesApproval;
    const firstOperationId = implementationId(setup);
    expect(workflow.workflowDependenciesOperationId).toBe(firstOperationId);
    const publicTask = await setup.harness.dev(MAYA, "GET", `/v1/dev/tasks/${setup.taskId}`);
    expect((publicTask.body.task as { workflow?: Record<string, unknown> }).workflow).not.toHaveProperty("workflowDependenciesOperationId");
    const execution = await executeSerialWorkflowDependencies({
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: firstOperationId,
      initialTreeSha: "a".repeat(40), now: () => new Date().toISOString(),
      persist: async (progress) => { await setup.harness.events(setup.workspaceId, firstOperationId, [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async () => ({ treeSha: "b".repeat(40) }),
    });
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await setup.harness.finish(setup.workspaceId, firstOperationId, "SUCCEEDED", { result: {
      workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories,
      checks: { ...passingChecks(), status: "regression", checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "failed", class: "regression", output: "failed", durationMs: 12 }] },
      workflowDependenciesResult: { schemaVersion: 1, taskId: setup.taskId, graphDigest: approval.graphDigest, runId: approval.runId,
        operationId: firstOperationId, workflowRevision: approval.workflowRevision, status: "SUCCEEDED",
        items: execution.progress.filter((entry) => entry.state === "IMPLEMENTED"), candidateDigest: candidate.digest, at: new Date().toISOString() },
    } });
    const blocked = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number; stage: string; state: string } }).workflow;
    expect(blocked).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    const requestId = randomUUID();
    const returned = await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/send-back`, {
      requestId, expectedRevision: blocked.revision, instructions: "Fix the failing check in the approved plan.",
    });
    expect(returned.status).toBe(200);
    const retryOperation = setup.operations().find((operation) => operation.requestId === requestId);
    expect(retryOperation).toBeDefined();
    const invocation = setup.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === retryOperation?.id)[0]?.invocation as {
      payload: { workflowDependencies?: { sequenceStart: number; resumeTreeSha: string; resumeProgress: WorkItemProgressV1[] } };
    };
    expect(invocation.payload.workflowDependencies).toMatchObject({ sequenceStart: 2, resumeTreeSha: "b".repeat(40), resumeProgress: [] });
    const calls: string[] = [];
    const reset = invocation.payload.workflowDependencies!;
    const resumed = await executeSerialWorkflowDependencies({
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: String(retryOperation!.id),
      initialTreeSha: reset.resumeTreeSha, sequenceStart: reset.sequenceStart, resumeProgress: reset.resumeProgress,
      now: () => new Date().toISOString(),
      persist: async (progress) => { await setup.harness.events(setup.workspaceId, String(retryOperation!.id), [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async (item) => { calls.push(item.id); return { treeSha: "c".repeat(40) }; },
    });
    expect(calls).toEqual([setup.graph.items[0]!.id]);
    expect(resumed.progress.map((entry) => entry.sequence)).toEqual([3, 4]);
  });

  it("retries only the retained prefix from the latest reset attempt after an uncertain first item", async () => {
    const setup = await approvedGraph(true, 2);
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string; workflowRevision: number } } }).workflow;
    const approval = workflow.workflowDependenciesApproval;
    const firstOperationId = implementationId(setup);
    const firstRun = await executeSerialWorkflowDependencies({
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: firstOperationId,
      initialTreeSha: "a".repeat(40), now: () => new Date().toISOString(),
      persist: async (progress) => { await setup.harness.events(setup.workspaceId, firstOperationId, [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async (item) => ({ treeSha: item.id === setup.graph.items[0]!.id ? "f".repeat(40) : "c".repeat(40) }),
    });
    const failedCandidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await setup.harness.finish(setup.workspaceId, firstOperationId, "SUCCEEDED", { result: {
      workflowCandidateRepositories: failedCandidate.repositories, workflowCheckCandidateRepositories: failedCandidate.repositories,
      checks: { ...passingChecks(), status: "regression", checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "failed", class: "regression", output: "failed", durationMs: 12 }] },
      workflowDependenciesResult: { schemaVersion: 1, taskId: setup.taskId, graphDigest: approval.graphDigest, runId: approval.runId,
        operationId: firstOperationId, workflowRevision: approval.workflowRevision, status: "SUCCEEDED",
        items: firstRun.progress.filter((entry) => entry.state === "IMPLEMENTED"), candidateDigest: failedCandidate.digest, at: new Date().toISOString() },
    } });

    const blocked = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number } }).workflow;
    const sendBackRequestId = randomUUID();
    const sendBackResponse = await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/send-back`, {
      requestId: sendBackRequestId, expectedRevision: blocked.revision, instructions: "Restart the approved graph from its current candidate.",
    });
    expect(sendBackResponse.status).toBe(200);
    const resetOperation = setup.operations().find((operation) => operation.requestId === sendBackRequestId)!;
    const resetBinding = (setup.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === resetOperation.id)[0]!.invocation as {
      payload: { workflowDependencies: { sequenceStart: number; resumeTreeSha: string; resumeProgress: WorkItemProgressV1[] } };
    }).payload.workflowDependencies;
    await expect(executeSerialWorkflowDependencies({
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: String(resetOperation.id),
      initialTreeSha: resetBinding.resumeTreeSha, sequenceStart: resetBinding.sequenceStart, resumeProgress: resetBinding.resumeProgress,
      now: () => new Date().toISOString(),
      persist: async (progress) => { await setup.harness.events(setup.workspaceId, String(resetOperation.id), [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async () => { throw new Error("first item stopped before a result"); },
    })).rejects.toThrow(/paused after an uncertain item/);
    await setup.harness.finish(setup.workspaceId, String(resetOperation.id), "FAILED", { error: "first item outcome is uncertain" });

    const retryState = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number } }).workflow;
    const retryRequestId = randomUUID();
    expect((await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/retry`, {
      requestId: retryRequestId, expectedRevision: retryState.revision, instructions: "Retry the uncertain first item.",
    })).status).toBe(200);
    const retryOperation = setup.operations().find((operation) => operation.requestId === retryRequestId)!;
    const retryBinding = (setup.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === retryOperation.id)[0]!.invocation as {
      payload: { workflowDependencies: { sequenceStart: number; resumeTreeSha: string; resumeProgress: WorkItemProgressV1[] } };
    }).payload.workflowDependencies;
    expect(retryBinding.resumeProgress.map((entry) => [entry.itemId, entry.state])).toEqual([[setup.graph.items[0]!.id, "UNKNOWN"]]);

    const calls: string[] = [];
    const resumed = await executeSerialWorkflowDependencies({
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: String(retryOperation.id),
      initialTreeSha: retryBinding.resumeTreeSha, sequenceStart: retryBinding.sequenceStart, resumeProgress: retryBinding.resumeProgress,
      now: () => new Date().toISOString(),
      persist: async (progress) => { await setup.harness.events(setup.workspaceId, String(retryOperation.id), [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async (item) => { calls.push(item.id); return { treeSha: item.id === setup.graph.items[0]!.id ? "f".repeat(40) : "c".repeat(40) }; },
    });
    expect(calls).toEqual(setup.graph.items.map((item) => item.id));
    expect(resumed.progress.filter((entry) => entry.state === "IMPLEMENTED").map((entry) => entry.itemId)).toEqual(setup.graph.items.map((item) => item.id));
  });

  it("does not qualify a reset attempt with a later item acknowledged by an older operation", async () => {
    const setup = await approvedGraph(true, 2);
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string; workflowRevision: number } } }).workflow;
    const approval = workflow.workflowDependenciesApproval;
    const firstOperationId = implementationId(setup);
    const firstRun = await executeSerialWorkflowDependencies({
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: firstOperationId,
      initialTreeSha: "a".repeat(40), now: () => new Date().toISOString(),
      persist: async (progress) => { await setup.harness.events(setup.workspaceId, firstOperationId, [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async (item) => ({ treeSha: item.id === setup.graph.items[0]!.id ? "f".repeat(40) : "c".repeat(40) }),
    });
    const failedCandidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await setup.harness.finish(setup.workspaceId, firstOperationId, "SUCCEEDED", { result: {
      workflowCandidateRepositories: failedCandidate.repositories, workflowCheckCandidateRepositories: failedCandidate.repositories,
      checks: { ...passingChecks(), status: "regression", checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "failed", class: "regression", output: "failed", durationMs: 12 }] },
      workflowDependenciesResult: { schemaVersion: 1, taskId: setup.taskId, graphDigest: approval.graphDigest, runId: approval.runId,
        operationId: firstOperationId, workflowRevision: approval.workflowRevision, status: "SUCCEEDED",
        items: firstRun.progress.filter((entry) => entry.state === "IMPLEMENTED"), candidateDigest: failedCandidate.digest, at: new Date().toISOString() },
    } });
    const blocked = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number } }).workflow;
    const resetRequestId = randomUUID();
    expect((await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/send-back`, {
      requestId: resetRequestId, expectedRevision: blocked.revision, instructions: "Restart the approved graph.",
    })).status).toBe(200);
    const resetOperation = setup.operations().find((operation) => operation.requestId === resetRequestId)!;
    const resetBinding = (setup.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === resetOperation.id)[0]!.invocation as {
      payload: { workflowDependencies: { sequenceStart: number; resumeTreeSha: string; resumeProgress: WorkItemProgressV1[] } };
    }).payload.workflowDependencies;
    let continueCalls = 0;
    await expect(executeSerialWorkflowDependencies({
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: String(resetOperation.id),
      initialTreeSha: resetBinding.resumeTreeSha, sequenceStart: resetBinding.sequenceStart, resumeProgress: resetBinding.resumeProgress,
      shouldContinue: () => ++continueCalls < 3,
      now: () => new Date().toISOString(),
      persist: async (progress) => { await setup.harness.events(setup.workspaceId, String(resetOperation.id), [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async () => ({ treeSha: "f".repeat(40) }),
    })).rejects.toThrow(/cancelled after its completion checkpoint/);
    const resetWorkflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesProgress: WorkItemProgressV1[] } }).workflow;
    const currentFirstItem = resetWorkflow.workflowDependenciesProgress.find((entry) => entry.operationId === String(resetOperation.id)
      && entry.itemId === setup.graph.items[0]!.id && entry.state === "IMPLEMENTED")!;
    expect(resetWorkflow.workflowDependenciesProgress.filter((entry) => entry.operationId === String(resetOperation.id)).map((entry) => [entry.itemId, entry.state]))
      .toEqual([[setup.graph.items[0]!.id, "STARTED"], [setup.graph.items[0]!.id, "IMPLEMENTED"]]);
    const oldSecondItem = firstRun.progress.find((entry) => entry.itemId === setup.graph.items[1]!.id && entry.state === "IMPLEMENTED")!;
    const claimedCandidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await setup.harness.finish(setup.workspaceId, String(resetOperation.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: claimedCandidate.repositories, workflowCheckCandidateRepositories: claimedCandidate.repositories, checks: passingChecks(),
      workflowDependenciesResult: { schemaVersion: 1, taskId: setup.taskId, graphDigest: approval.graphDigest, runId: approval.runId,
        operationId: String(resetOperation.id), workflowRevision: approval.workflowRevision, status: "SUCCEEDED",
        items: [currentFirstItem, oldSecondItem], candidateDigest: claimedCandidate.digest, at: new Date().toISOString() },
    } });
    const after = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { stage: string; state: string } }).workflow;
    expect(after).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(setup.operations().filter((operation) => operation.workflowMode === "REVIEW")).toEqual([]);
  });

  it("refuses a typed checkpoint when the current People authority revision changed", async () => {
    const setup = await approvedGraph();
    const approval = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string } } }).workflow.workflowDependenciesApproval;
    setup.harness.db.set({ pk: `DEVTASK#${setup.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [] });
    await expect(setup.harness.events(setup.workspaceId, implementationId(setup), [{ type: "progress", payload: {
      workItemProgress: { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: setup.graph.items[0]!.id,
        sequence: 1, state: "STARTED", operationId: implementationId(setup), baseTreeSha: "a".repeat(40),
        at: new Date().toISOString(), producer: "agentx-worker" },
    } }])).rejects.toThrow();
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesProgress?: unknown[] } }).workflow;
    expect(workflow.workflowDependenciesProgress ?? []).toEqual([]);
  });

  it("does not acknowledge graph progress after the task closes or its workspace operation is replaced", async () => {
    const closed = await approvedGraph();
    const closedTask = closed.harness.db.get(`DEVTASK#${closed.taskId}`, "META") as Record<string, unknown>;
    closed.harness.db.set({ ...closedTask, closedAt: new Date().toISOString() });
    const closedApproval = (closedTask.workflow as { workflowDependenciesApproval: { runId: string; graphDigest: string } }).workflowDependenciesApproval;
    const closedProgress = { schemaVersion: 1, graphDigest: closedApproval.graphDigest, runId: closedApproval.runId,
      itemId: closed.graph.items[0]!.id, sequence: 1, state: "STARTED", operationId: implementationId(closed),
      baseTreeSha: "a".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" };
    await expect(closed.harness.events(closed.workspaceId, implementationId(closed), [{ type: "progress", payload: { workItemProgress: closedProgress } }]))
      .rejects.toThrow();
    expect(((closed.harness.db.get(`DEVTASK#${closed.taskId}`, "META") as { workflow: { workflowDependenciesProgress?: unknown[] } }).workflow.workflowDependenciesProgress ?? [])).toEqual([]);

    const replaced = await approvedGraph();
    const replacedTask = replaced.harness.db.get(`DEVTASK#${replaced.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string } } };
    const workspace = replaced.harness.db.get(`WORKSPACE#${replaced.workspaceId}`, "META") as Record<string, unknown>;
    replaced.harness.db.set({ ...workspace, activeOperationId: randomUUID() });
    const approval = replacedTask.workflow.workflowDependenciesApproval;
    const progress = { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId,
      itemId: replaced.graph.items[0]!.id, sequence: 1, state: "STARTED", operationId: implementationId(replaced),
      baseTreeSha: "a".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" };
    await expect(replaced.harness.events(replaced.workspaceId, implementationId(replaced), [{ type: "progress", payload: { workItemProgress: progress } }]))
      .rejects.toThrow();
    expect(((replaced.harness.db.get(`DEVTASK#${replaced.taskId}`, "META") as { workflow: { workflowDependenciesProgress?: unknown[] } }).workflow.workflowDependenciesProgress ?? [])).toEqual([]);
  });

  it("rejects final graph success when the last acknowledged tree differs from the actual candidate", async () => {
    const setup = await approvedGraph();
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string; workflowRevision: number } } }).workflow;
    const approval = workflow.workflowDependenciesApproval;
    const progress = { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: setup.graph.items[0]!.id,
      sequence: 2, state: "IMPLEMENTED", operationId: implementationId(setup), baseTreeSha: "a".repeat(40), candidateTreeSha: "9".repeat(40),
      at: new Date().toISOString(), producer: "agentx-worker" };
    const accepted = await setup.harness.events(setup.workspaceId, implementationId(setup), [
      { type: "progress", payload: { workItemProgress: { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: setup.graph.items[0]!.id,
        sequence: 1, state: "STARTED", operationId: implementationId(setup), baseTreeSha: "a".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" } } },
      { type: "progress", payload: { workItemProgress: progress } },
    ]);
    expect(accepted).toMatchObject({ accepted: 2 });
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await setup.harness.finish(setup.workspaceId, implementationId(setup), "SUCCEEDED", { result: {
      workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks(),
      workflowDependenciesResult: { schemaVersion: 1, taskId: setup.taskId, graphDigest: approval.graphDigest, runId: approval.runId,
        operationId: implementationId(setup), workflowRevision: approval.workflowRevision, status: "SUCCEEDED", items: [progress],
        candidateDigest: candidate.digest, at: new Date().toISOString() },
    } });
    const after = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { stage: string; state: string; workflowDependenciesProgress?: unknown[] } }).workflow;
    expect(after).toMatchObject({ state: "BLOCKED" });
    expect(after.workflowDependenciesProgress).toHaveLength(2);
    expect(setup.operations().filter((item) => item.workflowMode === "REVIEW")).toEqual([]);
  });

  it("retries an acknowledged uncertain item from the retained tree and sequence", async () => {
    const setup = await approvedGraph();
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string; workflowRevision: number } } }).workflow;
    const approval = workflow.workflowDependenciesApproval;
    const generated: unknown[] = [];
    await expect(executeSerialWorkflowDependencies({
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: implementationId(setup),
      initialTreeSha: "a".repeat(40), now: () => new Date().toISOString(),
      persist: async (progress) => {
        generated.push(progress);
        await setup.harness.events(setup.workspaceId, implementationId(setup), [{ type: "progress", payload: { workItemProgress: progress } }]);
      },
      execute: async () => { throw new Error("worker stopped before an item result"); },
    })).rejects.toThrow(/paused after an uncertain item/);
    await setup.harness.finish(setup.workspaceId, implementationId(setup), "INTERRUPTED", { error: "worker process was replaced" });
    const blocked = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number; workflowDependenciesProgress: Array<{ state: string; sequence: number }> } }).workflow;
    expect(generated.map((entry) => (entry as { state: string }).state)).toEqual(["STARTED", "UNKNOWN"]);
    expect(blocked.workflowDependenciesProgress.map((entry) => entry.state)).toEqual(["STARTED", "UNKNOWN"]);
    const retried = await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/retry`, {
      requestId: randomUUID(), expectedRevision: blocked.revision, instructions: "Resume the retained item",
    });
    expect(retried.status).toBe(200);
    const retryOperation = setup.operations().find((operation) => operation.workflowMode === "IMPLEMENT" && operation.id !== implementationId(setup));
    expect(retryOperation).toBeDefined();
    const invocation = setup.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === retryOperation?.id)[0]?.invocation as {
      payload: { workflowDependencies?: { sequenceStart: number; resumeTreeSha: string; resumeProgress: Array<{ itemId: string; state: string }> } };
    };
    expect(invocation.payload.workflowDependencies).toMatchObject({ sequenceStart: 2, resumeTreeSha: "a".repeat(40),
      resumeProgress: [{ itemId: setup.graph.items[0]!.id, state: "UNKNOWN" }] });
  });

  it("keeps the approved graph on review-finding FIX and starts it from the reviewed candidate", async () => {
    const setup = await approvedGraph();
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string; workflowRevision: number } } }).workflow;
    const approval = workflow.workflowDependenciesApproval;
    const execution = await executeSerialWorkflowDependencies({
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: implementationId(setup),
      initialTreeSha: "a".repeat(40), now: () => new Date().toISOString(),
      persist: async (progress) => { await setup.harness.events(setup.workspaceId, implementationId(setup), [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async () => ({ treeSha: "a".repeat(40) }),
    });
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "a".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await setup.harness.finish(setup.workspaceId, implementationId(setup), "SUCCEEDED", { result: {
      workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks(),
      workflowDependenciesResult: { schemaVersion: 1, taskId: setup.taskId, graphDigest: approval.graphDigest, runId: approval.runId,
        operationId: implementationId(setup), workflowRevision: approval.workflowRevision, status: "SUCCEEDED",
        items: execution.progress.filter((entry) => entry.state === "IMPLEMENTED"), candidateDigest: candidate.digest, at: new Date().toISOString() },
    } });
    const review = setup.operations().find((operation) => operation.workflowMode === "REVIEW");
    if (review === undefined) throw new Error("review operation missing");
    const finding = { text: "The parser drops a line", origin: "INTRODUCED", severity: "HIGH", file: "parse.ts", line: 1 };
    await setup.harness.finish(setup.workspaceId, String(review.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: candidate.repositories,
      workflowReviews: [
        { operationId: String(review.id), candidateDigest: candidate.digest, role: "CRITIC", provider: "test", version: "1", status: "FINDINGS", findings: [finding], readOnly: true, recordedAt: new Date().toISOString() },
        { operationId: String(review.id), candidateDigest: candidate.digest, role: "SECURITY", provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: new Date().toISOString() },
      ],
    } });
    const before = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number; candidate: { digest: string } } }).workflow;
    const response = await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/review-findings`, {
      requestId: randomUUID(), expectedRevision: before.revision, candidateDigest: before.candidate.digest,
      resolutions: [{ findingId: workflowFindingFingerprint("CRITIC", finding), action: "FIX", note: "Keep the parser output" }],
    });
    expect(response.status).toBe(200);
    const retryOperation = setup.operations().find((operation) => operation.workflowMode === "IMPLEMENT" && operation.id !== implementationId(setup));
    expect(retryOperation).toBeDefined();
    expect(retryOperation?.workflowDependencies).toMatchObject({ approval: { graphDigest: approval.graphDigest }, resumeTreeSha: "a".repeat(40), sequenceStart: 2, resumeProgress: [] });
    const invocation = setup.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === retryOperation?.id)[0]?.invocation as {
      payload: { workflowDependencies?: { graph: { taskId: string } } };
    };
    expect(invocation.payload.workflowDependencies?.graph.taskId).toBe(setup.taskId);
  });

  it("retries a zero-checkpoint reset from its own empty retained prefix", async () => {
    const setup = await approvedGraph(true, 2);
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string; workflowRevision: number }; workflowDependenciesOperationId?: string; revision: number } }).workflow;
    const approval = workflow.workflowDependenciesApproval;
    const firstOperationId = implementationId(setup);
    const initialRun = await executeSerialWorkflowDependencies({
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: firstOperationId,
      initialTreeSha: "a".repeat(40), now: () => new Date().toISOString(),
      persist: async (progress) => { await setup.harness.events(setup.workspaceId, firstOperationId, [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async (item) => ({ treeSha: item.id === setup.graph.items[0]!.id ? "f".repeat(40) : "b".repeat(40) }),
    });
    const failedCheckCandidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await setup.harness.finish(setup.workspaceId, firstOperationId, "SUCCEEDED", { result: {
      workflowCandidateRepositories: failedCheckCandidate.repositories, workflowCheckCandidateRepositories: failedCheckCandidate.repositories,
      checks: { ...passingChecks(), status: "regression", checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "failed", class: "regression", output: "failed", durationMs: 12 }] },
      workflowDependenciesResult: { schemaVersion: 1, taskId: setup.taskId, graphDigest: approval.graphDigest, runId: approval.runId,
        operationId: firstOperationId, workflowRevision: approval.workflowRevision, status: "SUCCEEDED",
        items: initialRun.progress.filter((entry) => entry.state === "IMPLEMENTED"), candidateDigest: failedCheckCandidate.digest, at: new Date().toISOString() },
    } });
    const blocked = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number } }).workflow;
    const sendBackRequestId = randomUUID();
    expect((await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/send-back`, {
      requestId: sendBackRequestId, expectedRevision: blocked.revision, instructions: "Correct the implementation.",
    })).status).toBe(200);
    const resetOperation = setup.operations().find((operation) => operation.requestId === sendBackRequestId);
    expect(resetOperation).toBeDefined();
    expect(((setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesOperationId?: string } }).workflow.workflowDependenciesOperationId))
      .toBe(resetOperation?.id);
    const resetInvocation = setup.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === resetOperation?.id)[0]?.invocation as {
      payload: { workflowDependencies: { resumeTreeSha: string; sequenceStart: number; resumeProgress: WorkItemProgressV1[] } };
    };
    expect(resetInvocation.payload.workflowDependencies).toMatchObject({ resumeTreeSha: "b".repeat(40), sequenceStart: 4, resumeProgress: [] });
    await setup.harness.finish(setup.workspaceId, String(resetOperation?.id), "FAILED", { error: "worker failed before first graph checkpoint" });

    const resetRecord = setup.operations().find((operation) => operation.id === resetOperation?.id);
    if (resetRecord === undefined) throw new Error("reset operation record missing");
    setup.harness.db.set({ ...resetRecord, status: "RUNNING" });
    const stillActive = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number } }).workflow;
    const activeRetry = await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/retry`, {
      requestId: randomUUID(), expectedRevision: stillActive.revision, instructions: "Do not retry an active attempt.",
    });
    expect(activeRetry.status).toBe(400);
    expect(setup.operations().filter((operation) => operation.workflowMode === "IMPLEMENT")).toHaveLength(2);
    setup.harness.db.set({ ...resetRecord, status: "FAILED" });

    const currentTask = setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number; workflowDependenciesOperationId?: string }; [key: string]: unknown };
    const { workflowDependenciesOperationId: _missingPointer, ...workflowWithoutPointer } = currentTask.workflow;
    void _missingPointer;
    setup.harness.db.set({ ...currentTask, workflow: workflowWithoutPointer });
    const missingPointerRetry = await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/retry`, {
      requestId: randomUUID(), expectedRevision: currentTask.workflow.revision, instructions: "Do not fall back without the current attempt pointer.",
    });
    expect(missingPointerRetry.status).toBe(400);
    expect(setup.operations().filter((operation) => operation.workflowMode === "IMPLEMENT")).toHaveLength(2);
    setup.harness.db.set({ ...currentTask, workflow: { ...workflowWithoutPointer, workflowDependenciesOperationId: String(resetOperation?.id) } });

    const failedReset = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number } }).workflow;
    const retryRequestId = randomUUID();
    expect((await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/retry`, {
      requestId: retryRequestId, expectedRevision: failedReset.revision, instructions: "Retry the current correction.",
    })).status).toBe(200);
    const retryOperation = setup.operations().find((operation) => operation.requestId === retryRequestId);
    expect(retryOperation).toBeDefined();
    expect(((setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesOperationId?: string } }).workflow.workflowDependenciesOperationId))
      .toBe(retryOperation?.id);
    const retryInvocation = setup.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === retryOperation?.id)[0]?.invocation as {
      payload: { workflowDependencies: { graph: typeof setup.graph; approval: typeof approval; resumeTreeSha: string; sequenceStart: number; resumeProgress: WorkItemProgressV1[] } };
    };
    const binding = retryInvocation.payload.workflowDependencies;
    expect(binding).toMatchObject({ resumeTreeSha: "b".repeat(40), sequenceStart: 4, resumeProgress: [] });
    const calls: string[] = [];
    const resumed = await executeSerialWorkflowDependencies({
      graph: binding.graph, graphDigest: binding.approval.graphDigest, runId: binding.approval.runId, operationId: String(retryOperation?.id),
      initialTreeSha: binding.resumeTreeSha, sequenceStart: binding.sequenceStart, resumeProgress: binding.resumeProgress,
      now: () => new Date().toISOString(), persist: async () => {},
      execute: async (item) => { calls.push(item.id); return { treeSha: "c".repeat(40) }; },
    });
    expect(calls).toEqual(setup.graph.items.map((item) => item.id));
    expect(resumed.progress.filter((entry) => entry.state === "IMPLEMENTED").map((entry) => entry.itemId)).toEqual(setup.graph.items.map((item) => item.id));
  });
});
