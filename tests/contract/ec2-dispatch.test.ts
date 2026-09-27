import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Ec2RuntimeBinding, WorkerInvocation } from "../../packages/contracts/src/index.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { STARTING_COMPUTE_MESSAGE, createEc2Delivery, type Ec2Delivery, type Ec2DeliveryDependencies } from "../../packages/broker/src/aws/ec2-delivery.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { appendOperationEvent } from "../../packages/broker/src/aws/operation-events.js";
import { SessionManager, workspaceBinding } from "../../packages/broker/src/aws/sessions.js";
import { verifyInvokeAuthorization, invocationMatchesClaims } from "../../packages/worker/src/invoke-auth.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
// What KMS Sign returns for ECDSA_SHA_256 on an ECC_NIST_P256 key: a DER signature over the message.
const kmsSign = async (message: Uint8Array) => new Uint8Array(sign("sha256", message, keys.privateKey));
const binding: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs",
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }],
  volumeSizeGiB: 20,
  volumeType: "gp3",
};

function recordFor(workspaceId = randomUUID(), fence = 2): Ec2OutboxRecord {
  const operationId = randomUUID();
  const invocation: WorkerInvocation = {
    protocolVersion: 1, kind: "resume", operationId, workspaceId, fence, projectRevision: 1, callbackCapability: "c".repeat(64), payload: {},
  };
  return { id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId, deploymentMode: "ec2-ebs", invocation };
}

function delivery(overrides: Partial<Ec2DeliveryDependencies> = {}) {
  const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{\"accepted\":true}" }));
  const progress = vi.fn<Ec2DeliveryDependencies["progress"]>(async () => undefined);
  const deliver = createEc2Delivery({
    sessions: { ensureSession: async () => ({ ready: true, generation: 3, privateIp: "10.42.128.10" }) },
    binding: async () => binding,
    sign: kmsSign,
    post,
    progress,
    now: () => NOW,
    ...overrides,
  });
  return { deliver, post, progress };
}

describe("ec2-ebs delivery", () => {
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

  it("parks the record and records one progress event while the session is not ready", async () => {
    const { deliver, post, progress } = delivery({ sessions: { ensureSession: async () => ({ ready: false, generation: 1, state: "PROVISIONING" }) } });
    const record = recordFor();
    expect(await deliver(record, record.invocation)).toBe("WAITING_FOR_SESSION");
    expect(progress).toHaveBeenCalledExactlyOnceWith(record, STARTING_COMPUTE_MESSAGE);
    expect(post).not.toHaveBeenCalled();
  });

  it("fails an attempt when the worker refuses, and when the workspace has no ec2-ebs binding", async () => {
    const refused = delivery({ post: async () => ({ status: 401, body: "{\"reason\":\"expired\"}" }) });
    const record = recordFor();
    await expect(refused.deliver(record, record.invocation)).rejects.toThrow(/RUNTIME_UNAVAILABLE: EC2 worker returned HTTP 401/);
    const unbound = delivery({ binding: async () => undefined });
    await expect(unbound.deliver(record, record.invocation)).rejects.toThrow(/CONFIG_INVALID/);
  });
});

describe("the dispatcher with ec2-ebs records", () => {
  function dispatcher(deliverEc2: (record: Ec2OutboxRecord, invocation: WorkerInvocation) => Promise<Ec2Delivery>) {
    const invoke = vi.fn(async () => ({ statusCode: 200 }));
    const markDelivered = vi.fn(async () => undefined);
    const markFailed = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ invoke, markDispatching: async () => true, markDelivered, markFailed, deliverEc2, log: () => undefined });
    return { handler, invoke, markDelivered, markFailed };
  }

  it("acknowledges a parked record without marking it delivered or using a retry", async () => {
    const { handler, invoke, markDelivered } = dispatcher(async () => "WAITING_FOR_SESSION");
    const record = recordFor();
    expect(await handler({ Records: [{ messageId: "m1", body: JSON.stringify(record) }] })).toEqual({ batchItemFailures: [] });
    expect(markDelivered).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("marks a delivered record DELIVERED, and retries a failed delivery", async () => {
    const delivered = dispatcher(async () => "DELIVERED");
    const record = recordFor();
    await delivered.handler({ Records: [{ messageId: "m1", body: JSON.stringify(record) }] });
    expect(delivered.markDelivered).toHaveBeenCalledWith(record.id);
    expect(delivered.invoke).not.toHaveBeenCalled();

    const failing = dispatcher(async () => { throw new Error("connect ECONNREFUSED"); });
    expect(await failing.handler({ Records: [{ messageId: "m2", body: JSON.stringify(record), attributes: { ApproximateReceiveCount: "1" } }] }))
      .toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
    expect(failing.markFailed).not.toHaveBeenCalled();
  });
});

