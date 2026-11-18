import { agentModelIdentity, TestEnvironmentBodySchema, testEnvDigest } from "@agentx/contracts";
import { documentOf } from "../../packages/broker/src/core/test-env/deps.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";
import { createAgentModelChoice } from "../../packages/broker/src/core-host/gateway-model-selection.js";
import { modelSelectionPolicyKey } from "../../packages/broker/src/core/model-selection/policy-store.js";
// Engine host (lane E2, step 4): the dispatcher Lambda as the host of the core's dispatch, over Code's EC2 session machines. Ported from the monolith's host test.
// The core's task flow (on the in-memory store and queue) starts tasks for two companies; their dispatch messages reach the dispatcher as an SQS batch from the core queue, the core hands
// each operation to that company's EC2 machines, and the worker (which checks each token as the real one does, and lists the real worker's features) is given each job once.
// Also: the router keeps today's dispatch path exactly as it was (the legacy template installs no router; a core record never reaches today's code), and the dispatcher's own core
// refuses in fixed words what it does not have.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CORE_ENGINE_VARIABLE, change, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition, type QueueService } from "@agentx/contracts";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { createAllowAllAdmission, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { createTaskFlow, TASK_FLOW_INDEXES, type TaskFlow } from "../../packages/broker/src/core/task-flow/flow.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { LambdaBatchQueue, coreDispatchMessage, createCoreDispatchHost, type CoreDispatchHostDependencies } from "../../packages/broker/src/aws/worker-machines/core-dispatch-host.js";
import {
  DISPATCHER_CORE_NOT_CONFIGURED, DISPATCHER_FLOW_DECLARATIONS, DISPATCHER_FLOW_NOT_DECLARED, NO_CODE_HOST_HERE, NO_PEOPLE_HERE, createDispatcherCoreHost, dispatcherStopInstance, evalGatewayOf, hostedDispatcherFlow, refusingCodeHost, refusingTaskAccess, repositoryGrantKeyOf, withCoreDispatch,
} from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import { COMPANY_A, COMPANY_B, createSessionMachinesWorld } from "../support/session-machines-world.js";
import { CoreRegistryError } from "../../packages/broker/src/core-host/registry.js";
import { createCoreHostApp, DispatchOnlyMergeTrackingError, DISPATCH_ONLY_MERGE_TRACKING_REFUSED } from "../../packages/broker/src/core-host/app.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { createFakeOfferedModels } from "../support/offered-models-fake.js";
import { COMPANY_ENGINE_MODEL_UNREADABLE, companyEngineModelKey } from "../../packages/broker/src/core-host/company-engine-model.js";
import { FakeDynamoDb } from "../support/ports/dynamodb-fake.js";
import { FakeSqs } from "../support/ports/sqs-fake.js";
import { FakeS3 } from "../support/ports/aws-fakes.js";

const CORE_QUEUE_ARN = "arn:aws:sqs:us-west-2:111122223333:agentx-staging-core-dispatch";
const TODAY_QUEUE_ARN = "arn:aws:sqs:us-west-2:111122223333:agentx-staging-dispatch";
const definition: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};

interface SqsRecord { messageId: string; receiptHandle: string; body: string; eventSource: string; eventSourceARN: string; attributes: { ApproximateReceiveCount: string } }

