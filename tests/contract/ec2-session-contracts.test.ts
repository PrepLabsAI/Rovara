import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  Ec2RuntimeBindingSchema,
  WorkerInvokeTokenClaimsSchema,
  WorkspaceSessionSchema,
  workspaceSessionKey,
} from "../../packages/contracts/src/session.js";
import { WorkspaceDeploymentModeSchema, WorkspaceInstanceSchema } from "../../packages/contracts/src/workspace.js";
import { parseRuntimeBinding } from "../../packages/broker/src/aws/lambda.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { createOutboxPublisherHandler } from "../../packages/broker/src/aws/outbox-publisher.js";
import { registerProject } from "../../packages/cli/src/admin/register.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, account, call, createBroker, finishOperation, lazyEnsureWorkspace, loadSlackBroker, markReady,
  prepareThread, serviceCall,
} from "../support/slack-broker.js";

const binding = {
  deploymentMode: "ec2-ebs",
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [
    { availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" },
    { availabilityZone: "us-east-1b", subnetId: "subnet-0fedcba9876543210" },
  ],
  volumeSizeGiB: 20,
  volumeType: "gp3",
} as const;

const now = new Date().toISOString();
const agentCoreRuntime = {
  runtimeArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:runtime/agentx`,
  endpointQualifier: "DEFAULT",
  runtimeSessionId: randomUUID(),
};
const workspaceBase = {
  id: randomUUID(),
  ownerKey: "a".repeat(64),
  projectName: "payments",
  projectRevision: 1,
  rootPath: "/mnt/workspace",
  status: "READY",
  fence: 1,
  createdAt: now,
  updatedAt: now,
};

describe("the ec2-ebs deployment mode", () => {
  it("is a workspace deployment mode next to the AgentCore modes", () => {
    expect(WorkspaceDeploymentModeSchema.options).toEqual(["instances-ebs", "demo-microvm", "ec2-ebs"]);
  });

  it("stores an ec2-ebs workspace without any AgentCore routing", () => {
    const workspace = WorkspaceInstanceSchema.parse({ ...workspaceBase, deploymentMode: "ec2-ebs" });
    expect(workspace).toMatchObject({ deploymentMode: "ec2-ebs", activeOperationId: null });
    for (const field of ["runtimeArn", "endpointQualifier", "runtimeSessionId"] as const) {
      expect(() => WorkspaceInstanceSchema.parse({
        ...workspaceBase, deploymentMode: "ec2-ebs", [field]: agentCoreRuntime[field],
      })).toThrow(new RegExp(`ec2-ebs workspaces must not have ${field}`));
    }
    expect(() => WorkspaceInstanceSchema.parse({
      ...workspaceBase,
      deploymentMode: "ec2-ebs",
      capacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:capacity-provider/agentx`,
    })).toThrow(/must not have capacityProviderArn/);
  });

  it("still requires the AgentCore routing of an AgentCore workspace", () => {
    expect(WorkspaceInstanceSchema.parse({ ...workspaceBase, ...agentCoreRuntime, deploymentMode: "demo-microvm" }))
      .toMatchObject(agentCoreRuntime);
    for (const field of ["runtimeArn", "endpointQualifier", "runtimeSessionId"] as const) {
      const rest: Partial<typeof agentCoreRuntime> = { ...agentCoreRuntime };
      delete rest[field];
      expect(() => WorkspaceInstanceSchema.parse({ ...workspaceBase, ...rest, deploymentMode: "demo-microvm" }))
        .toThrow(new RegExp(`demo-microvm workspaces require ${field}`));
    }
  });
});

