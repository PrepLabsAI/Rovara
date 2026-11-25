import { z } from "zod";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WorkerInvocationSchema, agentXError, taskGraphDigest, workflowPublicationContext, workflowPublicationContextDigest, type Ec2RuntimeBinding, type WorkerInvocation } from "../../packages/contracts/src/index.js";
import { createDispatcherHandler, workerPingFeatures } from "../../packages/broker/src/aws/dispatcher.js";
import { guardTaskDispatch as coreGuardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { MACHINE_FALLBACK_MESSAGES, createEc2Delivery, type Ec2Delivery, type Ec2DeliveryDependencies } from "../../packages/broker/src/aws/ec2-delivery.js";
import { planDocumentInstructions } from "../../packages/broker/src/aws/broker-shared.js";
import type { DurableOutboxRecord, Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { verifyInvokeAuthorization, invocationMatchesClaims, invokePublicKey } from "../../packages/worker/src/invoke-auth.js";
import { COMPANY_A, createSessionMachinesWorld } from "../support/session-machines-world.js";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
// What KMS Sign returns for ECDSA_SHA_256 on an ECC_NIST_P256 key: a DER signature over the message.
const kmsSign = async (message: Uint8Array) => new Uint8Array(sign("sha256", message, keys.privateKey));
const binding: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs" as const,
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
  volumeSizeGiB: 20,
  volumeType: "gp3" as const,
};

function recordFor(workspaceId = randomUUID(), fence = 2): Ec2OutboxRecord {
  const operationId = randomUUID();
  const invocation: WorkerInvocation = {
    protocolVersion: 1, kind: "resume", operationId, workspaceId, fence, projectRevision: 1, callbackCapability: "c".repeat(64), payload: {},
  };
  return { id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId, deploymentMode: "ec2-ebs" as const, invocation };
}

function delivery(overrides: Partial<Ec2DeliveryDependencies> = {}, without: ReadonlyArray<keyof Ec2DeliveryDependencies> = []) {
  const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{\"accepted\":true}" }));
  const progress = vi.fn<Ec2DeliveryDependencies["progress"]>(async () => undefined);
  const dependencies: Ec2DeliveryDependencies = {
    sessions: { ensureSession: async () => ({ ready: true, generation: 3, privateIp: "10.42.128.10" }) },
    binding: async () => binding,
    sign: kmsSign,
    post,
    progress,
    verifyMachine: async () => ({ ok: true }),
    failOperation: async () => undefined,
    now: () => NOW,
    ...overrides,
  };
  for (const key of without) delete dependencies[key];
  const deliver = createEc2Delivery(dependencies);
  return { deliver, post, progress };
}