/** The core's task flow for two companies on one store and one queue, and the EC2 machines of each through one fleet. */
async function createWorld(options: { enabled?: boolean } = {}) {
  const machinesWorld = createSessionMachinesWorld();
  const store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
  const queues = new MemoryQueueService();
  const grants = new RepositoryGrantService(Buffer.alloc(32, 5), async () => ({ token: "unused", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) as never);
  const companyOfWorkspace = workspaceCompanyReader({ send: async (command: unknown) => {
    if (!(command instanceof GetCommand)) throw new Error("unexpected command");
    return { Item: await store.get(command.input.Key as { pk: string; sk: string }) };
  } } as never, "state");
  const fleet = machinesWorld.fleet({ companyOfWorkspace });
  const depsOf = (companyId: OrgId, dispatchQueues: QueueService = queues): TaskFlowDeps => ({
    companyId, store, queues: dispatchQueues, outbox: createTransactionalOutbox({ store, queues }),
    machines: fleet.forCompany(companyId),
    admission: createAllowAllAdmission(), audit: createNoopAuditSink(), projects: createStoreProjectSource(store, companyId), access: createOwnerTaskAccess(),
    repositoryGrants: grants, callbackSigningKey: Buffer.alloc(32, 9), limits: { member: 5, organization: 20 },
  });
  const flows = new Map<OrgId, TaskFlow>();
  for (const company of [COMPANY_A, COMPANY_B]) {
    await store.put({ item: { ...projectRevisionKey(company, definition.name, definition.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as JsonValue } });
    await store.put({ item: { ...orgProjectCatalogKey(company, definition.name), entityType: "PROJECT_CATALOG", latestRevision: definition.revision } });
    flows.set(company, createTaskFlow(depsOf(company)));
  }
  const changeVisibility = vi.fn<CoreDispatchHostDependencies["changeVisibility"]>(async () => undefined);
  const depsFor = vi.fn((companyId: OrgId, dispatchQueues: Parameters<CoreDispatchHostDependencies["depsFor"]>[1]) => depsOf(companyId, dispatchQueues));
  const host = createCoreDispatchHost({ enabled: () => options.enabled ?? true, companyOfWorkspace, depsFor, changeVisibility, log: () => undefined });
  const deliverEc2 = vi.fn(async () => "DELIVERED" as const);
  const markDispatching = vi.fn(async () => true);
  const today = vi.fn(createDispatcherHandler({ deliverEc2, markDispatching, markDelivered: async () => undefined, markFailed: async () => undefined, maxAttempts: 50, log: () => undefined }));
  const serves = vi.fn(() => options.enabled ?? true);
  const handler = withCoreDispatch(today, { coreQueueArn: CORE_QUEUE_ARN, serves, host: async () => host, log: () => undefined });
  /** Takes the core's staged dispatch messages off its queue, as the outbox relay would put them on SQS. */
  const staged = async (): Promise<SqsRecord[]> => {
    const queue = await queues.queue("task-dispatch");
    const messages = await queue.receive({ maxMessages: 10 });
    for (const message of messages) await queue.ack(message.receiptHandle);
    return messages.map((message) => ({ messageId: randomUUID(), receiptHandle: `rh-${randomUUID()}`, body: JSON.stringify(message.body), eventSource: "aws:sqs", eventSourceARN: CORE_QUEUE_ARN, attributes: { ApproximateReceiveCount: "1" } }));
  };
  const again = (record: SqsRecord): SqsRecord => ({ ...record, receiptHandle: `rh-${randomUUID()}`, attributes: { ApproximateReceiveCount: String(Number(record.attributes.ApproximateReceiveCount) + 1) } });
  const start = async (company: OrgId) => (await flows.get(company)!.start({ principal: localOwnerPrincipal({ companyId: company }), client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint" })).task;
  return { depsOf, machinesWorld, fleet, store, flows, host, handler, today, serves, deliverEc2, markDispatching, changeVisibility, depsFor, staged, again, start };
}

const failures = (answer: unknown) => (answer as { batchItemFailures: Array<{ itemIdentifier: string }> }).batchItemFailures.map((failure) => failure.itemIdentifier);

describe("the dispatcher as the host of the core's dispatch", () => {
  it("hands each operation to its own company's EC2 machine, once, after the machine is ready, and acknowledges it only then", async () => {
    const w = await createWorld();
    const taskA = await w.start(COMPANY_A);
    const taskB = await w.start(COMPANY_B);
    let batch = await w.staged();
    expect(batch).toHaveLength(2);
    // What the core stages carries its company (accept.ts), and the host reads it strictly.
    expect(batch.map((record) => coreDispatchMessage(record.body)?.companyId).sort()).toEqual([COMPANY_A, COMPANY_B]);

    // First receive: both machines are starting. Nothing is sent, each record is hidden to come back (never deleted), and each company got its own deps.
    expect(failures(await w.handler({ Records: batch }))).toEqual(batch.map((record) => record.messageId));
    expect(w.changeVisibility).toHaveBeenCalledTimes(2);
    expect(w.changeVisibility.mock.calls.map(([handle]) => handle).sort()).toEqual(batch.map((record) => record.receiptHandle).sort());
    expect(w.depsFor.mock.calls.map(([company]) => company).sort()).toEqual([COMPANY_A, COMPANY_B]);
    expect(w.machinesWorld.posts).toEqual([]);
    await w.machinesWorld.settle();

    // Second receive: both ready; each job goes to the instance of its own workspace, the token passes the worker's own check, and both records are done.
    batch = batch.map(w.again);
    expect(failures(await w.handler({ Records: batch }))).toEqual([]);
    const accepted = w.machinesWorld.posts.filter((post) => post.status === 200);
    expect(accepted.map((post) => post.workspaceId).sort()).toEqual([taskA.workspaceId, taskB.workspaceId].sort());
    for (const instance of w.machinesWorld.instances.values()) expect(instance.accepted.size).toBe(1);
    // Today's path saw none of it.
    expect(w.today).not.toHaveBeenCalled();
    expect(w.deliverEc2).not.toHaveBeenCalled();
    expect(w.markDispatching).not.toHaveBeenCalled();

    // SQS delivers a record again: the worker is handed the same operation, says it already has it, and runs it once.
    expect(failures(await w.handler({ Records: [w.again(batch[0]!)] }))).toEqual([]);
    for (const instance of w.machinesWorld.instances.values()) expect(instance.accepted.size).toBe(1);
    expect(w.machinesWorld.posts.filter((post) => post.status !== 200)).toEqual([]);
  });

  it("keeps the core's fences: a job whose workspace was closed before the machine was ready is ended, never sent, and its machine is ended", async () => {
    const w = await createWorld();
    const task = await w.start(COMPANY_A);
    const batch = await w.staged();
    expect(failures(await w.handler({ Records: batch }))).toHaveLength(1);
    await w.machinesWorld.settle();
    await w.flows.get(COMPANY_A)!.close({ principal: localOwnerPrincipal({ companyId: COMPANY_A }), client: "test", origin: "app" }, task.taskId);
    await w.machinesWorld.settle();
    expect(failures(await w.handler({ Records: batch.map(w.again) }))).toEqual([]);
    expect(w.machinesWorld.posts).toEqual([]);
    expect([...w.machinesWorld.instances.values()].filter((instance) => instance.running)).toEqual([]);
  });

  it("never runs a message whose workspace belongs to another company than the message names: it comes back, and no company's core is asked", async () => {
    const w = await createWorld();
    const taskA = await w.start(COMPANY_A);
    const [record] = await w.staged();
    const workspace = (await w.store.get(workspaceKey(COMPANY_A, taskA.workspaceId)))!;
    await w.store.put({ item: { ...workspace, companyId: COMPANY_B } });
    expect(failures(await w.handler({ Records: [record!] }))).toEqual([record!.messageId]);
    expect(w.depsFor).not.toHaveBeenCalled();
    expect(w.changeVisibility).not.toHaveBeenCalled();
    expect(w.machinesWorld.executions).toEqual([]);
    expect(w.machinesWorld.posts).toEqual([]);
    // Rewriting the message cannot change the immutable pointer: A's pointer and B's corrupt scoped row disagree, so routing still refuses.
    const rewritten = { ...w.again(record!), body: JSON.stringify({ ...JSON.parse(record!.body), companyId: COMPANY_B }) };
    expect(failures(await w.handler({ Records: [rewritten] }))).toEqual([rewritten.messageId]);
    expect(w.depsFor).not.toHaveBeenCalled();
    expect(w.machinesWorld.executions).toEqual([]);
  });

  it("takes nothing with the switch off: a core record comes back without reaching today's handler or the core", async () => {
    const off = await createWorld({ enabled: false });
    await off.start(COMPANY_A);
    const batch = await off.staged();
    expect(failures(await off.handler({ Records: batch }))).toEqual([batch[0]!.messageId]);
    expect(off.today).not.toHaveBeenCalled();
    expect(off.depsFor).not.toHaveBeenCalled();
    expect(off.machinesWorld.executions).toEqual([]);
    // The host itself takes nothing while off, even if asked.
    expect(off.host.take(batch)).toEqual(new Set());
  });

  it("keeps a record whose dead-letter move failed: it comes back, it is never deleted and lost", async () => {
    const record = { messageId: "m-1", receiptHandle: "rh-1", body: JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId: randomUUID(), operationId: randomUUID() }) };
    const failing = new LambdaBatchQueue("task-dispatch", [record], { changeVisibility: async () => undefined, deadLetter: async () => { throw new Error("AccessDenied"); } });
    const [received] = await failing.receive();
    await expect(failing.deadLetter(received!.receiptHandle, "malformed")).rejects.toThrow("AccessDenied");
    expect(failing.failures()).toEqual(["m-1"]);
    // Positive control: a dead-letter move that succeeds lets Lambda delete the record.
    const moved: string[] = [];
    const working = new LambdaBatchQueue("task-dispatch", [record], { changeVisibility: async () => undefined, deadLetter: async (dead) => { moved.push(dead.messageId); } });
    const [again] = await working.receive();
    expect(await working.deadLetter(again!.receiptHandle, "malformed")).toBe(true);
    expect(moved).toEqual(["m-1"]);
    expect(working.failures()).toEqual([]);
  });

  it("runs nothing when the core's deps carry another company's machines: a wiring fault, the records come back and no operation is ended", async () => {
    const w = await createWorld();
    const task = await w.start(COMPANY_A);
    const [record] = await w.staged();
    w.depsFor.mockImplementationOnce((companyId, dispatchQueues) => ({ ...w.depsOf(companyId, dispatchQueues), machines: w.fleet.forCompany(COMPANY_B) }));
    expect(failures(await w.handler({ Records: [record!] }))).toEqual([record!.messageId]);
    expect(w.machinesWorld.executions).toEqual([]);
    expect((await w.store.get(workspaceKey(COMPANY_A, task.workspaceId)))!.status).not.toBe("CLOSED");
    // The same fault with the unbound fleet (a root that forgot to bind it): also refused before anything runs.
    w.depsFor.mockImplementationOnce((companyId, dispatchQueues) => ({ ...w.depsOf(companyId, dispatchQueues), machines: w.fleet }));
    expect(failures(await w.handler({ Records: [w.again(record!)] }))).toEqual([record!.messageId]);
    expect(w.machinesWorld.executions).toEqual([]);
    // The next delivery, wired right, goes ahead.
    expect(failures(await w.handler({ Records: [w.again(record!)] }))).toEqual([record!.messageId]);
    expect(w.machinesWorld.executions).toHaveLength(1);
  });

  it("delivers a queued cancel (money stop) to the worker of an operation being stopped, through the host, and drops one for an operation that is not", async () => {
    const w = await createWorld();
    const task = await w.start(COMPANY_A);
    const batch = await w.staged();
    await w.handler({ Records: batch });
    await w.machinesWorld.settle();
    expect(failures(await w.handler({ Records: batch.map(w.again) }))).toEqual([]);
    const operationId = coreDispatchMessage(batch[0]!.body)!.operationId;
    const cancelRecord = (cancel: string): SqsRecord => ({ ...batch[0]!, messageId: randomUUID(), receiptHandle: `rh-${randomUUID()}`, body: JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId: task.workspaceId, operationId, cancel }) });
    const before = w.machinesWorld.posts.length;
    // Not being stopped: taken by the host, and dropped (acknowledged, never sent).
    expect(failures(await w.handler({ Records: [cancelRecord(randomUUID())] }))).toEqual([]);
    expect(w.machinesWorld.posts).toHaveLength(before);
    // Being stopped: the cancel goes to its worker, once.
    await w.store.update({ key: operationKey(COMPANY_A, task.workspaceId, operationId), ops: [change.set("status", "CANCEL_REQUESTED")] });
    const cancel = randomUUID();
    expect(failures(await w.handler({ Records: [cancelRecord(cancel)] }))).toEqual([]);
    expect(w.machinesWorld.posts.slice(before)).toEqual([expect.objectContaining({ status: 200, workspaceId: task.workspaceId, operationId: cancel })]);
    expect(w.today).not.toHaveBeenCalled();
  });

  it("reads a core message strictly: exactly its four fields (and a cancel's own id), version 1, a company id and two UUIDs", () => {
    const workspaceId = randomUUID();
    const operationId = randomUUID();
    const cancel = randomUUID();
    expect(coreDispatchMessage(JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId, operationId }))).toEqual({ v: 1, companyId: COMPANY_A, workspaceId, operationId });
    expect(coreDispatchMessage(JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId, operationId, cancel }))).toEqual({ v: 1, companyId: COMPANY_A, workspaceId, operationId, cancel });
    for (const bad of ["x", 1, null, "not-a-uuid"]) expect(coreDispatchMessage(JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId, operationId, cancel: bad }))).toBeUndefined();
    expect(coreDispatchMessage(JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId, operationId, cancel, extra: 1 }))).toBeUndefined();
    for (const body of [
      JSON.stringify({ v: 1, workspaceId, operationId }), JSON.stringify({ v: 2, companyId: COMPANY_A, workspaceId, operationId }),
      JSON.stringify({ v: 1, companyId: "acme", workspaceId, operationId }), JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId, operationId, invocation: {} }),
      JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId: "ws-1", operationId }), JSON.stringify([1]), "not json", JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId }),
      JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId, operationId, pad: "x".repeat(2_000) }), " ".repeat(2_000),
    ]) expect(coreDispatchMessage(body)).toBeUndefined();
  });

  it("never drops a record it could not place: an unknown workspace, a message that is not the core's, or a fault in the core, leaves the record to come back", async () => {
    const w = await createWorld();
    const record = (body: unknown) => ({ messageId: randomUUID(), receiptHandle: "rh-1", eventSource: "aws:sqs", eventSourceARN: CORE_QUEUE_ARN, attributes: { ApproximateReceiveCount: "1" }, body: JSON.stringify(body) });
    const unknown = record({ v: 1, companyId: COMPANY_A, workspaceId: randomUUID(), operationId: randomUUID() });
    expect(failures(await w.handler({ Records: [unknown] }))).toEqual([unknown.messageId]);
    // Today's outbox record on the core queue: not the core's, and still never handed to today's handler.
    const outbox = record({ id: randomUUID(), operationId: randomUUID(), workspaceId: randomUUID(), deploymentMode: "ec2-ebs", invocation: { not: "a core message" } });
    expect(failures(await w.handler({ Records: [outbox] }))).toEqual([outbox.messageId]);
    expect(w.depsFor).not.toHaveBeenCalled();
    expect(w.today).not.toHaveBeenCalled();

    await w.start(COMPANY_A);
    const [staged] = await w.staged();
    w.depsFor.mockImplementationOnce(() => { throw new Error("the store is unreachable"); });
    expect(failures(await w.handler({ Records: [staged!] }))).toEqual([staged!.messageId]);
  });
});

