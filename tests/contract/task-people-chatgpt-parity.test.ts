import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatGptConnectionView, Ec2RuntimeBinding, TaskPersonProofRequest, TaskPersonProofResponse, WorkflowSnapshot } from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { createEc2Delivery, type Ec2DeliveryDependencies } from "../../packages/broker/src/aws/ec2-delivery.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { guardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import type { ChatGptConnections } from "../../packages/broker/src/chatgpt/connections.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { createSingleAnswerPlanBroker, type Developer } from "../support/developer-task-broker.js";
import { SLACK_TEAM } from "../support/slack-broker.js";

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const binding: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs",
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
  volumeSizeGiB: 20,
  volumeType: "gp3",
};

describe("PEOPLE and ChatGPT task identity parity", () => {
  it("keeps creator runtime authority while a co-owner approves and explicitly redrives the same parked work", async () => {
    const creatorSlack = "U0PARITY01";
    const coOwnerSlack = "U0PARITY02";
    const creator: Developer = { developerId: developerIdForSlackUser(creatorSlack), name: "Creator One", provider: "slack", sessionId: "s-parity-creator", slackUserId: creatorSlack };
    const coOwner: Developer = { developerId: developerIdForSlackUser(coOwnerSlack), name: "Owner Two", provider: "slack", sessionId: "s-parity-owner", slackUserId: coOwnerSlack };
    const connected = (email: string, models: string[]): ChatGptConnectionView => ({ connected: true, status: "connected", email, models });
    let connectionsActive = false;
    const views: Record<string, ChatGptConnectionView> = {
      [creator.developerId]: connected("creator@example.test", ["gpt-6.1-sol"]),
      [coOwner.developerId]: connected("co-owner@example.test", ["gpt-5.6-terra"]),
    };
    const view = vi.fn(async (developerId: string): Promise<ChatGptConnectionView> => connectionsActive ? views[developerId] ?? { connected: false } : { connected: false });
    const accessToken = vi.fn(async () => ({ access: "inert-token-that-must-not-be-read", expiresAt: Date.now() + 60_000, models: [] }));
    const chatgpt = {
      settings: vi.fn(async () => ({ enabled: true, preferredModel: "gpt-6.1-sol" })),
      view,
      accessToken,
    } as unknown as ChatGptConnections;
    const harness = await createSingleAnswerPlanBroker({
      channelMembers: async (request) => ({ ok: true, memberOf: [...request.channelIds] }),
      developerExtra: {
        taskPeopleConfiguration: { peopleChangesEnabled: true },
        taskPersonProof: async (request: TaskPersonProofRequest): Promise<TaskPersonProofResponse> => ({
          ok: true,
          user: { id: request.slackUserId, teamId: SLACK_TEAM, name: request.slackUserId === creatorSlack ? creator.name : coOwner.name },
          memberOf: [...request.channelIds],
        }),
      },
      brokerExtra: { chatgpt },
    });
    for (const who of [creator, coOwner]) {
      harness.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: "slack", slackUserId: who.slackUserId,
        startedAt: new Date(Date.now() - 1_000).toISOString(), endsAt: Math.floor(Date.now() / 1_000) + 3_600 });
      harness.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: "slack", issuer: "https://slack.com", subject: who.slackUserId,
        displayName: who.name, slackUserId: who.slackUserId, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    }

    const started = await harness.dev(creator, "POST", "/v1/dev/tasks", {
      requestId: randomUUID(), project: "payments", instructions: "Keep the runtime identity stable", client: "parity-test", workflow: true, workflowPath: "QUICK",
    });
    expect(started.status).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const original = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; ownerKey: string; conversationId: string; workflow: WorkflowSnapshot };
    const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${original.workspaceId}` && item.entityType === "OPERATION");
    await harness.finish(original.workspaceId, String(operations().find((operation) => operation.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    const plan = "# Plan\n\n1. Preserve creator runtime identity.\n";
    await finishPlanningWithMarkdown(harness, original.workspaceId, String(operations().find((operation) => operation.workflowMode === "PLAN")!.id), plan);

    const createdAt = new Date().toISOString();
    for (const who of [creator, coOwner]) {
      const personId = randomUUID();
      harness.db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId: who.developerId, slackUserId: who.slackUserId,
        name: who.name, method: "slack", issuer: "https://slack.com", subject: who.slackUserId, createdAt });
      harness.db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${who.developerId}`, schemaVersion: 1, personId, developerId: who.developerId, createdAt });
    }
    harness.db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [
      { developerId: creator.developerId, slackUserId: creatorSlack, name: creator.name, role: "owner" },
      { developerId: coOwner.developerId, slackUserId: coOwnerSlack, name: coOwner.name, role: "owner" },
    ] });

    connectionsActive = true;
    view.mockClear();
    const before = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: WorkflowSnapshot }).workflow;
    const artifact = before.artifacts.find((entry) => entry.type === "plan")!;
    const approved = await harness.dev(coOwner, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: before.revision, decision: "APPROVE", reason: "Approved by the co-owner", artifactDigest: artifact.sha256,
    });
    expect(approved.status).toBe(200);

    const implementation = operations().filter((operation) => operation.workflowMode === "IMPLEMENT");
    expect(implementation).toHaveLength(1);
    const operation = implementation[0]!;
    const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operation.id)[0] as unknown as Ec2OutboxRecord;
    if (outbox.invocation.kind !== "task") throw new Error("implementation must carry a task invocation");
    const acceptedInvocation = structuredClone(outbox.invocation);
    const stored = harness.db.get(`DEVTASK#${taskId}`, "META") as { developerId: string; ownerKey: string; workflow: WorkflowSnapshot };
    expect(stored).toMatchObject({ developerId: creator.developerId, ownerKey: taskOwnerKey(creator.developerId, taskId), workflow: { ownerId: original.ownerKey } });
    expect(stored.workflow.decisions.at(-1)?.actorId).toBe(taskOwnerKey(coOwner.developerId, taskId));
    expect(harness.db.get(`WORKSPACE#${original.workspaceId}`, "META")).toMatchObject({ ownerKey: original.ownerKey, activeOperationId: operation.id });
    expect(operation).toMatchObject({ chatgptDeveloperId: creator.developerId, conversationId: original.conversationId });
    expect(outbox.invocation.payload).toMatchObject({ chatgpt: { model: { provider: "openai", modelId: "gpt-6.1-sol" } } });
    expect(String(outbox.invocation.payload.prompt)).toContain(`Approved plan (sha256 ${artifact.sha256})`);
    expect(String(artifact.objectKey)).toContain(`/` + original.ownerKey + `/`);
    expect(view.mock.calls).toEqual([[creator.developerId]]);
    const acceptedTurn = harness.db.find((item) => item.origin === "ai_tool" && item.phase === "accepted" && item.operationId === operation.id).at(-1);
    expect(acceptedTurn?.developer).toMatchObject({ developerId: coOwner.developerId, slackUserId: coOwnerSlack });

    const sign = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{\"accepted\":true}" }));
    let dispatchProof = true;
    const dispatchPerson = async (_task: unknown, developerId: string) => {
      const who = developerId === creator.developerId ? creator : coOwner;
      return { subject: { developerId, slackUserId: who.slackUserId! }, identity: { developerId, slackUserId: who.slackUserId!, name: who.name, method: "slack" as const, issuer: "https://slack.com", subject: who.slackUserId! },
        eligible: dispatchProof, channelMember: dispatchProof };
    };
    const pausedWorkerFeatures = vi.fn(async () => {
      dispatchProof = false;
      return ["task.workflowMode", "task.workflowBase", "model.chatgpt"];
    });
    const pausedDelivery = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined,
      sessions: { ensureSession: async () => ({ ready: true, generation: 1, privateIp: "127.0.0.1" }) },
      binding: async () => binding,
      sign,
      post,
      progress: async () => undefined,
      workerFeatures: pausedWorkerFeatures,
      guardTaskDispatch: (record) => guardTaskDispatch({ documentClient: harness.db, tableName: "state", checkTaskPerson: dispatchPerson }, record),
    });
    await expect(pausedDelivery(outbox, outbox.invocation)).resolves.toBe("WAITING_FOR_TASK_ACCESS");
    expect(harness.db.get(`OUTBOX#${outbox.id}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS", operationId: operation.id, invocation: acceptedInvocation });
    expect(operations().filter((item) => item.workflowMode === "IMPLEMENT")).toHaveLength(1);
    expect(view).toHaveBeenCalledTimes(1);
    expect(accessToken).not.toHaveBeenCalled();
    expect(pausedWorkerFeatures).toHaveBeenCalledTimes(1);
    expect(sign).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();

    dispatchProof = true;
    const retryRequestId = randomUUID();
    const retried = await harness.dev(coOwner, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: retryRequestId, instructions: "Resume the parked implementation" });
    expect(retried.status).toBe(200);
    expect(harness.db.get(`DEVTASK#${taskId}`, `TASK_ACCESS_RETRY#${retryRequestId}`)).toMatchObject({ actorId: taskOwnerKey(coOwner.developerId, taskId), operationId: operation.id });
    const resumed = harness.db.get(`OUTBOX#${outbox.id}`, "OUTBOX") as unknown as Ec2OutboxRecord;
    expect(resumed).toMatchObject({ status: "PENDING", operationId: operation.id, invocation: acceptedInvocation });
    expect(view).toHaveBeenCalledTimes(1);
    expect(accessToken).not.toHaveBeenCalled();

    const workerFeatures = vi.fn(async () => ["task.workflowMode", "task.workflowBase", "model.chatgpt"]);
    const delivered = createEc2Delivery({
      applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined,
      sessions: { ensureSession: async () => ({ ready: true, generation: 1, privateIp: "127.0.0.1" }) },
      binding: async () => binding,
      sign,
      post,
      progress: async () => undefined,
      workerFeatures,
      guardTaskDispatch: (record) => guardTaskDispatch({ documentClient: harness.db, tableName: "state", checkTaskPerson: dispatchPerson }, record),
    });
    await expect(delivered(resumed, resumed.invocation)).resolves.toBe("DELIVERED");
    expect(workerFeatures).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(post.mock.calls[0]![1].body))).toEqual(acceptedInvocation);
    expect(operations().filter((item) => item.workflowMode === "IMPLEMENT")).toHaveLength(1);
    expect(view).toHaveBeenCalledTimes(1);
    expect(accessToken).not.toHaveBeenCalled();
  });
});
