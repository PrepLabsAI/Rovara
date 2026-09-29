import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { WorkspaceInstanceSchema, workspaceRecordFields } from "../../packages/contracts/src/workspace.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { parseRuntimeBinding } from "../../packages/broker/src/aws/lambda.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker,
  registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

// Representative wire values from the retired architecture, kept with its design history.
const routing = JSON.parse(readFileSync(new URL("../../specs/036-ec2-only-runtime/historical-routing.json", import.meta.url), "utf8")) as {
  runtimeArn: string; endpointQualifier: string; capacityProviderArn: string; runtimeSessionId: string;
};
const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const member = "U0123456789";

function historicalBinding(deploymentMode: "instances-ebs" | "demo-microvm") {
  return {
    deploymentMode, runtimeArn: routing.runtimeArn, endpointQualifier: routing.endpointQualifier,
    ...(deploymentMode === "instances-ebs" ? { capacityProviderArn: routing.capacityProviderArn } : {}),
  };
}

beforeAll(async () => { await loadSlackBroker(); });

describe.each(["instances-ebs", "demo-microvm"] as const)("retired %s history", (mode) => {
  it("reads closed workspaces and operations pinned to an old project revision without dispatching", async () => {
    const { db, handler, deleteEc2Session } = createBroker();
    await registerSlackProject(handler);
    const prepared = await ensureWorkspace(handler, thread, member);
    expect(prepared.status).toBe(200);
    const workspaceId = prepared.body.workspaceId as string;
    const operationId = prepared.body.operationId as string;
    const now = new Date().toISOString();
    const workspace = db.get(`WORKSPACE#${workspaceId}`, "META")!;
    const project = db.get("PROJECT#payments", "REV#000000000001")!;
    db.set({ ...project, runtimeBinding: historicalBinding(mode) });
    db.set({ ...workspace, ...historicalBinding(mode), runtimeSessionId: routing.runtimeSessionId,
      status: "CLOSED", closedAt: now, closeOperationId: operationId, activeOperationId: null });
    const operation = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!;
    db.set({ ...operation, kind: "close", status: "SUCCEEDED", result: { safeToClose: true, repositories: [] } });

    const stored = db.get(`WORKSPACE#${workspaceId}`, "META")!;
    expect(WorkspaceInstanceSchema.parse(workspaceRecordFields(stored))).toMatchObject({ deploymentMode: mode, runtimeArn: routing.runtimeArn });
    const outboxCount = db.find((item) => item.entityType === "OUTBOX").length;
    const read = await serviceCall(handler, thread, member, "GET", `/v1/service/workspaces/${workspaceId}/operations/${operationId}`);
    expect(read.status).toBe(200);
    expect(read.body.operation).toMatchObject({ id: operationId, status: "SUCCEEDED" });
    const closed = await serviceCall(handler, thread, member, "POST", "/v1/service/threads/workspace/close/complete", {
      requestId: randomUUID(), operationId,
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ outcome: "CLOSED", storageReleased: mode === "instances-ebs" });
    expect(deleteEc2Session).not.toHaveBeenCalled();
    expect(db.find((item) => item.entityType === "OUTBOX")).toHaveLength(outboxCount);
  });

  it("rejects a new registration and refuses workspace creation from an old revision", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const project = db.get("PROJECT#payments", "REV#000000000001")!;
    const binding = historicalBinding(mode);
    expect(() => parseRuntimeBinding(binding)).toThrow(/CONFIG_INVALID/);
    const registration = await call(handler, { method: "POST", path: "/v1/admin/projects",
      user: { subject: "admin-subject", admin: true }, body: { definition: project.definition, runtimeBinding: binding } });
    expect(registration.status).toBe(400);
    db.set({ ...project, runtimeBinding: binding });
    const response = await ensureWorkspace(handler, thread, member);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("retired project revision");
    expect(db.find((item) => item.entityType === "WORKSPACE" || item.entityType === "OUTBOX")).toEqual([]);
  });
});

it("fails outstanding retired outbox work without delivering it to EC2, and acknowledges terminal history", async () => {
  const operationId = randomUUID();
  const workspaceId = randomUUID();
  const record = { id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId,
    runtimeArn: routing.runtimeArn, runtimeSessionId: routing.runtimeSessionId, endpointQualifier: routing.endpointQualifier,
    invocation: { protocolVersion: 1, operationId, workspaceId, kind: "resume", fence: 1, projectRevision: 1,
      callbackCapability: "c".repeat(64), payload: {} } };
  const deliverEc2 = vi.fn(async () => "DELIVERED" as const);
  const markFailed = vi.fn(async () => undefined);
  const markDelivered = vi.fn(async () => undefined);
  const markDispatching = vi.fn(async () => true);
  const handler = createDispatcherHandler({ deliverEc2, markFailed, markDelivered, markDispatching, maxAttempts: 1, log: () => undefined });
  const event = { Records: [{ messageId: "old", body: JSON.stringify(record) }] };
  expect(await handler(event)).toEqual({ batchItemFailures: [] });
  expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({ operationId }), expect.stringContaining("retired deployment mode"));
  expect(deliverEc2).not.toHaveBeenCalled();
  expect(markDelivered).not.toHaveBeenCalled();
  markDispatching.mockResolvedValue(false);
  expect(await handler(event)).toEqual({ batchItemFailures: [] });
  expect(markDelivered).toHaveBeenCalledWith(record.id);
  expect(markFailed).toHaveBeenCalledTimes(1);
});