describe("the dispatcher's router", () => {
  it("is today's handler itself where the core queue is not configured (the legacy template)", () => {
    const today = createDispatcherHandler({ markDispatching: async () => true, markDelivered: async () => undefined, markFailed: async () => undefined });
    const host = vi.fn();
    for (const coreQueueArn of [undefined, "", "   "]) expect(withCoreDispatch(today, { coreQueueArn, serves: () => true, host })).toBe(today);
    expect(host).not.toHaveBeenCalled();
  });

  it("hands today's records to today's handler exactly as before, and the core's to the core, in one batch", async () => {
    const w = await createWorld();
    await w.start(COMPANY_A);
    const [core] = await w.staged();
    const todays = { messageId: randomUUID(), receiptHandle: "rh-t", eventSource: "aws:sqs", eventSourceARN: TODAY_QUEUE_ARN, attributes: { ApproximateReceiveCount: "1" }, body: "not an outbox record" };
    const answer = await w.handler({ Records: [todays, core!] });
    // Today's handler got only its own record (and fails it, as it fails any record it cannot parse); the core's record came back while its machine starts.
    expect(w.today).toHaveBeenCalledTimes(1);
    expect((w.today.mock.calls[0]![0] as { Records: unknown[] }).Records).toEqual([todays]);
    expect(failures(answer).sort()).toEqual([todays.messageId, core!.messageId].sort());
    expect(w.depsFor).toHaveBeenCalledTimes(1);
    // A batch of today's records alone is passed through untouched, the same event object, and the switch is not even read.
    w.serves.mockClear();
    const event = { Records: [todays] };
    await w.handler(event);
    expect(w.today.mock.calls[1]![0]).toBe(event);
    expect(w.serves).not.toHaveBeenCalled();
  });

  it("reads the switch per batch and, while it is off, neither builds nor asks the core: the core records come back", async () => {
    const host = vi.fn(async () => { throw new Error("must not be built while off"); });
    const today = vi.fn(async () => ({ batchItemFailures: [] }));
    let on = false;
    const logs: Array<Record<string, unknown>> = [];
    const handler = withCoreDispatch(today, { coreQueueArn: CORE_QUEUE_ARN, serves: () => on, host, log: (entry) => logs.push(entry) });
    const record = { messageId: "m-1", receiptHandle: "rh", body: JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId: randomUUID(), operationId: randomUUID() }), eventSourceARN: CORE_QUEUE_ARN };
    expect(failures(await handler({ Records: [record] }))).toEqual(["m-1"]);
    expect(host).not.toHaveBeenCalled();
    expect(today).not.toHaveBeenCalled();
    expect(logs).toEqual([{ event: "dispatch.core_off", records: 1 }]);
    // Switched on between batches: the next batch builds the core (here it fails to, and the record still comes back).
    on = true;
    expect(failures(await handler({ Records: [record] }))).toEqual(["m-1"]);
    expect(host).toHaveBeenCalledTimes(1);
  });

  it("leaves every core record to come back when the core cannot be built, and logs fixed words only", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const today = vi.fn(async () => ({ batchItemFailures: [] }));
    const handler = withCoreDispatch(today, { coreQueueArn: CORE_QUEUE_ARN, serves: () => true, host: async () => { throw new Error("secret-value-123 at arn:aws:secret"); }, log: (entry) => logs.push(entry) });
    const record = { messageId: "m-1", receiptHandle: "rh", body: JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId: randomUUID(), operationId: randomUUID() }), eventSourceARN: CORE_QUEUE_ARN };
    expect(failures(await handler({ Records: [record] }))).toEqual(["m-1"]);
    expect(today).not.toHaveBeenCalled();
    expect(JSON.stringify(logs)).not.toContain("secret-value-123");
    expect(logs).toEqual([{ event: "dispatch.core_unavailable", error: "Error" }]);
  });
});