describe("the ec2-ebs runtime binding", () => {
  it("parses a launch template, one subnet per zone, and the volume, with no AgentCore ARNs", () => {
    const reordered = {
      volumeType: "gp3",
      volumeSizeGiB: 20,
      subnets: binding.subnets.map((subnet) => ({ subnetId: subnet.subnetId, availabilityZone: subnet.availabilityZone })),
      launchTemplateId: binding.launchTemplateId,
      deploymentMode: "ec2-ebs",
    };
    // Registration compares bindings as JSON, so the parsed key order must not depend on the input's.
    expect(JSON.stringify(parseRuntimeBinding(reordered))).toBe(JSON.stringify(binding));
  });

  it("refuses AgentCore fields, a zone with two subnets, and an unsupported volume", () => {
    expect(() => parseRuntimeBinding({ ...binding, runtimeArn: agentCoreRuntime.runtimeArn })).toThrow(/CONFIG_INVALID/);
    expect(() => parseRuntimeBinding({
      ...binding,
      subnets: [binding.subnets[0], { availabilityZone: "us-east-1a", subnetId: "subnet-0fedcba9876543210" }],
    })).toThrow(/only one subnet/);
    expect(() => parseRuntimeBinding({ ...binding, subnets: [] })).toThrow(/CONFIG_INVALID/);
    expect(() => parseRuntimeBinding({ ...binding, volumeType: "io2" })).toThrow(/volumeType/);
    expect(() => parseRuntimeBinding({ ...binding, volumeSizeGiB: 0 })).toThrow(/volumeSizeGiB/);
    expect(() => Ec2RuntimeBindingSchema.parse({ ...binding, launchTemplateId: "template" })).toThrow(/launch template/);
  });

  it("leaves AgentCore binding validation in its original order", () => {
    // Unknown fields are reported before the mode is looked at, as before ec2-ebs existed.
    expect(() => parseRuntimeBinding({ deploymentMode: "instances-ebs", launchTemplateId: binding.launchTemplateId }))
      .toThrow(/unknown fields/);
    expect(() => parseRuntimeBinding({ runtimeArn: "not-an-arn", endpointQualifier: "DEFAULT", deploymentMode: "bogus" }))
      .toThrow(/ARN or endpoint qualifier/);
  });
});

