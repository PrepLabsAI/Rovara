import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, requestWorkflowFeedback } from "../../packages/contracts/src/task-workflow.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

describe("native developer task workflow", () => {
  it("leaves the established task entry point unchanged unless workflow was requested", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", {
      requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client",
    });
    const task = response.body.task as { taskId: string; workflow?: unknown };
    expect(task).not.toHaveProperty("workflow");
    expect(harness.db.get(`DEVTASK#${task.taskId}`, "META")).not.toHaveProperty("workflow");
  });

  it("runs Full requirements, design, and coding-plan reviews before implementation", async () => {
    const harness = await createDeveloperTaskBroker();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", {
      requestId: randomUUID(), project: "payments", instructions: "Add password reset", client: "test-client", workflow: true, workflowPath: "FULL",
    });
    const task = started.body.task as { taskId: string; workflow: { path: string; reviewPhase: string; revision: number } };
    expect(task.workflow).toMatchObject({ path: "FULL", reviewPhase: "REQUIREMENTS" });
    const workspaceId = String(harness.db.get(`DEVTASK#${task.taskId}`, "META")?.workspaceId);
    const finishPhase = async (content: string, phase: string, nextPhase?: string) => {
      const operations = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
      const active = operations.find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED");
      expect(active).toBeDefined();
      await harness.artifact(workspaceId, String(active?.id), "plan.md", content);
      await harness.finish(workspaceId, String(active?.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
      const waiting = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body.task as { workflow: { revision: number; reviewPhase: string; artifacts: Array<{ sha256: string }> } };
      expect(waiting.workflow.reviewPhase).toBe(phase);
      const digest = createHash("sha256").update(content).digest("hex");
      await harness.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/workflow/decision`, {
        requestId: randomUUID(), expectedRevision: waiting.workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest,
      });
      const saved = harness.db.get(`DEVTASK#${task.taskId}`, "META")?.workflow as { reviewPhase?: string; stage: string; state: string };
      if (nextPhase !== undefined) expect(saved).toMatchObject({ reviewPhase: nextPhase, stage: "PLAN", state: "RUNNING" });
      else expect(saved).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    };
    const prepare = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.kind === "prepare");
    await harness.finish(workspaceId, String(prepare?.id), "SUCCEEDED");
    await finishPhase("Goal: Add password reset. Scope: account page.", "REQUIREMENTS", "DESIGN");
    await finishPhase("Approach: tokenized reset link with expiration.", "DESIGN", "IMPLEMENTATION_PLAN");
    await finishPhase("1. Add reset request UI. 2. Add expiry test.", "IMPLEMENTATION_PLAN");
    const implementation = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.workflowMode === "IMPLEMENT");
    expect(implementation).toBeDefined();
  });

  it("stores a control-plane-digested plan and only queues implementation after owner approval", async () => {
    const harness = await createDeveloperTaskBroker();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", {
      requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true,
    });
    const task = started.body.task as { taskId: string; workflow: { stage: string; state: string; revision: number } };
    expect(task.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING", revision: 1 });

    const workspaceId = String(harness.db.get(`DEVTASK#${task.taskId}`, "META")?.workspaceId);
    const prepare = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.kind === "prepare");
    expect(prepare).toBeDefined();
    await harness.finish(workspaceId, String(prepare?.id), "SUCCEEDED");
    const planning = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.kind === "task");
    expect(planning?.workflowMode).toBe("PLAN");
    expect((harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === planning?.id)[0]?.invocation as { payload?: { workflowMode?: string } }).payload?.workflowMode).toBe("PLAN");

    const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
    await harness.artifact(workspaceId, String(planning?.id), "plan.md", plan);
    await harness.finish(workspaceId, String(planning?.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const waiting = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body.task as { workflow: { stage: string; state: string; revision: number; planContent?: string; artifacts: Array<{ sha256: string }> } };
    const digest = createHash("sha256").update(plan).digest("hex");
    expect(waiting.workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", revision: 2, artifacts: [{ sha256: digest }] });
    expect(waiting.workflow.planContent).toBe(plan);

    expect((await harness.dev(OMAR, "POST", `/v1/dev/tasks/${task.taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: waiting.workflow.revision, decision: "APPROVE", reason: "Not the owner", artifactDigest: digest,
    })).status).toBe(404);
    expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/continue`, { requestId: randomUUID(), instructions: "Skip planning" })).body.error).toMatchObject({ code: "WORKSPACE_BUSY" });
    expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: waiting.workflow.revision, decision: "APPROVE", reason: "Stale plan", artifactDigest: "f".repeat(64),
    })).body.error).toMatchObject({ code: "CONFIG_INVALID" });

    const decision = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: waiting.workflow.revision, decision: "APPROVE", reason: "Plan reviewed", artifactDigest: digest,
    });
    expect(decision.status).toBe(200);
    expect((decision.body.task as { workflow: { stage: string; state: string } }).workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    const implementation = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.workflowMode === "IMPLEMENT");
    expect(implementation).toBeDefined();

    const replay = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/workflow/decision`, {
      requestId: String((harness.db.get(`DEVTASK#${task.taskId}`, "META")?.workflow as { decisions: Array<{ requestId: string }> }).decisions[0]?.requestId),
      expectedRevision: waiting.workflow.revision, decision: "APPROVE", reason: "Plan reviewed", artifactDigest: digest,
    });
    expect(replay.status).toBe(200);
    expect(harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").filter((item) => item.workflowMode === "IMPLEMENT")).toHaveLength(1);
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    await harness.finish(workspaceId, String(implementation?.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: candidate.repositories,
      workflowCheckCandidateRepositories: candidate.repositories,
      checks: { status: "verified", source: "agent_commands", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "agent:0", label: "npm test", source: "agent_commands", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" },
      workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ candidateDigest: candidate.digest, role, provider: "test-model", version: "test-model-v1", status: "PASS", findings: [], readOnly: true, recordedAt: "2026-10-05T12:00:00.000Z" })),
    } });
    const verifiedCandidate = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body.task as { workflow: { stage: string; state: string; candidate?: { digest: string }; verification?: { candidateDigest: string; results: Array<{ status: string }> }; reviews?: Array<{ role: string; candidateDigest: string }> } };
    expect(verifiedCandidate.workflow).toMatchObject({ stage: "REVIEW", state: "WAITING", candidate: { digest: candidate.digest }, verification: { candidateDigest: candidate.digest, results: [{ status: "PASS" }] } });
    const reviewStart = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/workflow/review`, { requestId: randomUUID(), instructions: "Check for edge cases and security issues." });
    expect(reviewStart.status).toBe(200);
    const reviewOperation = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.workflowMode === "REVIEW") as { id?: string; workflowMode?: string } | undefined;
    expect(reviewOperation).toBeDefined();
    await harness.finish(workspaceId, String(reviewOperation?.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: candidate.repositories,
      workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: reviewOperation?.id, candidateDigest: candidate.digest, role, provider: "test-model", version: "test-model-v1", status: "PASS", findings: [], readOnly: true, recordedAt: "2026-10-05T12:00:00.000Z" })),
    } });
    const reviewComplete = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body.task as { workflow: { stage: string; state: string; candidate?: { digest: string }; reviews?: Array<{ operationId: string; role: string; candidateDigest: string }> } };
    expect(reviewComplete.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY", candidate: { digest: candidate.digest }, reviews: [{ operationId: reviewOperation?.id, candidateDigest: candidate.digest }, { operationId: reviewOperation?.id, candidateDigest: candidate.digest }] });
    const pullRequest = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/pull-requests`, { requestId: randomUUID(), title: "Fix retry" });
    expect(pullRequest.status).toBe(200);
    expect(pullRequest.body).toHaveProperty("operationId");
    const publication = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.id === pullRequest.body.operationId) as { id?: string; publication?: { headBranch?: string } } | undefined;
    await harness.finish(workspaceId, String(publication?.id), "SUCCEEDED", { result: {
      repository: "demo", number: 42, url: "https://github.com/example/demo/pull/42",
      headBranch: publication?.publication?.headBranch, baseBranch: "main", commit: "d".repeat(40), checks: [], reconciled: false,
    } });
    expect(harness.db.get("GITHUB_PR#example/demo", "PR#0000000042")).toMatchObject({
      entityType: "GITHUB_WORKFLOW_PR", taskId: task.taskId, workspaceId, repositoryId: "demo", number: 42,
      repositoryFullName: "example/demo", candidateDigest: candidate.digest,
    });
    const waitingForMerge = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body.task as { workflow: { stage: string; state: string; pullRequests?: Array<{ repositoryId: string; number: number; state: string }> } };
    expect(waitingForMerge.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", pullRequests: [{ repositoryId: "demo", number: 42, state: "UNKNOWN" }] });

    const taskRecord = harness.db.get(`DEVTASK#${task.taskId}`, "META")!;
    const feedbackWorkflow = requestWorkflowFeedback(taskRecord.workflow, {
      feedbackId: "e".repeat(64), repositoryId: "demo", number: 42, candidateDigest: candidate.digest,
      comments: [{ id: "9876", url: "https://github.com/example/demo/pull/42#discussion_r9876", author: "reviewer", body: "Handle the empty-input case" }],
      proposedPlan: "Review the comment in context, update code, and rerun required checks and reviews.",
    }, "2026-10-05T12:10:00.000Z");
    harness.db.set({ ...taskRecord, workflow: feedbackWorkflow });
    expect((await harness.dev(OMAR, "POST", `/v1/dev/tasks/${task.taskId}/workflow/feedback-decision`, {
      requestId: randomUUID(), expectedRevision: feedbackWorkflow.revision, candidateDigest: candidate.digest,
      feedbackId: "e".repeat(64), decision: "APPROVE",
    })).status).toBe(404);
    const approvedFeedback = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/workflow/feedback-decision`, {
      requestId: randomUUID(), expectedRevision: feedbackWorkflow.revision, candidateDigest: candidate.digest,
      feedbackId: "e".repeat(64), decision: "APPROVE",
    });
    expect(approvedFeedback.status).toBe(200);
    expect((approvedFeedback.body.task as { workflow: { stage: string; state: string; feedback: { status: string } } }).workflow)
      .toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", feedback: { status: "APPROVED" } });
    const feedbackOperation = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.workflowMode === "IMPLEMENT" && item.id !== implementation?.id);
    expect(feedbackOperation).toBeDefined();
    const feedbackInvocation = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === feedbackOperation?.id)[0]?.invocation as { payload?: { prompt?: string } };
    expect(feedbackInvocation.payload?.prompt).toContain("Handle the empty-input case");
    expect(feedbackInvocation.payload?.prompt).toContain("Do not reply to GitHub");
  });

  it("blocks verification when the code checked differs from the final candidate", async () => {
    const harness = await createDeveloperTaskBroker();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", {
      requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true,
    });
    const task = started.body.task as { taskId: string };
    const workspaceId = String(harness.db.get(`DEVTASK#${task.taskId}`, "META")?.workspaceId);
    const prepare = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.kind === "prepare");
    await harness.finish(workspaceId, String(prepare?.id), "SUCCEEDED");
    const planning = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.kind === "task");
    const plan = "# Plan\n\nFix retry handling and add a regression test.\n";
    await harness.artifact(workspaceId, String(planning?.id), "plan.md", plan);
    await harness.finish(workspaceId, String(planning?.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const waiting = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body.task as { workflow: { revision: number; artifacts: Array<{ sha256: string }> } };
    const digest = createHash("sha256").update(plan).digest("hex");
    await harness.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: waiting.workflow.revision, decision: "APPROVE", reason: "Proceed", artifactDigest: digest,
    });
    const implementation = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.workflowMode === "IMPLEMENT");
    const checked = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const changedAfterCheck = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "c".repeat(40) }]);
    await harness.finish(workspaceId, String(implementation?.id), "SUCCEEDED", { result: {
      workflowCandidateRepositories: changedAfterCheck.repositories,
      workflowCheckCandidateRepositories: checked.repositories,
      checks: { status: "verified", source: "agent_commands", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "agent:0", label: "npm test", source: "agent_commands", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" },
      workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ candidateDigest: changedAfterCheck.digest, role, provider: "test-model", version: "test-model-v1", status: "PASS", findings: [], readOnly: true, recordedAt: "2026-10-05T12:00:00.000Z" })),
    } });
    const result = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body.task as { workflow: { stage: string; state: string; blockReason?: string; verification?: unknown } };
    expect(result.workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: "implementation finished without complete candidate-bound check evidence" });
    expect(result.workflow).not.toHaveProperty("verification");
  });

  it("keeps an interrupted plan blocked and requires a new read-only planning run to recover", async () => {
    const harness = await createDeveloperTaskBroker();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", {
      requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true,
    });
    const task = started.body.task as { taskId: string };
    const workspaceId = String(harness.db.get(`DEVTASK#${task.taskId}`, "META")?.workspaceId);
    const prepare = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.kind === "prepare");
    await harness.finish(workspaceId, String(prepare?.id), "SUCCEEDED");
    const planning = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find((item) => item.kind === "task");
    await harness.finish(workspaceId, String(planning?.id), "INTERRUPTED", { error: "worker stopped" });

    const blocked = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`)).body.task as { workflow: { state: string; stage: string; revision: number } };
    expect(blocked.workflow).toMatchObject({ state: "BLOCKED", stage: "PLAN" });
    const retry = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${task.taskId}/workflow/retry`, {
      requestId: randomUUID(), instructions: "Please plan the retry fix again, read-only.",
    });
    expect(retry.status).toBe(200);
    expect((retry.body.task as { workflow: { state: string; stage: string } }).workflow).toMatchObject({ state: "RUNNING", stage: "PLAN" });
    expect(harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").filter((item) => item.workflowMode === "PLAN")).toHaveLength(2);
  });
});