describe("the core on the dispatcher", () => {
  const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    [CORE_ENGINE_VARIABLE]: `on:${COMPANY_A}`, CORE_DISPATCH_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/111122223333/agentx-staging-core-dispatch",
    CORE_DISPATCH_DEAD_LETTER_URL: "https://sqs.us-west-2.amazonaws.com/111122223333/agentx-staging-core-dispatch-dead", STATE_TABLE_NAME: "State",
    ARTIFACT_BUCKET_NAME: "artifacts", AWS_REGION: "us-west-2", EC2_WORKER_SUBNETS: "us-west-2a=subnet-0aaaaaaaaaaaaaaaa", EC2_WORKER_LAUNCH_TEMPLATE_ID: "lt-0123456789abcdef0", ...overrides,
  });
  // The callback signing key is an input (the dispatcher reads it from Secrets Manager), never part of the environment.
  const inputs = (environment: NodeJS.ProcessEnv, callbackSigningKey = "k".repeat(48)) => {
    const world = createSessionMachinesWorld();
    let clock = Date.now();
    const log = vi.fn();
    return {
      world,
      inputs: {
        env: environment, callbackSigningKey, documentClient: world.db, clients: { dynamo: new FakeDynamoDb({ tableName: "State" }), sqs: new FakeSqs(), s3: new FakeS3({ bucket: "artifacts" }) },
        machines: { sessions: world.sessions, stopInstance: dispatcherStopInstance, sign: (message: Uint8Array) => world.sign(message), post: async () => ({ status: 500, body: "" }), ping: async () => undefined },
        changeVisibility: async () => undefined, log, now: () => new Date(clock),
      } as Parameters<typeof createDispatcherCoreHost>[0],
      advance: (milliseconds: number) => { clock += milliseconds; }, log,
    };
  };

  it("refuses merge tracking on a dispatch-only runtime with a fixed typed error", async () => {
    const world = createFakeWorld();
    const app = createCoreHostApp({
      env: env(), modules: world.modules, context: () => world.context(), dispatchOnly: true, servedCompanies: async () => [],
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: refusingTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(), log: () => undefined, services: () => ({ "merge-tracking": { pass: async () => ({}) } }) }),
    });
    await expect(app.runtimeFor(COMPANY_A)).rejects.toMatchObject({ name: "DispatchOnlyMergeTrackingError", message: DISPATCH_ONLY_MERGE_TRACKING_REFUSED });
    await expect(app.runtimeFor(COMPANY_A)).rejects.toBeInstanceOf(DispatchOnlyMergeTrackingError);
  });

  it("refuses to build without the core queue's URLs, the State table, the callback signing key, the artifacts bucket or the workers' placement, in fixed words", () => {
    for (const missing of ["CORE_DISPATCH_QUEUE_URL", "CORE_DISPATCH_DEAD_LETTER_URL", "STATE_TABLE_NAME", "ARTIFACT_BUCKET_NAME", "EC2_WORKER_SUBNETS", "EC2_WORKER_LAUNCH_TEMPLATE_ID"]) {
      expect(() => createDispatcherCoreHost(inputs(env({ [missing]: undefined })).inputs)).toThrow(DISPATCHER_CORE_NOT_CONFIGURED);
      expect(() => createDispatcherCoreHost(inputs(env({ [missing]: " " })).inputs)).toThrow(DISPATCHER_CORE_NOT_CONFIGURED);
    }
    // The key is an input, not an environment value: none (or a blank one) refuses, and a plain CALLBACK_SIGNING_KEY in the environment is not taken for it.
    for (const key of ["", " "]) expect(() => createDispatcherCoreHost(inputs(env(), key).inputs)).toThrow(DISPATCHER_CORE_NOT_CONFIGURED);
    expect(() => createDispatcherCoreHost(inputs(env({ CALLBACK_SIGNING_KEY: "k".repeat(48) }), "").inputs)).toThrow(DISPATCHER_CORE_NOT_CONFIGURED);
    // A malformed placement refuses too, before anything runs (and its value is not echoed).
    const bad = (() => { try { createDispatcherCoreHost(inputs(env({ EC2_WORKER_LAUNCH_TEMPLATE_ID: "lt-secret-ish; rm" })).inputs); return undefined; } catch (error) { return error as Error; } })();
    expect(bad?.message).toBe(DISPATCHER_CORE_NOT_CONFIGURED);
    expect(() => createDispatcherCoreHost(inputs(env()).inputs)).not.toThrow();
  });

  it("builds the declared learned input separately for each company's runtime", async () => {
    const made = inputs(env({ [CORE_ENGINE_VARIABLE]: "on", ROVARA_CORE_LESSONS: "on" }));
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const readers = new Map([COMPANY_A, COMPANY_B].map((company) => [company, vi.fn(async () => ({}))]));
    const declared = vi.fn((_registry: unknown, company: string) => hostedDispatcherFlow(made.inputs.env, readers.get(company)));
    const built = createDispatcherCoreHost({ ...made.inputs, flow: declared, extraModules: createFakeWorld().modules.filter((module) => owed.has(module.point)) });
    for (const company of [COMPANY_A, COMPANY_B]) {
      const runtime = await built.app.runtimeFor(company);
      expect(runtime.flow.deps.learned).toBe(readers.get(company));
    }
    expect(declared.mock.calls.map((call) => call[1])).toEqual([COMPANY_A, COMPANY_B]);
  });

  it("DEC 254zm: each company's runtime is told its OWN projects' approved test environments (a step's plan), never another company's", async () => {
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const made = inputs(env({ [CORE_ENGINE_VARIABLE]: "on" }));
    const built = createDispatcherCoreHost({ ...made.inputs, extraModules: createFakeWorld().modules.filter((module) => owed.has(module.point)), flow: { standingInstructions: null, modelAccess: null, learned: null } });
    const a = await built.app.runtimeFor(COMPANY_A);
    const b = await built.app.runtimeFor(COMPANY_B);
    expect(a.flow.deps.testEnvironment).toBeDefined();
    expect(b.flow.deps.testEnvironment).toBeDefined();
    // Company B approved an environment for its project "shared-name"; company A's runtime reads only A's rows for the same project name.
    const body = TestEnvironmentBodySchema.parse({
      tier: "sandbox", repos: [{ repositoryId: "demo", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 }, kind: "test" }] }],
      roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [],
      data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
    });
    const digest = testEnvDigest(body);
    await b.flow.deps.store.put({ item: documentOf({ ...testEnvRevisionKey(COMPANY_B, "shared-name", 1), entityType: "TEST_ENV_REVISION", orgId: COMPANY_B, project: "shared-name", revision: 1, approvedAt: "2026-11-09T09:00:00.000Z", approvedBy: "owner", digest, requestId: "r1", lessSafe: [], environment: body }) });
    await b.flow.deps.store.put({ item: documentOf({ ...testEnvLatestKey(COMPANY_B, "shared-name"), entityType: "TEST_ENV_LATEST", orgId: COMPANY_B, project: "shared-name", revision: 1, digest }) });
    expect(await a.flow.deps.testEnvironment!.forStart({ project: "shared-name", taskId: randomUUID() })).toEqual({});
    expect(await b.flow.deps.testEnvironment!.forStart({ project: "shared-name", taskId: randomUUID() })).not.toEqual({});
  });

  it("lead 4 A1: each company's runtime on the dispatcher carries its own wiki reader, which gives a step nothing for another company's workspace or when no switch is on", async () => {
    const made = inputs(env({ [CORE_ENGINE_VARIABLE]: "on" }));
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const built = createDispatcherCoreHost({ ...made.inputs, flow: () => ({ standingInstructions: null, modelAccess: null, learned: null }), extraModules: createFakeWorld().modules.filter((module) => owed.has(module.point)) });
    const [a, b] = [await built.app.runtimeFor(COMPANY_A), await built.app.runtimeFor(COMPANY_B)];
    expect(typeof a.flow.deps.wiki).toBe("function");
    expect(a.flow.deps.wiki).not.toBe(b.flow.deps.wiki);
    const step = { project: "alpha", taskId: "11111111-1111-4111-8111-111111111111", operationId: "aaaaaaaa-1111-4111-8111-111111111111", workflowMode: "PLAN", repositories: ["web"] };
    expect(await a.flow.deps.wiki!({ ...step, companyId: COMPANY_B })).toEqual({});
    expect(await a.flow.deps.wiki!({ ...step, companyId: COMPANY_A })).toEqual({});
  });

  it("L4-EVW: each company's runtime on the dispatcher carries the gateway's checked https origin for the eval request, only where the model gateway is configured", async () => {
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const extraModules = createFakeWorld().modules.filter((module) => owed.has(module.point));
    const gatewayEnv = { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example.test/", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-5" };
    const built = async (extra: Record<string, string | undefined>) => {
      const made = inputs(env({ [CORE_ENGINE_VARIABLE]: "on", ...extra }));
      const host = createDispatcherCoreHost({ ...made.inputs, extraModules, flow: () => hostedDispatcherFlow(made.inputs.env)! });
      return [(await host.app.runtimeFor(COMPANY_A)).flow.deps.evalGatewayUrl, (await host.app.runtimeFor(COMPANY_B)).flow.deps.evalGatewayUrl] as const;
    };
    expect(await built(gatewayEnv)).toEqual(["https://gateway.example.test", "https://gateway.example.test"]);
    // no gateway: nothing is built, nothing is sent (a laptop and an install without the gateway are exactly as before)
    expect(await built({})).toEqual([undefined, undefined]);
  });

  it("L4-EVW: the eval gateway flow option is the checked origin or nothing", () => {
    const route = { route: async () => undefined };
    expect(evalGatewayOf({ ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example.test" }, route)).toEqual({ evalGatewayUrl: "https://gateway.example.test" });
    expect(evalGatewayOf({ ROVARA_CORE_MODEL_GATEWAY_URL: " https://gateway.example.test/ " }, route)).toEqual({ evalGatewayUrl: "https://gateway.example.test" });
    expect(evalGatewayOf({ ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example.test:8443" }, route)).toEqual({ evalGatewayUrl: "https://gateway.example.test:8443" });
    // no model route configured (null or absent): nothing, even with a good address
    expect(evalGatewayOf({ ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example.test" }, null)).toEqual({});
    expect(evalGatewayOf({ ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example.test" }, undefined)).toEqual({});
    // unset, blank or not exactly an https origin: nothing
    for (const bad of [undefined, "", "  ", "http://gateway.example.test", "https://gateway.example.test/v1", "https://u:p@gateway.example.test", "https://gateway.example.test?a=b", "gateway.example.test", `https://${"a".repeat(600)}.example.test`]) {
      expect(evalGatewayOf(bad === undefined ? {} : { ROVARA_CORE_MODEL_GATEWAY_URL: bad }, route), String(bad)).toEqual({});
    }
  });

  it("builds no company's runtime until every flow input a worker job carries is declared, and places the worker on the install's own workers only", async () => {
    // The points Code's modules leave owed, from the fake world, so the registry builds and the flow declaration is what decides.
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const extraModules = createFakeWorld().modules.filter((module) => owed.has(module.point));
    const withFlow = (flow: unknown) => {
      const made = inputs(env());
      return { ...made, built: createDispatcherCoreHost({ ...made.inputs, extraModules, ...(flow === undefined ? {} : { flow: flow as never }) }) };
    };
    // Not declared, or one input missing: refused in fixed words; nothing built for the company.
    // A key that is there with `undefined` in it is not a declaration either (step 4 recheck Low), nor is a null wiring.
    for (const flow of [undefined, null, { standingInstructions: null, modelAccess: null }, { modelAccess: null, learned: null }, { standingInstructions: null, modelAccess: undefined, learned: null }]) {
      await expect(withFlow(flow).built.app.runtimeFor(COMPANY_A)).rejects.toThrow(DISPATCHER_FLOW_NOT_DECLARED);
    }
    // Declared (here each as an explicit none): the company's flow deps carry exactly what was declared.
    const route = { route: async () => undefined };
    const { built, world } = withFlow({ standingInstructions: null, modelAccess: route, learned: null });
    const runtime = await built.app.runtimeFor(COMPANY_A);
    // DEC 254n (1): the declared route, per company (a company with no engine model of its own gets exactly its answer).
    expect(await runtime.flow.deps.modelAccess!.route()).toEqual(await route.route());
    expect(runtime.flow.deps.standingInstructions).toBeUndefined();
    expect(DISPATCHER_FLOW_DECLARATIONS).toEqual(["standingInstructions", "modelAccess", "learned"]);
    // The dispatcher is a dispatch-only root: no CI mode reader is handed in (it runs no merge tracking), and the honest-CI switch blocker does not refuse it.
    expect(runtime.ciReporting).toBeUndefined();
    // The machines are the fleet bound to the company, and a start places the worker on the install's subnet and launch template.
    const workspaceId = world.workspace(COMPANY_A);
    await runtime.flow.deps.machines.start({ machineKey: workspaceId, companyId: COMPANY_A });
    expect(world.executions).toHaveLength(1);
    expect(world.executions[0]!.input).toMatchObject({ workspaceId, launchTemplateId: "lt-0123456789abcdef0", subnetId: "subnet-0aaaaaaaaaaaaaaaa" });
    // Another company's workspace is not started through this company's runtime.
    await expect(runtime.flow.deps.machines.start({ machineKey: world.workspace(COMPANY_B), companyId: COMPANY_A })).rejects.toMatchObject({ code: "rejected" });
    expect(world.executions).toHaveLength(1);
  });

  it("ANSWER-3: the dispatcher reads broker-validated stored choices only; switch off leaves the declared route unchanged", async () => {
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const extraModules = createFakeWorld().modules.filter((module) => owed.has(module.point));
    const route = { route: async () => ({ alias: "claude-sonnet-5-5", api: "anthropic-messages" as const, catalog: "claude-sonnet-5-5" }) };
    const flow = { standingInstructions: null, modelAccess: route, learned: null };
    const made = inputs(env({ [CORE_ENGINE_VARIABLE]: "on" }));
    // The dispatcher always consults stored state, and absence uses the configured default.
    const plain = await createDispatcherCoreHost({ ...made.inputs, extraModules, flow }).app.runtimeFor(COMPANY_A);
    expect(await plain.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: true, step: { reason: "INSTALL_MODEL", route: { alias: "claude-sonnet-5-5" } } });
    expect(await plain.flow.deps.modelAccess!.route()).toStrictEqual(await route.route());
    // REVIEW-2 F-1: on the default, a checking step is the same model as the work it checks when that work's model is unknown or the same; a non-checking step never is.
    expect(await plain.flow.deps.stepModels!.choose({ stage: "plan_check" })).toMatchObject({ ok: true, step: { sameModelAsChecked: true } });
    expect(await plain.flow.deps.stepModels!.choose({ stage: "code_review", reference: agentModelIdentity("claude-sonnet-5-5") })).toMatchObject({ ok: true, step: { sameModelAsChecked: true } });
    expect(await plain.flow.deps.stepModels!.choose({ stage: "security_review", reference: agentModelIdentity("claude-haiku-5-5") })).toMatchObject({ ok: true, step: { sameModelAsChecked: false } });
    expect(await plain.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: true, step: { sameModelAsChecked: false } });
    // Without a configured route there is no default model to use.
    const reader = createFakeOfferedModels();
    reader.set(COMPANY_A, ["claude-sonnet-5-5", "qwen.qwen3-coder-480b-a35b-v1:0"]);
    reader.set(COMPANY_B, ["claude-haiku-5-5"]);
    const noRoute = await createDispatcherCoreHost({ ...made.inputs, extraModules, flow: { ...flow, modelAccess: null }, env: { ...made.inputs.env, ROVARA_CORE_AGENT_MODEL_CHOICE: "on" } }).app.runtimeFor(COMPANY_A);
    expect(await noRoute.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: false });
    // Fresh rows are company scoped. A's missing row uses the default, even when B has a fresh choice.
    const host = createDispatcherCoreHost({ ...made.inputs, extraModules, flow, env: { ...made.inputs.env, [CORE_ENGINE_VARIABLE]: "on", ROVARA_CORE_AGENT_MODEL_CHOICE: "on" } });
    const a = await host.app.runtimeFor(COMPANY_A);
    const b = await host.app.runtimeFor(COMPANY_B);
    expect(await a.flow.deps.modelAccess!.route()).toStrictEqual(await route.route());
    const registry = await host.app.registry();
    const choice = createAgentModelChoice({ store: registry.require("storage"), companyId: COMPANY_A, audit: registry.require("audit-sink"), approvers: registry.require("approvers"), reader, defaultModel: async () => "claude-sonnet-5-5", now: () => made.inputs.now!().getTime() });
    await choice.service().state();
    const otherChoice = createAgentModelChoice({ store: registry.require("storage"), companyId: COMPANY_B, audit: registry.require("audit-sink"), approvers: registry.require("approvers"), reader, defaultModel: async () => "claude-haiku-5-5", now: () => made.inputs.now!().getTime() });
    await otherChoice.service().state();
    const before = reader.asked.length;
    expect(await a.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: "claude-sonnet-5-5", api: "anthropic-messages" } } });
    expect(await b.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: "claude-haiku-5-5" } } });
    expect(reader.asked).toHaveLength(before);
    expect(reader.asked).toEqual([COMPANY_A, COMPANY_B]);
    made.advance(60_001);
    // B's stale choice is Haiku, distinct from the install's Sonnet default: expiry must change the model.
    expect(await b.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: true, step: { reason: "INSTALL_MODEL", route: { alias: "claude-sonnet-5-5" } } });
    expect(made.log).toHaveBeenCalledWith({ component: "dispatcher", event: "core_engine.model_choice_expired" });
    expect(made.log).toHaveBeenCalledTimes(1);
    const state = registry.require("storage");
    const policyKey = modelSelectionPolicyKey(COMPANY_A);
    const freshRow = await state.get(policyKey);
    const validation = freshRow!["agentModelValidation"] as Record<string, unknown>;
    await state.update({ key: policyKey, ops: [change.set("agentModelValidation", { malformed: true })] });
    expect(await a.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: false });
    await state.update({ key: policyKey, ops: [change.set("agentModelValidation", { ...validation, choice: { ...(validation["choice"] as Record<string, unknown>), defaultModel: "claude-haiku-5-5" } })] });
    expect(await a.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: false });
    // A company's model rule with no validated choice (the broker's model choice off, or never published) is no stored choice: the default model, not a refusal.
    await state.update({ key: policyKey, ops: [change.remove("agentModelValidation")] });
    expect(await a.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: true, step: { reason: "INSTALL_MODEL", route: { alias: "claude-sonnet-5-5" } } });
  });

  it("DEC 254n (1): each step's route is the company's OWN engine model when it set one, else the install's; another company's setting never reaches it; an unreadable setting dispatches nothing", async () => {
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const extraModules = createFakeWorld().modules.filter((module) => owed.has(module.point));
    const route = { route: async () => ({ alias: "claude-sonnet-5-5", api: "anthropic-messages" as const, catalog: "claude-sonnet-5-5" }) };
    const made = inputs(env({ [CORE_ENGINE_VARIABLE]: "on" }));
    const host = createDispatcherCoreHost({ ...made.inputs, extraModules, flow: { standingInstructions: null, modelAccess: route, learned: null } });
    const a = await host.app.runtimeFor(COMPANY_A);
    const b = await host.app.runtimeFor(COMPANY_B);
    const state = (await host.app.registry()).require("storage");
    await state.put({ item: { ...companyEngineModelKey(COMPANY_A), entityType: "COMPANY_ENGINE_MODEL", orgId: COMPANY_A, version: 1, model: "zai.glm-5", updatedAt: "2026-11-17T00:00:00.000Z", updatedBy: "d".repeat(64) } });
    expect(await a.flow.deps.modelAccess!.route()).toStrictEqual({ alias: "zai.glm-5", api: "anthropic-messages", catalog: "zai.glm-5" });
    // The stored-choice default (no validated choice) is the company's own model too.
    expect(await a.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: true, step: { reason: "INSTALL_MODEL", route: { alias: "zai.glm-5" } } });
    // B never sees A's setting.
    expect(await b.flow.deps.modelAccess!.route()).toStrictEqual(await route.route());
    expect(await b.flow.deps.stepModels!.choose({ stage: "build" })).toMatchObject({ ok: true, step: { route: { alias: "claude-sonnet-5-5" } } });
    // A row under A's key that names another company is unreadable: no route on a guess.
    await state.put({ item: { ...companyEngineModelKey(COMPANY_A), entityType: "COMPANY_ENGINE_MODEL", orgId: COMPANY_B, version: 1, model: "zai.glm-5", updatedAt: "2026-11-17T00:00:00.000Z", updatedBy: "d".repeat(64) } });
    await expect(a.flow.deps.modelAccess!.route()).rejects.toThrow(COMPANY_ENGINE_MODEL_UNREADABLE);
  });

  it("builds nothing until a core record arrives, and then refuses by name while the security-list points are owed: the record comes back, no machine is started", async () => {
    const { world, inputs: given } = inputs(env());
    const { app, host } = createDispatcherCoreHost(given);
    expect(app.serving).toBe(true);
    // The dispatcher runs no job and relays no outbox.
    expect(await app.handleScheduledJob({ source: "agentx.core-job", job: "dispatch-sweep" })).toEqual({ skipped: "dispatch_only" });
    expect(await app.relayOutbox([COMPANY_A])).toEqual([]);
    const workspaceId = world.workspace(COMPANY_A);
    const record = { messageId: "m-1", receiptHandle: "rh-1", body: JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId, operationId: randomUUID() }) };
    const result = await host.handle([record], host.take([record]));
    expect(result.failures).toEqual(["m-1"]);
    expect(world.executions).toEqual([]);
    // The registry names what is owed (Code's modules fill storage, queue, objects, secrets, the refusing code host and check runner, and the EC2 fleet).
    const refused = await app.registry().then(() => new Error("the registry was built"), (error: unknown) => error as Error);
    expect(refused).toBeInstanceOf(CoreRegistryError);
    for (const point of ["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]) expect(refused.message).toContain(point);
    for (const point of ["worker-machines (", "storage (", "queue (", "code-host (", "check-runner ("]) expect(refused.message).not.toContain(point);
  });

  it("takes nothing with the switch off and builds no registry", async () => {
    const { inputs: given } = inputs(env({ [CORE_ENGINE_VARIABLE]: "off" }));
    const { app, host } = createDispatcherCoreHost(given);
    expect(app.serving).toBe(false);
    expect(host.take([{ messageId: "m", body: JSON.stringify({ v: 1, companyId: COMPANY_A, workspaceId: randomUUID(), operationId: randomUUID() }) }])).toEqual(new Set());
    await expect(app.registry()).rejects.toThrow("the core engine is off");
  });

  it("refuses in fixed words what the dispatcher does not have: a code host, a person, a repository credential", async () => {
    await expect((refusingCodeHost() as unknown as { getPullRequestStatus(): Promise<unknown> }).getPullRequestStatus()).rejects.toThrow(NO_CODE_HOST_HERE);
    expect((refusingCodeHost() as unknown as { then?: unknown }).then).toBeUndefined();
    const access = refusingTaskAccess();
    expect(await access.checkStart(localOwnerPrincipal({ companyId: COMPANY_A }), "payments")).toEqual({ allowed: false, code: "RUNTIME_UNAVAILABLE", message: NO_PEOPLE_HERE });
    expect(await access.canAct(localOwnerPrincipal({ companyId: COMPANY_A }), { developerId: "d", project: "payments" })).toBe(false);
    expect(await access.checkStep({ taskId: "t", developerId: "d", project: "payments" })).toEqual({ allowed: false, message: NO_PEOPLE_HERE });
    expect(await dispatcherStopInstance("i-0123456789abcdef0")).toEqual({ gone: false });
    // The grant key is the broker's derivation: a grant the dispatcher issues is one the broker verifies.
    expect(repositoryGrantKeyOf("k".repeat(48))).toEqual(repositoryGrantKeyOf("k".repeat(48)));
    expect(repositoryGrantKeyOf("k".repeat(48)).byteLength).toBe(32);
  });
});