describe("ec2-ebs delivery through the real session manager", () => {
  it("parks the first delivery with one event, re-queues it when ready, then delivers it", async () => {
    const db = new FakeDynamoDb();
    const start = vi.fn(async ({ name }: { name: string }) => `arn:aws:states:us-east-1:111122223333:execution:provisioner:${name}`);
    const sessions = new SessionManager({
      documentClient: db, tableName: "state",
      executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:provisioner", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:deleter", start },
    });
    const record = recordFor();
    db.set({ pk: `WORKSPACE#${record.workspaceId}`, sk: "META", entityType: "WORKSPACE", deploymentMode: "ec2-ebs", projectName: "ec2-test", projectRevision: 1, activeOperationId: record.operationId, fence: 2 });
    db.set({ pk: "PROJECT#ec2-test", sk: "REV#000000000001", entityType: "PROJECT", runtimeBinding: binding });
    db.set({ pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}`, status: "DISPATCHING", fence: 2, eventSequence: 0 });
    db.set({ pk: `OUTBOX#${record.id}`, sk: "OUTBOX", ...record });
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async () => ({ status: 200, body: "{}" }));
    const deliver = createEc2Delivery({
      sessions,
      binding: (workspaceId) => workspaceBinding(db, "state", workspaceId),
      sign: kmsSign,
      post,
      progress: (parked, message) => appendOperationEvent(db, "state", {
        workspaceId: parked.workspaceId, operationId: parked.operationId, fence: parked.invocation.fence, onceKey: `session-wait#${parked.id}`,
        event: { type: "progress", timestamp: new Date(NOW).toISOString(), payload: { message } },
      }),
      now: () => NOW,
    });

    expect(await deliver(record, record.invocation)).toBe("WAITING_FOR_SESSION");
    // A duplicate SQS delivery of the parked record adds no second event.
    expect(await deliver(record, record.invocation)).toBe("WAITING_FOR_SESSION");
    expect(start).toHaveBeenCalledOnce();
    expect(db.get(`OUTBOX#${record.id}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_SESSION" });
    const events = db.find((item) => item.entityType === "EVENT" && item.operationId === record.operationId);
    expect(events).toEqual([expect.objectContaining({ type: "progress", sequence: 1, payload: { message: STARTING_COMPUTE_MESSAGE } })]);
    expect(db.get(`WORKSPACE#${record.workspaceId}`, `OPERATION#${record.operationId}`)).toMatchObject({ eventSequence: 1 });

    await sessions.markVolume(record.workspaceId, 1, "vol-0123456789abcdef0");
    await sessions.markInstance(record.workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10");
    expect(await sessions.markReady(record.workspaceId, 1)).toEqual({ requeued: [record.id] });
    expect(db.get(`OUTBOX#${record.id}`, "OUTBOX")).toMatchObject({ status: "PENDING" });

    expect(await deliver(record, record.invocation)).toBe("DELIVERED");
    expect(post.mock.calls[0]![0]).toBe("http://10.42.128.10:8080/invocations");
    expect(verifyInvokeAuthorization(post.mock.calls[0]![1].authorization, {
      publicKey: keys.publicKey, workspaceId: record.workspaceId, generation: 1, now: () => Math.floor(NOW / 1_000),
    }).ok).toBe(true);
  });
});