describe("ec2-ebs delivery", () => {
  it("rechecks task access after compute is ready and parks before signing or POST", async () => {
    const signInvocation = vi.fn(kmsSign);
    const { deliver, post } = delivery({
      sign: signInvocation,
      guardTaskDispatch: async () => "PARKED",
    });
    const record = recordFor();

    await expect(deliver(record, record.invocation)).resolves.toBe("WAITING_FOR_TASK_ACCESS");
    expect(signInvocation).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("creates a fresh task guard after readiness and after ping with current Lambda time", async () => {
    const guardTaskDispatch = vi.fn<NonNullable<Ec2DeliveryDependencies["guardTaskDispatch"]>>(async () => "ALLOWED");
    const { deliver } = delivery({ guardTaskDispatch });
    const record = recordFor();
    let remaining = 15_000;

    await expect(deliver(record, record.invocation, { remainingTimeMs: () => remaining-- })).resolves.toBe("DELIVERED");
    expect(guardTaskDispatch).toHaveBeenCalledTimes(2);
    expect(typeof guardTaskDispatch.mock.calls[0]?.[1]?.remainingTimeMs).toBe("function");
    expect(typeof guardTaskDispatch.mock.calls[1]?.[1]?.remainingTimeMs).toBe("function");
  });

  it("posts the invocation to the worker with a token the worker's own verifier accepts", async () => {
    const { deliver, post } = delivery();
    const record = recordFor();
    expect(await deliver(record, record.invocation)).toBe("DELIVERED");
    const [url, init] = post.mock.calls[0]!;
    expect(url).toBe("http://10.42.128.10:8080/invocations");
    expect(JSON.parse(init.body)).toEqual(record.invocation);
    const verified = verifyInvokeAuthorization(init.authorization, {
      publicKey: keys.publicKey, workspaceId: record.workspaceId, generation: 3, now: () => Math.floor(NOW / 1_000),
    });
    expect(verified).toMatchObject({ ok: true, claims: { generation: 3, operationId: record.operationId, fence: 2, expiresAt: Math.floor(NOW / 1_000) + 60 } });
    expect(verified.ok && invocationMatchesClaims(record.invocation, verified.claims)).toBe(true);
    // A minute later the same token is refused.
    expect(verifyInvokeAuthorization(init.authorization, {
      publicKey: keys.publicKey, workspaceId: record.workspaceId, generation: 3, now: () => Math.floor(NOW / 1_000) + 60,
    })).toEqual({ ok: false, reason: "expired" });
  });

  describe("the task's readiness and workers built before it (spec 051)", () => {
    const readiness = [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 300 }];
    function taskRecord(payload: Record<string, unknown>): Ec2OutboxRecord {
      const record = recordFor();
      const invocation = {
        ...record.invocation,
        kind: "task",
        payload: { conversationId: randomUUID(), prompt: "test it", ...payload },
      } as WorkerInvocation;
      const context = workflowPublicationContext(invocation);
      if (context !== undefined && invocation.kind === "publish") invocation.payload.publicationContextDigest = workflowPublicationContextDigest(context);
      return { ...record, invocation };
    }
    const postedPayload = (post: ReturnType<typeof delivery>["post"]) => (JSON.parse(post.mock.calls[0]![1].body) as { payload: Record<string, unknown> }).payload;

    it("refuses feedback-approved implementation before POST unless the worker advertises approval authorization", async () => {
      const { deliver, post } = delivery({ workerFeatures: async () => ["task.workflowMode"] });
      const approval = {
        taskId: randomUUID(), requestId: randomUUID(), ownerId: "owner-1",
        decisionWorkflowRevision: 4, activeWorkflowRevision: 5,
        reviewDigest: "a".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["c".repeat(64)],
        candidateDigest: "d".repeat(64), selectedFindingIds: ["finding-1"], selectedCommentIds: ["comment-1"],
      };
      const record = taskRecord({ workflowMode: "IMPLEMENT", workflowFeedbackApproval: approval });

      await expect(deliver(record, record.invocation)).rejects.toThrow(/feedback approval requires a compatible worker/);
      expect(post).not.toHaveBeenCalled();
    });

    it("refuses a pinned task base before POST unless the worker advertises it", async () => {
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const refused = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowReview"] });
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase });
      await expect(refused.deliver(record, record.invocation)).rejects.toThrow(/workflow reviews need a worker that receives the task's pinned base commit/);
      expect(refused.post).not.toHaveBeenCalled();

      const accepted = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowReview", "task.workflowBase"] });
      expect(await accepted.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(accepted.post).workflowBase).toEqual(workflowBase);
    });

    it("tells reviewers which checks ran only on a worker that lists it; an older worker reviews without that note", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const workflowReviewChecks = { reviewOnly: false, checks: [{ label: "Unit tests", command: "npm test (in repo/demo)" }] };
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase, workflowReviewChecks });
      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowReview", "task.workflowBase", "task.workflowReviewChecks"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowReviewChecks).toEqual(workflowReviewChecks);
      const older = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowReview", "task.workflowBase"] });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowReviewChecks");
      expect(postedPayload(older.post).workflowBase).toEqual(workflowBase);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.review_checks_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("gives reviewers the approved plan only on a worker that lists it; an older worker reviews without it and keeps the other fields", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const workflowReviewChecks = { reviewOnly: false, checks: [{ label: "Unit tests", command: "npm test (in repo/demo)" }] };
      const workflowReviewPlan = { markdown: "# Plan\n\nDo the thing.", sha256: "b".repeat(64) };
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase, workflowReviewChecks, workflowReviewPlan });
      const base = ["task.workflowMode", "task.workflowReview", "task.workflowBase", "task.workflowReviewChecks"];
      const capable = delivery({ workerFeatures: async () => [...base, "task.workflowReviewPlan"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowReviewPlan).toEqual(workflowReviewPlan);
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowReviewPlan");
      expect(postedPayload(older.post).workflowReviewChecks).toEqual(workflowReviewChecks);
      expect(postedPayload(older.post).workflowBase).toEqual(workflowBase);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.review_plan_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("gives reviewers the owner's approved PR feedback only on a worker that lists it; an older worker reviews without it and keeps the plan", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const workflowReviewPlan = { markdown: "# Plan\n\nDo the thing.", sha256: "b".repeat(64) };
      const workflowReviewFeedback = [{ summary: "Use the shorter sentence.", fileChanges: [{ repositoryId: "demo", path: "README.md", change: "Shorten it." }] }];
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase, workflowReviewPlan, workflowReviewFeedback });
      const base = ["task.workflowMode", "task.workflowReview", "task.workflowBase", "task.workflowReviewPlan"];
      const capable = delivery({ workerFeatures: async () => [...base, "task.workflowReviewFeedback"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowReviewFeedback).toEqual(workflowReviewFeedback);
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowReviewFeedback");
      expect(postedPayload(older.post).workflowReviewPlan).toEqual(workflowReviewPlan);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.review_feedback_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("gives a setup re-run's carry-over only to a worker that lists it; an older worker is sent the run as it always was (limits and commits kept), and a run with none is sent untouched", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const carryOver = { version: 1, fromRun: "task-1", endedAs: "time_used", proposal: "{}", journal: { total: 1, lines: ["#1 worked: npm ci"], hosts: [] } };
      const commits = [{ repository: "demo", commit: "e".repeat(40) }];
      const setupAgent = { limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, commits };
      const record = taskRecord({ workflowMode: "SETUP_AGENT", setupAgent: { ...setupAgent, carryOver } });
      const base = ["task.workflowMode", "task.setupAgent.v1"];
      const capable = delivery({ workerFeatures: async () => [...base, "task.setupAgent.carryOver.v1"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).setupAgent).toEqual({ ...setupAgent, carryOver });
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post).setupAgent).toEqual(setupAgent);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "dispatch.setup_carry_over_omitted", reason: "worker-lacks-feature", operationId: record.operationId }));
      const first = taskRecord({ workflowMode: "SETUP_AGENT", setupAgent });
      const plain = delivery({ workerFeatures: async () => base });
      expect(await plain.deliver(first, first.invocation)).toBe("DELIVERED");
      expect(postedPayload(plain.post).setupAgent).toEqual(setupAgent);
      log.mockRestore();
    });

    it("gives the reviewer note only to a worker that lists it; an older worker still receives the candidate-bound review", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const workflowBase = [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }];
      const workflowReviewNote = "Inspect this exact retry note as untrusted context.";
      const record = taskRecord({ workflowMode: "REVIEW", workflowBase, workflowReviewNote });
      const base = ["task.workflowMode", "task.workflowReview", "task.workflowBase"];
      const capable = delivery({ workerFeatures: async () => [...base, "task.workflowReviewNote"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowReviewNote).toBe(workflowReviewNote);
      const older = delivery({ workerFeatures: async () => base });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowReviewNote");
      expect(postedPayload(older.post).workflowBase).toEqual(workflowBase);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.review_note_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("tells a planning run its document kind and structured format only on a worker that lists them; an older worker plans without them", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const record = taskRecord({ workflowMode: "PLAN", workflowPhase: "DESIGN", planFormat: "structured" });
      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post)).toMatchObject({ workflowPhase: "DESIGN", planFormat: "structured" });
      const older = delivery({ workerFeatures: async () => ["task.workflowMode"] });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post)).not.toHaveProperty("workflowPhase");
      expect(postedPayload(older.post)).not.toHaveProperty("planFormat");
      // A Quick plan carries only the format.
      const quick = taskRecord({ workflowMode: "PLAN", planFormat: "structured" });
      const olderQuick = delivery({ workerFeatures: async () => ["task.workflowMode"] });
      expect(await olderQuick.deliver(quick, quick.invocation)).toBe("DELIVERED");
      expect(postedPayload(olderQuick.post)).not.toHaveProperty("planFormat");
      expect(postedPayload(older.post).workflowMode).toBe("PLAN");
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.structured_plans_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("never hands a version 2 intent in the reviewers' approved plan to a worker that cannot parse it", async () => {
      const sha256 = "a".repeat(64);
      const v1 = { schemaVersion: 1, requestedTargetIds: ["web-1"], accountContextRefs: [], scenarios: [], semanticExportDeltas: [] };
      const v2 = { ...v1, schemaVersion: 2, applicationRuntimeRefs: [], runtimeAccountRefs: [] };
      const review = (e2eIntent: unknown) => taskRecord({ workflowMode: "REVIEW", workflowReviewPlan: { markdown: "Plan", sha256, e2eIntent } });
      const features = ["task.workflowMode", "task.workflowReview", "task.workflowReviewPlan"];
      const older = delivery({ workerFeatures: async () => features });
      const withV2 = review(v2);
      expect(await older.deliver(withV2, withV2.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post).workflowReviewPlan).toEqual({ markdown: "Plan", sha256 });
      const capable = delivery({ workerFeatures: async () => [...features, "task.workflowE2EApplicationPlan"] });
      expect(await capable.deliver(withV2, withV2.invocation)).toBe("DELIVERED");
      expect((postedPayload(capable.post).workflowReviewPlan as { e2eIntent: unknown }).e2eIntent).toEqual(v2);
      // A v1 intent is carried exactly as before, whatever the worker advertises.
      const withV1 = review(v1);
      const olderV1 = delivery({ workerFeatures: async () => features });
      expect(await olderV1.deliver(withV1, withV1.invocation)).toBe("DELIVERED");
      expect((postedPayload(olderV1.post).workflowReviewPlan as { e2eIntent: unknown }).e2eIntent).toEqual(v1);
    });

    it("asks a planning run for anchor lines only on a worker that lists task.codeAnchors; an older worker is sent the prompt without them", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const anchored = planDocumentInstructions({ kind: "plan", path: "QUICK", anchors: true });
      const plain = planDocumentInstructions({ kind: "plan", path: "QUICK" });
      const record = taskRecord({ workflowMode: "PLAN", planFormat: "structured", prompt: `Planning phase only.\n\n${anchored}\n\nRequest:\nadd it` });
      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans", "task.codeAnchors"] });
      expect(await capable.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(capable.post).prompt).toContain("anchor?: string");
      const older = delivery({ workerFeatures: async () => ["task.workflowMode", "task.structuredPlans"] });
      expect(await older.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(older.post).prompt).toBe(`Planning phase only.\n\n${plain}\n\nRequest:\nadd it`);
      expect(postedPayload(older.post)).toMatchObject({ planFormat: "structured" });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.code_anchors_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("refuses a graph-aware invocation when the worker does not advertise the exact feature and never strips the graph", async () => {
      const graph = { schemaVersion: 1 as const, taskId: "8c330a74-b4c6-4f01-9356-5fe54fc55b19", version: 1, items: [
        { id: "11111111-1111-4111-8111-111111111111", title: "One", description: "First.", repository: "repo", dependsOn: [] },
      ] };
      const workflowDependencies = { graph, approval: {
        artifactDigest: "a".repeat(64), graphDigest: taskGraphDigest(graph), workflowRevision: 2,
        actorId: "b".repeat(64), runId: "8c330a74-b4c6-4f01-9356-5fe54fc55b21",
      } };
      const record = taskRecord({ workflowMode: "IMPLEMENT", workflowDependencies });
      const older = delivery({ workerFeatures: async () => ["task.workflowMode"] });
      await expect(older.deliver(record, record.invocation)).rejects.toThrow(/ordered work requires a compatible worker/);
      expect(older.post).not.toHaveBeenCalled();

      const capable = delivery({ workerFeatures: async () => ["task.workflowMode", "task.workflowDependencies"] });
      await expect(capable.deliver(record, record.invocation)).resolves.toBe("DELIVERED");
      expect(postedPayload(capable.post).workflowDependencies).toEqual(workflowDependencies);
    });

    it("drops the readiness when the dispatcher has no way to ask the worker", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { deliver, post } = delivery();
      const record = taskRecord({ readiness });
      await deliver(record, record.invocation);
      expect(postedPayload(post)).not.toHaveProperty("readiness");
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "dispatch.readiness_omitted", reason: "no-probe" }));
      log.mockRestore();
    });

  });

  describe("publish's reportChecks and workers built before it (spec 051, D-7)", () => {
    function publishRecord(payload: Record<string, unknown>): Ec2OutboxRecord {
      const record = recordFor();
      const operationId = record.invocation.operationId;
      const invocation: WorkerInvocation = {
        ...record.invocation,
        kind: "publish",
        payload: {
          mode: "create",
          project: {
            name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
            repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
          },
          repository: "demo", title: "t", headBranch: `agentx/${operationId}`, repositoryGrant: "g", ...payload,
        },
      };
      const context = workflowPublicationContext(invocation);
      if (context !== undefined && invocation.kind === "publish") invocation.payload.publicationContextDigest = workflowPublicationContextDigest(context);
      return { ...record, invocation };
    }
    const postedPayload = (post: ReturnType<typeof delivery>["post"]) => (JSON.parse(post.mock.calls[0]![1].body) as { payload: Record<string, unknown> }).payload;

    it("refuses a publication bound to a checked tree before POST unless the worker advertises it, and never drops the tree", async () => {
      const record = publishRecord({ candidateTreeSha: "b".repeat(40), publicationMode: "CHECKED_TREE" });
      const refused = delivery({ workerFeatures: async () => ["publish.reportChecks"] });
      await expect(refused.deliver(record, record.invocation)).rejects.toThrow(/publishes exactly the checked tree/);
      expect(refused.post).not.toHaveBeenCalled();
      const unprobed = delivery();
      await expect(unprobed.deliver(record, record.invocation)).rejects.toThrow(/publishes exactly the checked tree/);
      expect(unprobed.post).not.toHaveBeenCalled();

      const missingMode = delivery({ workerFeatures: async () => ["publish.candidateTree"] });
      await expect(missingMode.deliver(record, record.invocation)).rejects.toThrow(/authenticates the broker-selected publication mode/);
      expect(missingMode.post).not.toHaveBeenCalled();

      const accepted = delivery({ workerFeatures: async () => ["publish.candidateTree", "publish.mode", "publish.contextDigest"] });
      expect(await accepted.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(accepted.post).candidateTreeSha).toBe("b".repeat(40));
      expect(postedPayload(accepted.post).publicationMode).toBe("CHECKED_TREE");
    });

    it("refuses a reviewed fix for a pull request before POST unless the worker advertises pushing it", async () => {
      const record = recordFor();
      const invocation = { ...record.invocation, kind: "maintain", payload: {
        action: "append", project: { name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
          repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }] },
        repository: "demo", pullRequestNumber: 42, headBranch: `agentx/${randomUUID()}`, baseBranch: "main", expectedHeadCommit: "d".repeat(40), repositoryGrant: "g",
        workflowCandidateTreeSha: "b".repeat(40), workflowBaseCommit: "e".repeat(40),
      } } as WorkerInvocation;
      const fix = { ...record, invocation };
      const refused = delivery({ workerFeatures: async () => ["publish.candidateTree", "publish.workflowBase"] });
      await expect(refused.deliver(fix, fix.invocation)).rejects.toThrow(/pushing a reviewed fix needs a worker that pushes exactly the reviewed tree/);
      expect(refused.post).not.toHaveBeenCalled();
      const accepted = delivery({ workerFeatures: async () => ["task.workflowPullRequestUpdate"] });
      expect(await accepted.deliver(fix, fix.invocation)).toBe("DELIVERED");
      expect(postedPayload(accepted.post)).toMatchObject({ workflowCandidateTreeSha: "b".repeat(40), workflowBaseCommit: "e".repeat(40) });
    });

    it("refuses a publication carrying the task's pinned base before POST unless the worker advertises it, and never drops it", async () => {
      const record = publishRecord({ candidateTreeSha: "b".repeat(40), publicationMode: "CHECKED_TREE", workflowBaseCommit: "c".repeat(40) });
      const refused = delivery({ workerFeatures: async () => ["publish.candidateTree", "publish.mode", "publish.contextDigest"] });
      await expect(refused.deliver(record, record.invocation)).rejects.toThrow(/task's pinned base commit/);
      expect(refused.post).not.toHaveBeenCalled();
      const accepted = delivery({ workerFeatures: async () => ["publish.candidateTree", "publish.mode", "publish.contextDigest", "publish.workflowBase"] });
      expect(await accepted.deliver(record, record.invocation)).toBe("DELIVERED");
      expect(postedPayload(accepted.post).workflowBaseCommit).toBe("c".repeat(40));
    });

    it("drops reportChecks for a worker built before it, which then refuses a failing check as before", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { deliver, post } = delivery({ workerFeatures: async () => ["model.thinkingLevel", "task.readiness"] });
      const record = publishRecord({ reportChecks: true });
      await deliver(record, record.invocation);
      expect(postedPayload(post)).not.toHaveProperty("reportChecks");
      expect(WorkerInvocationSchema.safeParse({ ...record.invocation, payload: postedPayload(post) }).success).toBe(true);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.report_checks_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
      }));
      log.mockRestore();
    });

  });

  describe("the thinking level and workers built before it (spec 053)", () => {
    function taskRecord(model: Record<string, unknown>): Ec2OutboxRecord {
      const record = recordFor();
      const invocation = {
        ...record.invocation,
        kind: "task",
        payload: { conversationId: randomUUID(), prompt: "test it", model },
      } as WorkerInvocation;
      return { ...record, invocation };
    }
    const leveled = { provider: "amazon-bedrock", modelId: "fast", thinkingLevel: "low" };
    const posted = (post: ReturnType<typeof delivery>["post"]) => (JSON.parse(post.mock.calls[0]![1].body) as { payload: { model: Record<string, unknown> } }).payload.model;

    it("drops only the level for a worker whose /ping lists no features, and keeps the token valid", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { deliver, post } = delivery({ workerFeatures: async () => [] });
      const record = taskRecord(leveled);
      expect(await deliver(record, record.invocation)).toBe("DELIVERED");
      const model = posted(post);
      expect(model).toEqual({ provider: "amazon-bedrock", modelId: "fast" });
      expect(Object.keys(model)).not.toContain("thinkingLevel");
      const body = JSON.parse(post.mock.calls[0]![1].body) as WorkerInvocation;
      const verified = verifyInvokeAuthorization(post.mock.calls[0]![1].authorization, {
        publicKey: keys.publicKey, workspaceId: record.workspaceId, generation: 3, now: () => Math.floor(NOW / 1_000),
      });
      expect(verified.ok && invocationMatchesClaims(body, verified.claims)).toBe(true);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        event: "dispatch.thinking_level_omitted", reason: "worker-lacks-feature", requestedThinkingLevel: "low", operationId: record.operationId,
      }));
      log.mockRestore();
    });

    it("reads the features from the worker's /ping body: none from a worker built before them, or a malformed field", async () => {
      const ping = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
      await expect(workerPingFeatures("http://10.42.128.10:8080/ping", ping({ status: "Healthy", activeOperations: 0 }))).resolves.toEqual([]);
      await expect(workerPingFeatures("http://w/ping", ping({ status: "Healthy", invocationFeatures: "model.thinkingLevel" }))).resolves.toEqual([]);
      await expect(workerPingFeatures("http://w/ping", ping({ status: "Healthy", invocationFeatures: ["model.thinkingLevel", 7] }))).resolves.toEqual(["model.thinkingLevel"]);
      await expect(workerPingFeatures("http://w/ping", ping(null))).resolves.toEqual([]);
      const unreachable = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
      await expect(workerPingFeatures("http://w/ping", unreachable)).rejects.toThrow("fetch failed");
    });

    it("fails the attempt when the worker's /ping answers with a non-2xx status", async () => {
      const ping = vi.fn(async () => new Response(JSON.stringify({ status: "Unhealthy", invocationFeatures: [] }), { status: 503 })) as unknown as typeof fetch;
      await expect(workerPingFeatures("http://w/ping", ping)).rejects.toThrow(/HTTP 503/);
      const redirect = vi.fn(async () => new Response("{}", { status: 302 })) as unknown as typeof fetch;
      await expect(workerPingFeatures("http://w/ping", redirect)).rejects.toThrow(/HTTP 302/);
    });

    describe("a project definition carried by prepare, publish and maintain", () => {
      const models = {
        default: { provider: "amazon-bedrock", modelId: "fast", thinkingLevel: "low", label: "Fast" },
        approved: [
          { provider: "amazon-bedrock", modelId: "fast", thinkingLevel: "low", label: "Fast" },
          { provider: "openrouter", modelId: "z-ai/glm-5.3" },
        ],
      };
      const unleveledModels = {
        default: { provider: "amazon-bedrock", modelId: "fast", label: "Fast" },
        approved: [
          { provider: "amazon-bedrock", modelId: "fast", label: "Fast" },
          { provider: "openrouter", modelId: "z-ai/glm-5.3" },
        ],
      };
      function projectWith(projectModels: unknown) {
        return {
          name: "payments",
          revision: 1,
          repositories: [{ name: "api", url: "https://git.example.test/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "api-readwrite" }],
          setup: [],
          readiness: [],
          orchestratorInstructions: "Delegate coding to the remote worker.",
          ...(projectModels === undefined ? {} : { models: projectModels }),
        };
      }
      function projectRecord(kind: "prepare" | "publish" | "maintain", projectModels: unknown): Ec2OutboxRecord {
        const record = recordFor();
        const payload = kind === "prepare"
          ? { project: projectWith(projectModels), repositoryGrant: "signed-grant" }
          : kind === "publish"
            ? {
              project: projectWith(projectModels), repository: "api", title: "Fix it", headBranch: `agentx/${randomUUID()}`,
              repositoryGrant: "signed-grant", mode: "create",
            }
            : {
              action: "sync", project: projectWith(projectModels), repository: "api", pullRequestNumber: 7,
              headBranch: `agentx/${randomUUID()}`, baseBranch: "main", expectedHeadCommit: "a".repeat(40), repositoryGrant: "signed-grant",
            };
        return { ...record, invocation: { ...record.invocation, kind, payload } as unknown as WorkerInvocation };
      }
      const postedModels = (post: ReturnType<typeof delivery>["post"]) =>
        (JSON.parse(post.mock.calls[0]![1].body) as { payload: { project: { models?: unknown } } }).payload.project.models;

      for (const kind of ["prepare", "publish", "maintain"] as const) {
        it(`${kind}: keeps every level for a worker whose /ping lists the feature`, async () => {
          const workerFeatures = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => ["model.thinkingLevel"]);
          const { deliver, post } = delivery({ workerFeatures });
          const record = projectRecord(kind, models);
          expect(await deliver(record, record.invocation)).toBe("DELIVERED");
          expect(workerFeatures).toHaveBeenCalledExactlyOnceWith("http://10.42.128.10:8080/ping");
          expect(JSON.parse(post.mock.calls[0]![1].body)).toEqual(record.invocation);
        });

        it(`${kind}: strips only the levels for a worker built before them, and keeps the token valid`, async () => {
          const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
          const { deliver, post } = delivery({ workerFeatures: async () => [] });
          const record = projectRecord(kind, models);
          expect(await deliver(record, record.invocation)).toBe("DELIVERED");
          expect(postedModels(post)).toEqual(unleveledModels);
          const body = JSON.parse(post.mock.calls[0]![1].body) as WorkerInvocation;
          const sentPayload = record.invocation.payload as { project: Record<string, unknown> };
          expect(body).toEqual({ ...record.invocation, payload: { ...sentPayload, project: { ...sentPayload.project, models: unleveledModels } } });
          const verified = verifyInvokeAuthorization(post.mock.calls[0]![1].authorization, {
            publicKey: keys.publicKey, workspaceId: record.workspaceId, generation: 3, now: () => Math.floor(NOW / 1_000),
          });
          expect(verified.ok && invocationMatchesClaims(body, verified.claims)).toBe(true);
          expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
            event: "dispatch.thinking_level_omitted", reason: "worker-lacks-feature", operationId: record.operationId,
          }));
          log.mockRestore();
        });

        // Task 4.10D review I-1: `lastCheck` is written by the CLI at registration and no worker reads it; an older worker's strict parse would refuse the whole invocation.
        it(`${kind}: never sends lastCheck, so a worker built before it accepts the definition (whatever its features, and without asking it)`, async () => {
          const checked = {
            default: { provider: "amazon-bedrock", modelId: "fast", label: "Fast", lastCheck: { status: "ok", checkedAt: "2026-10-23T12:00:00.000Z" } },
            approved: [
              { provider: "amazon-bedrock", modelId: "fast", label: "Fast", lastCheck: { status: "ok", checkedAt: "2026-10-23T12:00:00.000Z" } },
              { provider: "openrouter", modelId: "z-ai/glm-5.3", lastCheck: { status: "failed", class: "model-not-found", checkedAt: "2026-10-23T12:00:00.000Z" } },
            ],
          };
          const beforeLastCheck = z.object({ provider: z.string(), modelId: z.string(), thinkingLevel: z.string().optional(), label: z.string().optional() }).strict();
          for (const features of [[], ["model.thinkingLevel"]]) {
            const workerFeatures = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => features);
            const { deliver, post } = delivery({ workerFeatures });
            const record = projectRecord(kind, checked);
            expect(await deliver(record, record.invocation)).toBe("DELIVERED");
            const sent = postedModels(post) as { default: unknown; approved: unknown[] };
            expect(() => { beforeLastCheck.parse(sent.default); for (const model of sent.approved) beforeLastCheck.parse(model); }).not.toThrow();
            expect(JSON.stringify(sent)).not.toContain("lastCheck");
            expect(sent.approved).toHaveLength(2);
          }
          // Without a model-level field there is nothing to ask the worker about: no probe.
          const probe = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => []);
          const quiet = delivery({ workerFeatures: probe });
          const record = projectRecord(kind, checked);
          await quiet.deliver(record, record.invocation);
          expect(probe).not.toHaveBeenCalled();
        });

        it(`${kind}: fails the attempt, posting nothing, when the worker's /ping does not answer`, async () => {
          const { deliver, post } = delivery({ workerFeatures: async () => { throw new Error("timeout"); } });
          const record = projectRecord(kind, models);
          // The message is fixed words; the cause is kept apart, for the dispatcher's log.
          const failure = await deliver(record, record.invocation).catch((error: unknown) => error);
          expect(failure).toMatchObject({ message: "RUNTIME_UNAVAILABLE: could not ask the EC2 worker which invocation fields it parses", upstreamText: "timeout" });
          expect(post).not.toHaveBeenCalled();
        });

        it(`${kind}: does not ask the worker when the definition carries no level`, async () => {
          const workerFeatures = vi.fn(async () => []);
          for (const projectModels of [unleveledModels, undefined]) {
            const { deliver, post } = delivery({ workerFeatures });
            const record = projectRecord(kind, projectModels);
            await deliver(record, record.invocation);
            expect(JSON.parse(post.mock.calls[0]![1].body)).toEqual(record.invocation);
          }
          expect(workerFeatures).not.toHaveBeenCalled();
        });
      }
    });

  });

  // DEC 254zb: a task step on a worker that runs on the default size instead of the project's chosen one says so, in fixed words, once per record.
  describe("machine size note", () => {
    const taskRecord = (): Ec2OutboxRecord => {
      const record = recordFor();
      return { ...record, invocation: { ...record.invocation, kind: "task", payload: { conversationId: randomUUID(), prompt: "test it" } } };
    };
    const ready = (machineFallback?: "size-unavailable" | "x86-unavailable") => ({ ensureSession: async () => ({ ready: true as const, generation: 3, privateIp: "10.42.128.10", ...(machineFallback === undefined ? {} : { machineFallback }) }) });

    it.each(["size-unavailable"] as const)("notes %s on a task step and still delivers it", async (reason) => {
      const machineNote = vi.fn<NonNullable<Ec2DeliveryDependencies["machineNote"]>>(async () => undefined);
      const { deliver, post } = delivery({ sessions: ready(reason), machineNote });
      const record = taskRecord();
      expect(await deliver(record, record.invocation)).toBe("DELIVERED");
      expect(machineNote).toHaveBeenCalledExactlyOnceWith(record, MACHINE_FALLBACK_MESSAGES[reason]);
      expect(post).toHaveBeenCalledTimes(1);
    });

    it("says nothing without a fallback, on a non-task step, or without the recorder; a failing note never stops the step", async () => {
      const machineNote = vi.fn<NonNullable<Ec2DeliveryDependencies["machineNote"]>>(async () => undefined);
      const record = taskRecord();
      await delivery({ sessions: ready(), machineNote }).deliver(record, record.invocation);
      const resume = recordFor();
      await delivery({ sessions: ready("size-unavailable"), machineNote }).deliver(resume, resume.invocation);
      expect(machineNote).not.toHaveBeenCalled();
      expect(await delivery({ sessions: ready("size-unavailable") }).deliver(record, record.invocation)).toBe("DELIVERED");
      const failing = delivery({ sessions: ready("size-unavailable"), machineNote: async () => { throw new Error("store down"); } });
      expect(await failing.deliver(record, record.invocation)).toBe("DELIVERED");
    });

  });

  // D1-2 pre-review S1: an outbox record the retired old workflow engine queued as its internal E2E warm-up never reaches the worker as an ordinary `resume`.
  it("refuses a record that carries the retired E2E readiness marker, before any session or POST, and still delivers the same record without it", async () => {
    const marked = { ...recordFor(), workflowE2EReadiness: { purpose: "WORKFLOW_E2E_READINESS" } } as unknown as Ec2OutboxRecord;
    const d = delivery();
    await expect(d.deliver(marked, marked.invocation)).rejects.toMatchObject({ message: expect.stringContaining("CALLBACK_FORBIDDEN") as string });
    expect(d.post).not.toHaveBeenCalled();
    expect(d.progress).not.toHaveBeenCalled();
    const { workflowE2EReadiness: _marker, ...plain } = marked;
    void _marker;
    await d.deliver(plain, plain.invocation);
    expect(d.post).toHaveBeenCalledOnce();
  });

  it("fails an attempt when the worker refuses, and when the workspace has no ec2-ebs binding", async () => {
    const refused = delivery({ post: async () => ({ status: 401, body: "{\"reason\":\"expired\"}" }) });
    const record = recordFor();
    // The worker's own words (its HTTP body) are not in the message: they are carried apart, for the dispatcher's log only.
    const refusal = await refused.deliver(record, record.invocation).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ message: "RUNTIME_UNAVAILABLE: EC2 worker returned HTTP 401", httpStatus: 401, upstreamText: "{\"reason\":\"expired\"}" });
    // A worker of another workspace answers its fixed 401: the failure says so (`workerReason`) and where the delivery was sent, for the dispatcher's stale-address log line.
    const stale = delivery({ post: async () => ({ status: 401, body: "{\"error\":\"invocation is not authorized\",\"reason\":\"wrong_workspace\"}" }) });
    const staleFailure = await stale.deliver(record, record.invocation).catch((error: unknown) => error) as { workerReason?: string; where?: { privateIp: string; generation: number } };
    expect(staleFailure.workerReason).toBe("wrong_workspace");
    const named = await delivery({ post: async () => ({ status: 401, body: "{\"error\":\"invocation is not authorized\",\"reason\":\"wrong_generation\",\"workspaceId\":\"9f1d2c3b-4a59-4687-8695-a4b3c2d1e0f9\",\"generation\":3}" }) }).deliver(record, record.invocation).catch((error: unknown) => error) as { workerReason?: string; workerIdentity: { workspaceId?: string; generation?: number } };
    expect(named.workerReason).toBe("wrong_generation");
    expect(named.workerIdentity).toEqual({ workspaceId: "9f1d2c3b-4a59-4687-8695-a4b3c2d1e0f9", generation: 3 });
    expect((staleFailure as unknown as { workerIdentity: unknown }).workerIdentity).toEqual({});
    expect(staleFailure.where).toMatchObject({ privateIp: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/u) as string, generation: expect.any(Number) as number });
    // Any other 401 reason, a non-JSON body and a non-401 status are not that signal.
    for (const [status, body] of [[401, "{\"reason\":\"expired\"}"], [401, "<html>"], [403, "{\"reason\":\"wrong_workspace\"}"]] as const) {
      const other = await delivery({ post: async () => ({ status, body }) }).deliver(record, record.invocation).catch((error: unknown) => error) as { workerReason?: string };
      expect(status === 403 ? undefined : other.workerReason).toBe(body.includes("expired") ? "expired" : undefined);
    }
    const unbound = delivery({ binding: async () => undefined });
    await expect(unbound.deliver(record, record.invocation)).rejects.toThrow(/CONFIG_INVALID/);
  });
});