describe("the flow inputs the deployment declares on the dispatcher (lane E2 step 6)", () => {
  it("declares explicit none while off, and refuses an undeclared lessons reader while on", () => {
    expect(hostedDispatcherFlow({})).toEqual({ standingInstructions: null, modelAccess: null, learned: null });
    expect(hostedDispatcherFlow({ ROVARA_CORE_LESSONS: "off" })).toEqual({ standingInstructions: null, modelAccess: null, learned: null });
    for (const value of ["on", `on:${COMPANY_A}`]) expect(hostedDispatcherFlow({ ROVARA_CORE_LESSONS: value }), value).toBeUndefined();
  });
});

it.each(["missing", "foreign"])("dispatcher refuses and logs a %s scoped workspace behind a pointer", async (kind) => {
  const w = await createWorld();
  const task = await w.start(COMPANY_A);
  const batch = await w.staged();
  const key = workspaceKey(COMPANY_A, task.workspaceId);
  if (kind === "missing") await w.store.delete({ key });
  else await w.store.put({ item: { ...(await w.store.get(key))!, companyId: COMPANY_B } });
  const integrity = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect(failures(await w.handler({ Records: batch }))).toEqual(batch.map((row) => row.messageId));
    expect(w.depsFor).not.toHaveBeenCalled();
    expect(integrity.mock.calls).toEqual([[{ component: "broker", event: "workspace.pointer_integrity" }]]);
  } finally { integrity.mockRestore(); }
});
