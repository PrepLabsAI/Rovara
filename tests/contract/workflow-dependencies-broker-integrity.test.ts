import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCandidateManifest, workflowFindingFingerprint } from "../../packages/contracts/src/task-workflow.js";
import { taskGraphDigest } from "../../packages/contracts/src/workflow-dependencies.js";
import { executeSerialWorkflowDependencies } from "../../packages/worker/src/workflow-dependencies.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64),
  checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }],
  extraTry: "not_needed", agentClaim: "success" });

async function approvedGraph(includeGraphDigest = true) {
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
  const graph = { schemaVersion: 1 as const, taskId, version: 1, items: [
    { id: "11111111-1111-4111-8111-111111111111", title: "Implement", description: "Implement the change", repository: "demo", dependsOn: [] },
  ] };
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
      itemId: setup.graph.items[0]!.id, sequence: 1, state: "STARTED", operationId: String(setup.implementation.id),
      baseTreeSha: "a".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" };
    const invalid = [
      { ...good, graphDigest: "0".repeat(64) }, { ...good, runId: randomUUID() }, { ...good, itemId: randomUUID() },
      { ...good, sequence: 99 }, { ...good, operationId: randomUUID() },
    ];
    for (const workItemProgress of invalid) {
      await expect(setup.harness.events(setup.workspaceId, String(setup.implementation.id), [{ type: "progress", payload: { workItemProgress } }]))
        .rejects.toThrow();
    }
    expect((setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesProgress?: unknown[] } }).workflow.workflowDependenciesProgress ?? []).toEqual([]);
  });

  it("accepts an identical acknowledged progress replay and refuses conflicting content at the same sequence", async () => {
    const setup = await approvedGraph();
    const approval = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string } } }).workflow.workflowDependenciesApproval;
    const started = { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: setup.graph.items[0]!.id,
      sequence: 1, state: "STARTED", operationId: String(setup.implementation.id), baseTreeSha: "a".repeat(40),
      at: new Date().toISOString(), producer: "agentx-worker" };
    const event = { type: "progress", payload: { workItemProgress: started } };
    await expect(setup.harness.events(setup.workspaceId, String(setup.implementation.id), [event])).resolves.toMatchObject({ accepted: 1 });
    await expect(setup.harness.events(setup.workspaceId, String(setup.implementation.id), [event])).resolves.toMatchObject({ accepted: 1 });
    const conflicting = { ...started, at: new Date(Date.now() + 1000).toISOString() };
    await expect(setup.harness.events(setup.workspaceId, String(setup.implementation.id), [{ type: "progress", payload: { workItemProgress: conflicting } }]))
      .rejects.toThrow(/sequence was reused with different content/);
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesProgress?: unknown[] } }).workflow;
    expect(workflow.workflowDependenciesProgress).toHaveLength(1);
  });

  it("refuses a typed checkpoint when the current People authority revision changed", async () => {
    const setup = await approvedGraph();
    const approval = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string } } }).workflow.workflowDependenciesApproval;
    setup.harness.db.set({ pk: `DEVTASK#${setup.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [] });
    await expect(setup.harness.events(setup.workspaceId, String(setup.implementation.id), [{ type: "progress", payload: {
      workItemProgress: { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: setup.graph.items[0]!.id,
        sequence: 1, state: "STARTED", operationId: String(setup.implementation.id), baseTreeSha: "a".repeat(40),
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
      itemId: closed.graph.items[0]!.id, sequence: 1, state: "STARTED", operationId: String(closed.implementation.id),
      baseTreeSha: "a".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" };
    await expect(closed.harness.events(closed.workspaceId, String(closed.implementation.id), [{ type: "progress", payload: { workItemProgress: closedProgress } }]))
      .rejects.toThrow();
    expect(((closed.harness.db.get(`DEVTASK#${closed.taskId}`, "META") as { workflow: { workflowDependenciesProgress?: unknown[] } }).workflow.workflowDependenciesProgress ?? [])).toEqual([]);

    const replaced = await approvedGraph();
    const replacedTask = replaced.harness.db.get(`DEVTASK#${replaced.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string } } };
    const workspace = replaced.harness.db.get(`WORKSPACE#${replaced.workspaceId}`, "META") as Record<string, unknown>;
    replaced.harness.db.set({ ...workspace, activeOperationId: randomUUID() });
    const approval = replacedTask.workflow.workflowDependenciesApproval;
    const progress = { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId,
      itemId: replaced.graph.items[0]!.id, sequence: 1, state: "STARTED", operationId: String(replaced.implementation.id),
      baseTreeSha: "a".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" };
    await expect(replaced.harness.events(replaced.workspaceId, String(replaced.implementation.id), [{ type: "progress", payload: { workItemProgress: progress } }]))
      .rejects.toThrow();
    expect(((replaced.harness.db.get(`DEVTASK#${replaced.taskId}`, "META") as { workflow: { workflowDependenciesProgress?: unknown[] } }).workflow.workflowDependenciesProgress ?? [])).toEqual([]);
  });

  it("rejects final graph success when the last acknowledged tree differs from the actual candidate", async () => {
    const setup = await approvedGraph();
    const workflow = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { workflowDependenciesApproval: { runId: string; graphDigest: string; workflowRevision: number } } }).workflow;
    const approval = workflow.workflowDependenciesApproval;
    const progress = { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: setup.graph.items[0]!.id,
      sequence: 2, state: "IMPLEMENTED", operationId: String(setup.implementation.id), baseTreeSha: "a".repeat(40), candidateTreeSha: "9".repeat(40),
      at: new Date().toISOString(), producer: "agentx-worker" };
    const accepted = await setup.harness.events(setup.workspaceId, String(setup.implementation.id), [
      { type: "progress", payload: { workItemProgress: { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: setup.graph.items[0]!.id,
        sequence: 1, state: "STARTED", operationId: String(setup.implementation.id), baseTreeSha: "a".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" } } },
      { type: "progress", payload: { workItemProgress: progress } },
    ]);
    expect(accepted).toMatchObject({ accepted: 2 });
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await setup.harness.finish(setup.workspaceId, String(setup.implementation.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks(),
      workflowDependenciesResult: { schemaVersion: 1, taskId: setup.taskId, graphDigest: approval.graphDigest, runId: approval.runId,
        operationId: String(setup.implementation.id), workflowRevision: approval.workflowRevision, status: "SUCCEEDED", items: [progress],
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
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: String(setup.implementation.id),
      initialTreeSha: "a".repeat(40), now: () => new Date().toISOString(),
      persist: async (progress) => {
        generated.push(progress);
        await setup.harness.events(setup.workspaceId, String(setup.implementation.id), [{ type: "progress", payload: { workItemProgress: progress } }]);
      },
      execute: async () => { throw new Error("worker stopped before an item result"); },
    })).rejects.toThrow(/paused after an uncertain item/);
    await setup.harness.finish(setup.workspaceId, String(setup.implementation.id), "INTERRUPTED", { error: "worker process was replaced" });
    const blocked = (setup.harness.db.get(`DEVTASK#${setup.taskId}`, "META") as { workflow: { revision: number; workflowDependenciesProgress: Array<{ state: string; sequence: number }> } }).workflow;
    expect(generated.map((entry) => (entry as { state: string }).state)).toEqual(["STARTED", "UNKNOWN"]);
    expect(blocked.workflowDependenciesProgress.map((entry) => entry.state)).toEqual(["STARTED", "UNKNOWN"]);
    const retried = await setup.harness.dev(MAYA, "POST", `/v1/dev/tasks/${setup.taskId}/workflow/retry`, {
      requestId: randomUUID(), expectedRevision: blocked.revision, instructions: "Resume the retained item",
    });
    expect(retried.status).toBe(200);
    const retryOperation = setup.operations().find((operation) => operation.workflowMode === "IMPLEMENT" && operation.id !== setup.implementation.id);
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
      graph: setup.graph, graphDigest: approval.graphDigest, runId: approval.runId, operationId: String(setup.implementation.id),
      initialTreeSha: "a".repeat(40), now: () => new Date().toISOString(),
      persist: async (progress) => { await setup.harness.events(setup.workspaceId, String(setup.implementation.id), [{ type: "progress", payload: { workItemProgress: progress } }]); },
      execute: async () => ({ treeSha: "a".repeat(40) }),
    });
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "a".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await setup.harness.finish(setup.workspaceId, String(setup.implementation.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks(),
      workflowDependenciesResult: { schemaVersion: 1, taskId: setup.taskId, graphDigest: approval.graphDigest, runId: approval.runId,
        operationId: String(setup.implementation.id), workflowRevision: approval.workflowRevision, status: "SUCCEEDED",
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
    const retryOperation = setup.operations().find((operation) => operation.workflowMode === "IMPLEMENT" && operation.id !== setup.implementation.id);
    expect(retryOperation).toBeDefined();
    expect(retryOperation?.workflowDependencies).toMatchObject({ approval: { graphDigest: approval.graphDigest }, resumeTreeSha: "a".repeat(40), sequenceStart: 2, resumeProgress: [] });
    const invocation = setup.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === retryOperation?.id)[0]?.invocation as {
      payload: { workflowDependencies?: { graph: { taskId: string } } };
    };
    expect(invocation.payload.workflowDependencies?.graph.taskId).toBe(setup.taskId);
  });
});