describe("registering an ec2-ebs project from the CLI module", () => {
  const definition = {
    name: "payments",
    revision: 1,
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate work.",
  };

  it("sends a valid binding and refuses an invalid one before contacting the control plane", async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ duplicate: false }), { status: 201 }));
    await registerProject({ controlPlaneUrl: "https://control.example.test", accessToken: "token", definition, runtimeBinding: binding }, fetchImplementation);
    const [, init] = fetchImplementation.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ runtimeBinding: binding });

    fetchImplementation.mockClear();
    await expect(registerProject({
      controlPlaneUrl: "https://control.example.test", accessToken: "token", definition, runtimeBinding: { ...binding, subnets: [] },
    }, fetchImplementation)).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe("the SESSION record", () => {
  const workspaceId = randomUUID();
  const ready = {
    workspaceId,
    state: "READY",
    generation: 2,
    volumeId: "vol-0123456789abcdef0",
    availabilityZone: "us-east-1a",
    subnetId: "subnet-0123456789abcdef0",
    instanceId: "i-0123456789abcdef0",
    privateIp: "10.0.12.34",
    launchedAt: now,
    readyAt: now,
    lastActivityAt: now,
    executionArn: `arn:aws:states:us-east-1:${account}:execution:agentx-session-provisioner:ws-${workspaceId}-gen-2`,
  } as const;

  it("shares the workspace partition with its operations", () => {
    expect(workspaceSessionKey(workspaceId)).toEqual({ pk: `WORKSPACE#${workspaceId}`, sk: "SESSION" });
  });

  it("parses each state of the session lifecycle", () => {
    expect(WorkspaceSessionSchema.parse(ready)).toEqual(ready);
    expect(WorkspaceSessionSchema.parse({ workspaceId, state: "NONE", generation: 0 })).toMatchObject({ state: "NONE" });
    expect(WorkspaceSessionSchema.parse({
      workspaceId, state: "PROVISIONING", generation: 1, availabilityZone: "us-east-1a", subnetId: ready.subnetId,
    })).toMatchObject({ state: "PROVISIONING" });
    const withoutInstance: Partial<typeof ready> = { ...ready };
    delete withoutInstance.instanceId;
    delete withoutInstance.privateIp;
    expect(WorkspaceSessionSchema.parse({ ...withoutInstance, state: "STOPPED" })).toMatchObject({ state: "STOPPED" });
    expect(WorkspaceSessionSchema.parse({ ...ready, state: "STOPPING" })).toMatchObject({ state: "STOPPING" });
    expect(WorkspaceSessionSchema.parse({ ...withoutInstance, state: "DELETED" })).toMatchObject({ state: "DELETED" });
    for (const state of ["FAILED", "DELETING"] as const) {
      expect(WorkspaceSessionSchema.parse({ ...ready, state })).toMatchObject({ state });
    }
  });

  it("refuses records whose fields contradict their state", () => {
    const withoutIp: Partial<typeof ready> = { ...ready };
    delete withoutIp.privateIp;
    expect(() => WorkspaceSessionSchema.parse(withoutIp)).toThrow(/privateIp is required while READY/);
    expect(() => WorkspaceSessionSchema.parse({ ...ready, state: "STOPPED" })).toThrow(/instanceId must be absent once STOPPED/);
    expect(() => WorkspaceSessionSchema.parse({ workspaceId, state: "NONE", generation: 1 })).toThrow(/generation is 0/);
    expect(() => WorkspaceSessionSchema.parse({ workspaceId, state: "NONE", generation: 0, volumeId: ready.volumeId }))
      .toThrow(/volumeId must be absent/);
    expect(() => WorkspaceSessionSchema.parse({ workspaceId, state: "FAILED", generation: 1, volumeId: ready.volumeId }))
      .toThrow(/availabilityZone is required with a volume/);
    expect(() => WorkspaceSessionSchema.parse({ workspaceId, state: "PROVISIONING", generation: 1 }))
      .toThrow(/availabilityZone is required while provisioning/);
    expect(() => WorkspaceSessionSchema.parse({ ...ready, state: "RUNNING" })).toThrow();
    expect(() => WorkspaceSessionSchema.parse({ ...ready, privateIp: "10.0.12" })).toThrow();
    expect(() => WorkspaceSessionSchema.parse({ ...ready, extra: true })).toThrow();
  });
});

describe("the worker invoke token", () => {
  it("names the workspace, generation, operation and fence, and expires in epoch seconds", () => {
    const claims = {
      workspaceId: randomUUID(),
      generation: 1,
      operationId: randomUUID(),
      fence: 3,
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
    };
    expect(WorkerInvokeTokenClaimsSchema.parse(claims)).toEqual(claims);
    expect(() => WorkerInvokeTokenClaimsSchema.parse({ ...claims, generation: 0 })).toThrow();
    expect(() => WorkerInvokeTokenClaimsSchema.parse({ ...claims, expiresAt: new Date().toISOString() })).toThrow();
    expect(() => WorkerInvokeTokenClaimsSchema.parse({ ...claims, runtimeSessionId: randomUUID() })).toThrow();
  });
});