describe("the dispatcher with ec2-ebs records", () => {
  function dispatcher(deliverEc2: (record: Ec2OutboxRecord, invocation: WorkerInvocation) => Promise<Ec2Delivery>) {
    const markDelivered = vi.fn(async () => undefined);
    const markFailed = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered, markFailed, deliverEc2, log: () => undefined });
    return { handler, markDelivered, markFailed };
  }

  it("passes invocation remaining time into the initial pre-compute guard", async () => {
    const record = recordFor();
    const guardTaskDispatch = vi.fn<(record: DurableOutboxRecord, context?: { remainingTimeMs: () => number }) => Promise<"ALLOWED" | "PARKED">>(async () => "PARKED");
    const markDispatching = vi.fn(async () => true);
    const handler = createDispatcherHandler({
      markDispatching, markDelivered: async () => undefined, markFailed: async () => undefined,
      guardTaskDispatch, deliverEc2: async () => "DELIVERED", log: () => undefined,
    });

    await expect(handler({ Records: [{ messageId: "initial", body: JSON.stringify(record) }] }, {
      getRemainingTimeInMillis: () => 8_000,
    })).resolves.toEqual({ batchItemFailures: [] });
    expect(guardTaskDispatch).toHaveBeenCalledTimes(1);
    expect(typeof guardTaskDispatch.mock.calls[0]?.[1]?.remainingTimeMs).toBe("function");
    expect(markDispatching).not.toHaveBeenCalled();
  });

  it("marks a delivered record DELIVERED, and retries a failed delivery", async () => {
    const delivered = dispatcher(async () => "DELIVERED");
    const record = recordFor();
    await delivered.handler({ Records: [{ messageId: "m1", body: JSON.stringify(record) }] });
    expect(delivered.markDelivered).toHaveBeenCalledWith(record.id);

    const failing = dispatcher(async () => { throw new Error("connect ECONNREFUSED"); });
    expect(await failing.handler({ Records: [{ messageId: "m2", body: JSON.stringify(record), attributes: { ApproximateReceiveCount: "1" } }] }))
      .toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
    expect(failing.markFailed).not.toHaveBeenCalled();
  });

  it("keeps an incomplete authority guard retryable at max attempts but preserves identical ordinary worker errors", async () => {
    const record = recordFor();
    const original = agentXError("RUNTIME_UNAVAILABLE", "task access pause reserve is unavailable");
    const guardTaskDispatch = async (candidate: DurableOutboxRecord) => coreGuardTaskDispatch({
      documentClient: { async send() { throw original; } }, tableName: "state",
    }, candidate);
    const markFailed = vi.fn(async () => undefined);
    const logs: Array<{ terminal: boolean; errorCode?: string }> = [];
    const guarded = createDispatcherHandler({
      guardTaskDispatch, markDispatching: async () => true, markDelivered: async () => undefined, markFailed,
      maxAttempts: 5, deliverEc2: async () => "DELIVERED", log: (entry) => { logs.push(entry); },
    });
    await expect(guarded({ Records: [{ messageId: "guard-terminal", body: JSON.stringify(record), attributes: { ApproximateReceiveCount: "5" } }] }))
      .resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "guard-terminal" }] });
    expect(markFailed).not.toHaveBeenCalled();
    expect(logs.at(-1)).toMatchObject({ terminal: false, errorCode: original.code });

    const ordinaryMarkFailed = vi.fn(async () => undefined);
    const ordinary = createDispatcherHandler({ markDispatching: async () => true, markDelivered: async () => undefined,
      markFailed: ordinaryMarkFailed, maxAttempts: 5,
      deliverEc2: async () => { throw agentXError("RUNTIME_UNAVAILABLE", original.message.slice("RUNTIME_UNAVAILABLE: ".length)); },
      log: () => undefined });
    await expect(ordinary({ Records: [{ messageId: "worker-terminal", body: JSON.stringify(record), attributes: { ApproximateReceiveCount: "5" } }] }))
      .resolves.toEqual({ batchItemFailures: [] });
    expect(ordinaryMarkFailed).toHaveBeenCalledTimes(1);
  });

  it("fails the current and remaining batch items before starting another guard inside the pause reserve", async () => {
    const first = recordFor();
    const second = recordFor();
    const guardTaskDispatch = vi.fn(async () => "ALLOWED" as const);
    const markDispatching = vi.fn(async () => true);
    const handler = createDispatcherHandler({
      guardTaskDispatch, markDispatching, markDelivered: async () => undefined, markFailed: async () => undefined,
      deliverEc2: async () => "DELIVERED", log: () => undefined,
    });

    await expect(handler({ Records: [first, second].map((record, index) => ({ messageId: `m${index + 1}`, body: JSON.stringify(record) })) }, {
      getRemainingTimeInMillis: () => 2_000,
    })).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }] });
    expect(guardTaskDispatch).not.toHaveBeenCalled();
    expect(markDispatching).not.toHaveBeenCalled();
  });
});

