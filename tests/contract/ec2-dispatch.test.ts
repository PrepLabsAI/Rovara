import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Ec2RuntimeBinding, WorkerInvocation } from "../../packages/contracts/src/index.js";
import { createDispatcherHandler, workerPingFeatures } from "../../packages/broker/src/aws/dispatcher.js";
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

    it("keeps the level for a worker whose /ping lists the feature", async () => {
      const workerFeatures = vi.fn<NonNullable<Ec2DeliveryDependencies["workerFeatures"]>>(async () => ["model.thinkingLevel"]);
      const { deliver, post } = delivery({ workerFeatures });
      const record = taskRecord(leveled);
      expect(await deliver(record, record.invocation)).toBe("DELIVERED");
      expect(workerFeatures).toHaveBeenCalledExactlyOnceWith("http://10.42.128.10:8080/ping");
      expect(posted(post)).toEqual(leveled);
    });

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

    it("fails the attempt, posting nothing, when the worker's /ping does not answer", async () => {
      // The worker journals the whole invocation's hash: a retry must send what this attempt would have.
      const { deliver, post } = delivery({ workerFeatures: async () => { throw new Error("timeout"); } });
      const record = taskRecord(leveled);
      await expect(deliver(record, record.invocation)).rejects.toThrow(/RUNTIME_UNAVAILABLE: could not ask the EC2 worker .*timeout/);
      expect(post).not.toHaveBeenCalled();
    });

    it("drops the level when the dispatcher has no way to ask the worker", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { deliver, post } = delivery();
      const record = taskRecord(leveled);
      await deliver(record, record.invocation);
      expect(posted(post)).toEqual({ provider: "amazon-bedrock", modelId: "fast" });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ reason: "no-probe", requestedThinkingLevel: "low" }));
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

    describe("a project definition carried by prepare and publish", () => {
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
      function projectRecord(kind: "prepare" | "publish", projectModels: unknown): Ec2OutboxRecord {
        const record = recordFor();
        const payload = kind === "prepare"
          ? { project: projectWith(projectModels), repositoryGrant: "signed-grant" }
          : {
            project: projectWith(projectModels), repository: "api", title: "Fix it", headBranch: `agentx/${randomUUID()}`,
            repositoryGrant: "signed-grant", mode: "create",
          };
        return { ...record, invocation: { ...record.invocation, kind, payload } as unknown as WorkerInvocation };
      }
      const postedModels = (post: ReturnType<typeof delivery>["post"]) =>
        (JSON.parse(post.mock.calls[0]![1].body) as { payload: { project: { models?: unknown } } }).payload.project.models;

      for (const kind of ["prepare", "publish"] as const) {
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

        it(`${kind}: fails the attempt, posting nothing, when the worker's /ping does not answer`, async () => {
          const { deliver, post } = delivery({ workerFeatures: async () => { throw new Error("timeout"); } });
          const record = projectRecord(kind, models);
          await expect(deliver(record, record.invocation)).rejects.toThrow(/RUNTIME_UNAVAILABLE: could not ask the EC2 worker .*timeout/);
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

    it("does not ask the worker when the invocation carries no level", async () => {
      const workerFeatures = vi.fn(async () => []);
      const { deliver, post } = delivery({ workerFeatures });
      const record = taskRecord({ provider: "amazon-bedrock", modelId: "fast" });
      await deliver(record, record.invocation);
      expect(workerFeatures).not.toHaveBeenCalled();
      expect(JSON.parse(post.mock.calls[0]![1].body)).toEqual(record.invocation);
    });
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
    const markDelivered = vi.fn(async () => undefined);
    const markFailed = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered, markFailed, deliverEc2, log: () => undefined });
    return { handler, markDelivered, markFailed };
  }

  it("acknowledges a parked record without marking it delivered or using a retry", async () => {
    const { handler, markDelivered } = dispatcher(async () => "WAITING_FOR_SESSION");
    const record = recordFor();
    expect(await handler({ Records: [{ messageId: "m1", body: JSON.stringify(record) }] })).toEqual({ batchItemFailures: [] });
    expect(markDelivered).not.toHaveBeenCalled();
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
    db.set({ pk: `WORKSPACE#${record.workspaceId}`, sk: "META", entityType: "WORKSPACE", deploymentMode: "ec2-ebs" as const, projectName: "ec2-test", projectRevision: 1, activeOperationId: record.operationId, fence: 2 });
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

describe("the runtime binding a session is started with", () => {
  it("reads the workspace record strongly consistently, because preparation may have just moved its revision (#12)", async () => {
    const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
      const key = command.input.Key as { pk: string };
      if (key.pk.startsWith("WORKSPACE#")) return { Item: { deploymentMode: "ec2-ebs", projectName: "payments", projectRevision: 2 } };
      return { Item: { runtimeBinding: binding } };
    });
    const workspaceId = randomUUID();
    await expect(workspaceBinding({ send } as never, "state", workspaceId)).resolves.toEqual(binding);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" }, ConsistentRead: true });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({ Key: { pk: "PROJECT#payments", sk: `REV#${"2".padStart(12, "0")}` } });
  });
});