describe("ec2-ebs outbox records", () => {
  const operationId = randomUUID();
  const workspaceId = randomUUID();
  const record = {
    id: randomUUID(),
    entityType: "OUTBOX",
    status: "QUEUED",
    operationId,
    workspaceId,
    deploymentMode: "ec2-ebs",
    invocation: {
      protocolVersion: 1, operationId, workspaceId, kind: "resume", fence: 1, projectRevision: 1,
      callbackCapability: "c".repeat(64), payload: {},
    },
  } as const;

  it("are never sent to AgentCore", async () => {
    const invoke = vi.fn(async () => ({ statusCode: 200 }));
    const markDelivered = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({
      invoke, markDispatching: vi.fn(async () => true), markDelivered, markFailed: vi.fn(async () => undefined), log: () => undefined,
    });
    const result = await handler({ Records: [{ messageId: "m1", body: JSON.stringify(record) }] });
    expect(invoke).not.toHaveBeenCalled();
    expect(markDelivered).not.toHaveBeenCalled();
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
  });

  it("wait outside the queue and are re-published when moved back to PENDING", async () => {
    const send = vi.fn(async () => undefined);
    const markQueued = vi.fn(async () => undefined);
    const handler = createOutboxPublisherHandler({ send, markQueued });
    const image = (status: string) => ({
      entityType: { S: "OUTBOX" }, status: { S: status }, id: { S: record.id }, deploymentMode: { S: "ec2-ebs" },
    });
    await handler({ Records: [{ eventName: "MODIFY", dynamodb: { NewImage: image("WAITING_FOR_SESSION") } }] });
    expect(send).not.toHaveBeenCalled();
    await handler({ Records: [{ eventName: "MODIFY", dynamodb: { NewImage: image("PENDING") } }] });
    expect(send).toHaveBeenCalledOnce();
    expect(markQueued).toHaveBeenCalledWith(record.id);
  });
});

describe("an ec2-ebs project in the broker", () => {
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
  const member = "U0123456789";
  const admin = { subject: "admin-subject", admin: true };
  const definition = {
    name: "payments",
    revision: 1,
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate work.",
  };

  beforeAll(async () => {
    await loadSlackBroker();
  });

  async function registerEc2Project(handler: Parameters<typeof call>[0], runtimeBinding: Record<string, unknown> = binding) {
    return call(handler, { method: "POST", path: "/v1/admin/projects", user: admin, body: { definition, runtimeBinding } });
  }

  it("registers idempotently, prepares with an ec2-ebs outbox record, and refuses to close without releasing the volume", async () => {
    const { db, handler, deleteWorkspaceSession } = createBroker();
    expect((await registerEc2Project(handler)).body).toMatchObject({ duplicate: false });
    const { deploymentMode, ...rest } = binding;
    expect((await registerEc2Project(handler, { ...rest, deploymentMode })).body).toMatchObject({ duplicate: true });
    expect((await call(handler, {
      method: "PUT", path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${SLACK_CHANNEL}`, user: admin, body: { projectName: "payments" },
    })).status).toBe(200);

    const ensured = await lazyEnsureWorkspace(handler, thread, member);
    expect(ensured.status).toBe(200);
    const workspaceId = ensured.body.workspaceId as string;
    const unprepared = db.get(`WORKSPACE#${workspaceId}`, "META");
    expect(unprepared).toMatchObject({ deploymentMode: "ec2-ebs", status: "UNPREPARED" });
    for (const field of ["runtimeArn", "endpointQualifier", "runtimeSessionId", "capacityProviderArn"]) {
      expect(unprepared).not.toHaveProperty(field);
    }

    const prepared = await prepareThread(handler, thread, member);
    expect(prepared.status).toBe(200);
    const operationId = prepared.body.operationId as string;
    const [outbox] = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId);
    expect(outbox).toMatchObject({ status: "PENDING", workspaceId, deploymentMode: "ec2-ebs" });
    for (const field of ["runtimeArn", "endpointQualifier", "runtimeSessionId"]) expect(outbox).not.toHaveProperty(field);

    await finishOperation(handler, db, workspaceId, operationId, "SUCCEEDED");
    markReady(db, workspaceId);
    const closing = await serviceCall(handler, thread, member, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(closing.status).toBe(202);
    const closeOperationId = closing.body.operationId as string;
    await finishOperation(handler, db, workspaceId, closeOperationId, "SUCCEEDED", { safeToClose: true, repositories: [] });
    const completed = await serviceCall(handler, thread, member, "POST", "/v1/service/threads/workspace/close/complete", {
      requestId: randomUUID(), operationId: closeOperationId,
    });
    expect(completed.status).toBe(503);
    expect(JSON.stringify(completed.body)).toMatch(/ec2-ebs workspace is not supported yet/);
    expect(deleteWorkspaceSession).not.toHaveBeenCalled();
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSING" });
  });
});
