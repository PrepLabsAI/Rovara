import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, requestWorkflowFeedback } from "../../packages/contracts/src/task-workflow.js";
import { collectWorkflowFeedbackBundles, createWorkflowSnapshot, sharedTaskKey, WorkflowFeedbackBundleSchema, WorkflowSnapshotSchema } from "@agentx/contracts";
import { developerTaskIdentity } from "../../packages/broker/src/developer/task-records.js";
import { githubWorkflowPullRequestKey } from "../../packages/broker/src/developer/task-records.js";
import { startTaskWorkflowFeedbackReviewFromWebhook } from "../../packages/broker/src/aws/developer-tasks.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

describe("native developer task workflow", () => {
  it("launches one feedback critic from current collection, limits its reads, and stores only an advisory report", async () => {
    const currentFeedback = { pullRequest: { number: 7, url: "https://github.com/example/demo/pull/7", state: "open" as const,
      headBranch: "feature", baseBranch: "main", headCommit: "a".repeat(40), title: "Fix retry", body: "" }, comments: [], threads: [] };
    const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: { getPullRequestFeedback: async () => currentFeedback } } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", {
      requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true,
    });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = String(harness.db.get(`DEVTASK#${taskId}`, "META")?.workspaceId);
    const prepare = harness.db.find(item => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find(item => item.kind === "prepare");
    await harness.finish(workspaceId, String(prepare?.id), "SUCCEEDED");
    const planOperation = harness.db.find(item => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION").find(item => item.workflowMode === "PLAN");
    await harness.finish(workspaceId, String(planOperation?.id), "FAILED", { error: "test setup advances the workspace to READY" });
    const task = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { developerId: string; provider: "slack"; developerName: string; client: string; ownerKey: string; workspaceId: string; conversationId: string };
    const workspace = harness.db.get(`WORKSPACE#${workspaceId}`, "META") as Record<string, unknown>;
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const now = new Date().toISOString();
    const planContent = "Approved plan: address the linked PR feedback after owner approval.";
    const planSha = createHash("sha256").update(planContent).digest("hex");
    const planKey = `private/${task.ownerKey}/${workspaceId}/approved-plan.md`;
    harness.s3.objects.set(planKey, planContent);
    let workflow = WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId, ownerId: task.ownerKey, now }),
      stage: "WAIT_FOR_MERGE", state: "WAITING", candidate,
      artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: planSha, producer: "agentx-owner-approved", objectKey: planKey, createdAt: now }],
      decisions: [{ requestId: randomUUID(), workflowRevision: 1, decision: "APPROVE", actorId: task.ownerKey, actorRole: "TASK_OWNER", reason: "Approved plan", artifactDigest: planSha, at: now }],
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: workspaceId, recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map(role => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
      pullRequests: [{ repositoryId: "demo", number: 7, url: "https://github.com/example/demo/pull/7", candidateDigest: candidate.digest, required: true, state: "OPEN" }],
    });
    const commentSetDigest = createHash("sha256").update("[]").digest("hex");
    const bundle = WorkflowFeedbackBundleSchema.parse({ schemaVersion: 1, taskId, repositoryId: "demo", number: 7,
      headSha: "a".repeat(40), candidateDigest: candidate.digest, commentSetDigest, producer: "agentx-github-reconciler", version: "1", recordedAt: now,
      comments: [], sourceDeliveryIds: ["delivery-test"] });
    const bundleBytes = JSON.stringify(bundle);
    const bundleDigest = createHash("sha256").update(bundleBytes).digest("hex");
    const bundleKey = `private/${task.ownerKey}/${workspaceId}/feedback/${bundleDigest}.json`;
    harness.s3.objects.set(bundleKey, bundleBytes);
    const { sourceDeliveryIds: _deliveryIds, comments, ...metadata } = bundle;
    const bundleRef = { ...metadata, sha256: bundleDigest, objectKey: bundleKey, comments };
    workflow = collectWorkflowFeedbackBundles(workflow, { bundleRefs: [bundleRef], threadObservations: [] }, now);
    harness.db.set({ ...task, workflow, updatedAt: now });
    const routeDeps = { documentClient: harness.db, tableName: "state", actions: harness.actions,
      checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [] }),
      projectChannelIds: async () => [], now: () => Date.parse(now) };
    expect(await startTaskWorkflowFeedbackReviewFromWebhook(routeDeps as never, taskId)).toBe(true);
    // A duplicate delivery or stale callback sees RUNNING and cannot enqueue a second critic.
    expect(await startTaskWorkflowFeedbackReviewFromWebhook(routeDeps as never, taskId)).toBe(false);
    const accepted = { operation: harness.db.find(item => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION")
      .find(item => item.workflowMode === "FEEDBACK_REVIEW")! };
    expect(accepted.operation).toBeDefined();
    expect(harness.db.find(item => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION")
      .filter(item => item.workflowMode === "FEEDBACK_REVIEW")).toHaveLength(1);
    const binding = accepted.operation.workflowFeedbackReview as { taskId: string; workflowRevision: number; candidateDigest: string };
    const readBundles = (input: Record<string, unknown>) => harness.callback(workspaceId, accepted.operation.id, "feedback-bundles", input);
    await expect(readBundles({ ...binding, taskId: randomUUID() })).rejects.toThrow();
    await expect(readBundles({ ...binding, workflowRevision: binding.workflowRevision + 1 })).rejects.toThrow();
    await expect(readBundles({ ...binding, candidateDigest: "f".repeat(64) })).rejects.toThrow();
    await expect(readBundles({ ...binding, objectKey: bundleKey })).rejects.toThrow();
    await expect(readBundles({ ...binding, bundleDigest: "f".repeat(64) })).rejects.toThrow();
    const material = await readBundles(binding) as { taskRequirements: string; bundles: Array<{ ref: { sha256: string }; bytesBase64: string }> };
    expect(material.taskRequirements).toContain("Approved plan");
    expect(material.bundles).toEqual([{ ref: expect.objectContaining({ sha256: bundleDigest }), bytesBase64: Buffer.from(bundleBytes).toString("base64") }]);
    harness.s3.objects.set(bundleKey, bundleBytes + "tampered");
    await expect(readBundles(binding)).rejects.toThrow();
    harness.s3.objects.set(bundleKey, bundleBytes);

    const requirementsDigest = createHash("sha256").update(material.taskRequirements).digest("hex");
    const candidateBinding = { repositoryId: "demo", number: 7, headSha: "a".repeat(40), candidateDigest: candidate.digest, commentSetDigest, bundleDigest };
    const findingRefs: never[] = [];
    const output = JSON.stringify({ schemaVersion: 1, taskId, workflowRevision: binding.workflowRevision, operationMode: "FEEDBACK_REVIEW",
      qualification: "AI_GENERATED_ADVISORY", proposalDigest: "c".repeat(64), taskRequirementsDigest: requirementsDigest,
      candidateBindings: [candidateBinding], operationId: accepted.operation.id, provider: "test", version: "1",
      status: "COMPLETE", bundleDigests: [bundleDigest], findingRefs, findings: [], recordedAt: now });
    const outputDigest = createHash("sha256").update(output).digest("hex");
    const artifactName = `workflow-feedback-review-${outputDigest}.json`;
    await harness.artifact(workspaceId, accepted.operation.id, artifactName, output);
    await harness.finish(workspaceId, accepted.operation.id, "SUCCEEDED", { result: { workflowFeedbackReviewResult: {
      ...binding, outputDigest, artifactName, status: "COMPLETE",
    } } });
    const saved = harness.db.get(`DEVTASK#${taskId}`, "META")?.workflow as Record<string, unknown>;
    expect(saved).toMatchObject({ state: "WAITING", feedbackReview: { status: "PENDING", reviewRef: { operationId: accepted.operation.id, sha256: outputDigest } } });
    expect(saved).not.toMatchObject({ feedbackReview: { decision: "APPROVE" } });

    const slackThread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
    harness.db.set({ ...task, slackUserId: MAYA.slackUserId, share: slackThread, workflow: saved });
    harness.db.set({ ...sharedTaskKey(slackThread), entityType: "SHARED_TASK", taskId, workspaceId,
      ownerKey: task.ownerKey, developerId: task.developerId, mode: "FULL", createdAt: now });
    harness.db.set({ ...githubWorkflowPullRequestKey("example/demo", 7), entityType: "GITHUB_WORKFLOW_PR",
      repositoryFullName: "example/demo", number: 7, repositoryId: "demo", taskId, workspaceId,
      candidateDigest: candidate.digest, url: "https://github.com/example/demo/pull/7" });
    const reply = { thread: slackThread, userId: MAYA.slackUserId!, eventId: "Ev01ABC", messageTs: "1695500002.000001", text: "Please explain the edge case." };
    const slackReplyEvent = { source: "agentx.slack-ingress", action: "feedback-note", taskId, ...reply };
    const captured = await harness.handler(slackReplyEvent);
    expect(JSON.parse(String(captured.body))).toMatchObject({ captured: true });
    const duplicate = await harness.handler(slackReplyEvent);
    expect(JSON.parse(String(duplicate.body))).toMatchObject({ captured: true, duplicate: true });
    const afterReply = harness.db.get(`DEVTASK#${taskId}`, "META")?.workflow as Record<string, unknown>;
    expect(afterReply.feedbackNotes).toMatchObject([{ source: "THREAD_REPLY", sourceId: "Ev01ABC", text: reply.text,
      slack: { teamId: slackThread.teamId, channelId: slackThread.channelId, threadTs: slackThread.threadTs,
        userId: MAYA.slackUserId, messageTs: reply.messageTs, eventId: "Ev01ABC" } }]);
    expect(afterReply.feedbackDecisions).toBeUndefined();
    expect((await harness.handler({ ...slackReplyEvent, userId: "U0OTHER001" })).statusCode).toBe(403);
    expect((await harness.handler({ ...slackReplyEvent,
      thread: { ...slackThread, threadTs: "1695500000.000009" }, eventId: "Ev01DEF" })).statusCode).toBe(403);

    const currentReview = afterReply.feedbackReview as { reviewRef: { sha256: string; proposalDigest: string }; bundleRefs: Array<{ sha256: string }> };
    const bundleDigests = currentReview.bundleRefs.map(bundle => bundle.sha256);
    const decisionRequestId = randomUUID();
    const decisionResponse = await harness.handler({ source: "agentx.slack-ingress", action: "workflow-feedback-findings-decision",
      taskId, userId: MAYA.slackUserId, thread: slackThread, requestId: decisionRequestId,
      expectedRevision: afterReply.revision, reviewDigest: currentReview.reviewRef.sha256,
      proposalDigest: currentReview.reviewRef.proposalDigest,
      bundleSetDigest: createHash("sha256").update(JSON.stringify(bundleDigests), "utf8").digest("hex"),
      selection: "RECOMMENDED", decision: "REQUEST_CHANGES", ownerNote: "Please explain the recommendation." });
    expect(decisionResponse.statusCode).toBe(200);
    const decided = harness.db.get(`DEVTASK#${taskId}`, "META")?.workflow as Record<string, unknown>;
    expect(decided).toMatchObject({ feedbackReview: { status: "CHANGES_REQUESTED" },
      feedbackDecisions: [{ requestId: decisionRequestId, decision: "REQUEST_CHANGES", actorRole: "TASK_OWNER", ownerNote: "Please explain the recommendation." }] });
    expect(decided.state).toBe("WAITING");

    await expect(readBundles(binding)).rejects.toThrow();

    const ordinary = await harness.actions.acceptTask(developerTaskIdentity(task as never), workspaceId,
      { requestId: randomUUID(), conversationId: task.conversationId, prompt: "ordinary task operation" }, () => []);
    await expect(harness.callback(workspaceId, ordinary.operation.id, "feedback-bundles", binding)).rejects.toThrow();
  });

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
