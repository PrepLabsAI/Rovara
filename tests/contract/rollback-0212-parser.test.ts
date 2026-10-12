import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { WorkerInvocationSchema, WorkflowSnapshotSchema, type Ec2RuntimeBinding, type WorkflowSnapshot } from "@agentx/contracts";
import { createEc2Delivery } from "../../packages/broker/src/aws/ec2-delivery.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import type { ChatGptConnections } from "../../packages/broker/src/chatgpt/connections.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { registerSlackProject } from "../support/slack-broker.js";
import { loadRollback0212Parser } from "../support/rollback-0212-parser.js";

const binding: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs",
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
  volumeSizeGiB: 20,
  volumeType: "gp3",
};

describe("immutable 0.2.12 parser fixture", () => {
  it("loads only the checksum-pinned pure schema bundle", async () => {
    const parser = await loadRollback0212Parser();
    expect(parser.exports).toEqual(["WorkerInvocationSchema", "WorkflowSnapshotSchema"]);
    expect(parser.WorkflowSnapshotSchema.safeParse({}).success).toBe(false);
    expect(parser.WorkerInvocationSchema.safeParse({}).success).toBe(false);
  });

  it("aborts on changed fixture bytes before writing an importable module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollback-0212-corrupt-"));
    try {
      const fixtureDirectory = join(directory, "fixture");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(fixtureDirectory);
      const root = new URL("../fixtures/rollback-0.2.12/", import.meta.url);
      await writeFile(join(fixtureDirectory, "provenance.json"), await readFile(new URL("provenance.json", root)));
      const bytes = await readFile(new URL("parser-bundle.txt", root));
      await writeFile(join(fixtureDirectory, "parser-bundle.txt"), Buffer.concat([bytes, Buffer.from("\ncorrupt")]));

      const importModule = vi.fn(async () => ({}));
      await expect(loadRollback0212Parser({ fixtureDirectory, importModule })).rejects.toThrow(/sha-256|integrity|checksum/i);
      expect(importModule).not.toHaveBeenCalled();
      await expect(readdir(directory)).resolves.toEqual(["fixture"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts a real current accepted workflow and feature-negotiated invocation while rejecting ChatGPT on the old parser", async () => {
    const parser = await loadRollback0212Parser();
    const chatgpt = {
      settings: async () => ({ enabled: true, preferredModel: "gpt-6.1-sol" }),
      view: async () => ({ connected: true, status: "connected", email: "owner@example.test", models: ["gpt-6.1-sol"] }),
      accessToken: async () => ({ access: "test-token", expiresAt: Date.now() + 60_000, models: ["gpt-6.1-sol"] }),
    } as unknown as ChatGptConnections;
    const harness = await createDeveloperTaskBroker({ register: false, brokerExtra: { chatgpt } });
    const fallbackModel = { provider: "amazon-bedrock", modelId: "default-model" };
    await registerSlackProject(harness.handler, { models: { default: fallbackModel, approved: [fallbackModel] } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", {
      requestId: randomUUID(), project: "payments", instructions: "Keep the accepted task stable", client: "rollback-0212-parser", workflow: true, workflowPath: "QUICK",
    });
    expect(started.status).toBe(200);
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; workflow: WorkflowSnapshot };
    const operationRows = () => harness.db.find((item) => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION");
    await harness.finish(task.workspaceId, String(operationRows().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", {
      result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] },
    });
    const planning = operationRows().find((item) => item.workflowMode === "PLAN");
    await finishPlanningWithMarkdown(harness, task.workspaceId, String(planning?.id), "# Plan\n\n1. Keep the accepted task stable.\n");
    const currentWorkflow = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: WorkflowSnapshot }).workflow;
    const planArtifact = currentWorkflow.artifacts.find((artifact) => artifact.type === "plan");
    expect(planArtifact).toBeDefined();
    const approval = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: currentWorkflow.revision, decision: "APPROVE", reason: "Accept the plan", artifactDigest: planArtifact?.sha256,
    });
    expect(approval.status).toBe(200);

    const accepted = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: WorkflowSnapshot }).workflow;
    expect(WorkflowSnapshotSchema.safeParse(accepted).success).toBe(true);
    expect(parser.WorkflowSnapshotSchema.safeParse(accepted).success).toBe(true);
    const malformedDigest = structuredClone(accepted);
    const digestArtifact = malformedDigest.artifacts.find((artifact) => artifact.type === "plan");
    if (digestArtifact === undefined) throw new Error("accepted workflow must retain its approved plan artifact");
    digestArtifact.sha256 = "not-a-sha256-digest";
    expect(parser.WorkflowSnapshotSchema.safeParse(malformedDigest).success).toBe(false);
    const implementation = operationRows().find((item) => item.workflowMode === "IMPLEMENT");
    expect(implementation).toBeDefined();
    const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === implementation?.id)[0] as unknown as Ec2OutboxRecord;
    expect(outbox.invocation.kind).toBe("task");
    if (outbox.invocation.kind !== "task") throw new Error("accepted implementation outbox must carry a task invocation");
    expect(outbox.invocation.payload.chatgpt).toMatchObject({ model: { provider: "openai", modelId: "gpt-6.1-sol" } });
    expect(outbox.invocation.payload.model).toEqual(fallbackModel);
    expect(outbox.invocation.payload.workflowBase).toBeDefined();
    expect(WorkerInvocationSchema.safeParse(outbox.invocation).success).toBe(true);
    expect(parser.WorkerInvocationSchema.safeParse(outbox.invocation).success).toBe(false);

    let postedBody: string | undefined;
    const deliver = createEc2Delivery({
      sessions: { ensureSession: async () => ({ ready: true, generation: 1, privateIp: "127.0.0.1" }) },
      binding: async () => binding,
      sign: async () => new Uint8Array([1, 2, 3]),
      post: async (_url, init) => { postedBody = init.body; return { status: 202, body: "" }; },
      progress: async () => undefined,
      workerFeatures: async () => ["task.workflowMode", "task.workflowBase"],
    });
    await expect(deliver(outbox, outbox.invocation)).resolves.toBe("DELIVERED");
    if (postedBody === undefined) throw new Error("real EC2 delivery must POST the feature-negotiated invocation");
    const sent = JSON.parse(postedBody) as unknown;
    const parsedSent = WorkerInvocationSchema.safeParse(sent);
    expect(parsedSent.success).toBe(true);
    expect(parser.WorkerInvocationSchema.safeParse(sent).success).toBe(true);
    const expectedFeatureStripped = structuredClone(outbox.invocation);
    if (expectedFeatureStripped.kind !== "task") throw new Error("accepted implementation outbox must carry a task invocation");
    delete expectedFeatureStripped.payload.chatgpt;
    expect(sent).toEqual(expectedFeatureStripped);
    expect(expectedFeatureStripped.payload.model).toEqual(outbox.invocation.payload.model);
    expect(expectedFeatureStripped.payload.workflowBase).toEqual(outbox.invocation.payload.workflowBase);
    expect(expectedFeatureStripped.payload).toMatchObject({
      conversationId: outbox.invocation.payload.conversationId,
      workflowMode: "IMPLEMENT",
    });
    expect(parser.WorkerInvocationSchema.safeParse({ ...expectedFeatureStripped, unknownCompatibilityField: true }).success).toBe(false);
  });
});