describe("ec2-ebs delivery through the real session manager", () => {
  it.each([COMPANY_A])("provisions a separate legacy delivery instance when another workspace is already READY (%s)", async (companyOfB) => {
    const world = createSessionMachinesWorld({ startedAt: NOW });
    const workspaceA = world.workspace(COMPANY_A);
    const workspaceB = world.workspace(companyOfB);
    const publicKey = invokePublicKey(world.publicKey);
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async (url, init) => {
      const instance = [...world.instances.values()].find((candidate) => candidate.privateIp === new URL(url).hostname);
      expect(instance).toBeDefined();
      const verified = verifyInvokeAuthorization(init.authorization, {
        publicKey, workspaceId: instance!.workspaceId, generation: instance!.generation, now: () => Math.floor(NOW / 1_000),
      });
      expect(verified.ok).toBe(true);
      expect(verified.ok && invocationMatchesClaims(WorkerInvocationSchema.parse(JSON.parse(init.body)), verified.claims)).toBe(true);
      return { status: 200, body: "{}" };
    });
    const { deliver } = delivery({ sessions: world.sessions, sign: (message) => world.sign(message), post });
    // Workspace ids are UUIDs; the helper types them as plain strings.
    const recordA = recordFor(workspaceA as `${string}-${string}-${string}-${string}-${string}`);
    const recordB = recordFor(workspaceB as `${string}-${string}-${string}-${string}-${string}`);
    for (const record of [recordA, recordB]) world.db.set({ pk: `OUTBOX#${record.id}`, sk: "OUTBOX", ...record });
    expect(await deliver(recordA, recordA.invocation)).toBe("WAITING_FOR_SESSION");
    await world.settle();
    const sessionA = (await world.sessions.get(workspaceA))!;
    expect(sessionA.state).toBe("READY");
    expect(await deliver(recordA, recordA.invocation)).toBe("DELIVERED");

    expect(await deliver(recordB, recordB.invocation)).toBe("WAITING_FOR_SESSION");
    expect(post).toHaveBeenCalledTimes(1);
    await world.settle();
    const sessionB = (await world.sessions.get(workspaceB))!;
    expect(sessionB).toMatchObject({ workspaceId: workspaceB, state: "READY", generation: 1 });
    expect(sessionB.instanceId).toBeTruthy();
    expect(sessionB.instanceId).not.toBe(sessionA.instanceId);
    expect(sessionB.privateIp).not.toBe(sessionA.privateIp);
    expect(await deliver(recordB, recordB.invocation)).toBe("DELIVERED");
    expect(post.mock.calls.map(([url]) => url)).toEqual([
      `http://${sessionA.privateIp}:8080/invocations`,
      `http://${sessionB.privateIp}:8080/invocations`,
    ]);
    expect(world.executions.map(({ name }) => name)).toEqual([`ws-${workspaceA}-gen-1`, `ws-${workspaceB}-gen-1`]);
  });
});

