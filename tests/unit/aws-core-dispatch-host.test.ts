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
import { change, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition, type QueueService } from "@agentx/contracts";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { createAllowAllAdmission, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
import { createStoreProjectSource } from "../../packages/broker/src/core/task-flow/project-source.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { companyDayKey, costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { TASK_SPEND_UNKNOWN } from "../../packages/broker/src/core-host/company-task-spend.js";
import { hostedTaskCapUsd } from "../../packages/broker/src/core-host/hosted-modules.js";
import { readFileSync } from "node:fs";
import { workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { createTaskFlow, TASK_FLOW_INDEXES, type TaskFlow } from "../../packages/broker/src/core/task-flow/flow.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { LambdaBatchQueue, coreDispatchMessage, createCoreDispatchHost, type CoreDispatchHostDependencies } from "../../packages/broker/src/aws/worker-machines/core-dispatch-host.js";
import {
  dispatcherFlowDeps, DISPATCHER_CORE_NOT_CONFIGURED, DISPATCHER_FLOW_DECLARATIONS, DISPATCHER_FLOW_NOT_DECLARED, NO_CODE_HOST_HERE, NO_PEOPLE_HERE, createDispatcherCoreHost, dispatcherStopInstance, evalGatewayOf, hostedDispatcherFlow, refusingCodeHost, refusingTaskAccess, repositoryGrantKeyOf, withCoreDispatch,
} from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import { COMPANY_A, COMPANY_B, createSessionMachinesWorld } from "../support/session-machines-world.js";
import { CoreRegistryError } from "../../packages/broker/src/core-host/registry.js";
import { createCoreHostApp, DispatchOnlyMergeTrackingError, DISPATCH_ONLY_MERGE_TRACKING_REFUSED } from "../../packages/broker/src/core-host/app.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { createFakeOfferedModels } from "../support/offered-models-fake.js";
import { FakeDynamoDb } from "../support/ports/dynamodb-fake.js";
import { FakeSqs } from "../support/ports/sqs-fake.js";
import { SqsIamFence } from "../support/ports/sqs-iam-fence.js";
import { createSqsQueueServiceFromSettings } from "../../packages/aws-adapters/src/index.js";
import { ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";
import { CORE_DISPATCHER_QUEUE_ACTIONS } from "../../infra/lib/core-engine.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { FakeS3 } from "../support/ports/aws-fakes.js";

const CORE_QUEUE_ARN = "arn:aws:sqs:us-west-2:111122223333:agentx-staging-core-dispatch";
const TODAY_QUEUE_ARN = "arn:aws:sqs:us-west-2:111122223333:agentx-staging-dispatch";
const definition: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};

interface SqsRecord { messageId: string; receiptHandle: string; body: string; eventSource: string; eventSourceARN: string; attributes: { ApproximateReceiveCount: string } }

/** The core's task flow for two companies on one store and one queue, and the EC2 machines of each through one fleet. */
async function createWorld(options: { enabled?: boolean; /** L4-SQS: the deps of one batch as the dispatcher builds them (default: the flow's own). */ wrapDeps?: (deps: TaskFlowDeps) => TaskFlowDeps; /** L4-SQS: what the host's SQS ChangeMessageVisibility does (default: nothing). */ changeVisibilityTo?: CoreDispatchHostDependencies["changeVisibility"] } = {}) {
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
  const changeVisibility = vi.fn<CoreDispatchHostDependencies["changeVisibility"]>(options.changeVisibilityTo ?? (async () => undefined));
  const depsFor = vi.fn((companyId: OrgId, dispatchQueues: Parameters<CoreDispatchHostDependencies["depsFor"]>[1]) => (options.wrapDeps ?? ((deps: TaskFlowDeps) => deps))(depsOf(companyId, dispatchQueues)));
  const host = createCoreDispatchHost({ companyOfWorkspace, depsFor, changeVisibility, log: () => undefined });
  const deliverEc2 = vi.fn(async () => "DELIVERED" as const);
  const markDispatching = vi.fn(async () => true);
  const today = vi.fn(createDispatcherHandler({ deliverEc2, markDispatching, markDelivered: async () => undefined, markFailed: async () => undefined, maxAttempts: 50, log: () => undefined }));
  const serves = vi.fn(() => options.enabled ?? true);
  const handler = withCoreDispatch(today, { coreQueueArn: CORE_QUEUE_ARN, host: async () => host, log: () => undefined });
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
    for (const coreQueueArn of [undefined, "", "   "]) expect(withCoreDispatch(today, { coreQueueArn, host })).toBe(today);
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

});

describe("the core on the dispatcher", () => {
  const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
    CORE_DISPATCH_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/111122223333/agentx-staging-core-dispatch",
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


it("installs the production retained-close provider in each dispatcher company runtime", async () => {
  const made = inputs(env({}));
  const owed = new Set(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
  const built = createDispatcherCoreHost({ ...made.inputs, flow: { standingInstructions: null, modelAccess: null, learned: null }, extraModules: createFakeWorld().modules.filter(module => owed.has(module.point)) });
  const a = await built.app.runtimeFor(COMPANY_A), b = await built.app.runtimeFor(COMPANY_B);
  expect(a.flow.deps.closeInspection).toBeDefined();
  expect(a.flow.deps.closeInspection).not.toBe(b.flow.deps.closeInspection);
});

  // M3: an omitted hosted guard must retry, before allocating worker authority.
  it("never delivers when the hosted delivery authority is unwired", async () => {
    const made = inputs(env());
    const owed = new Set(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const built = createDispatcherCoreHost({ ...made.inputs, flow: { standingInstructions: null, modelAccess: null, learned: null }, extraModules: createFakeWorld().modules.filter((module) => owed.has(module.point)) });
    const runtime = await built.app.runtimeFor(COMPANY_A);
    const h = createHarness({ companyId: COMPANY_A, machines: { startingChecks: 0 }, extra: () => ({ deliveryAccess: runtime.flow.deps.deliveryAccess! }) });
    await h.registerProject();
    const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
    expect(await h.flow.dispatchOnce()).toMatchObject({ received: 1, delivered: 0, retried: 1 });
    expect(h.grants).toEqual([]);
    expect(await h.store.get(workspaceKey(COMPANY_A, task.workspaceId))).not.toHaveProperty("machine");
  });

  it("refuses merge tracking on a dispatch-only runtime with a fixed typed error", async () => {
    const world = createFakeWorld();
    const app = createCoreHostApp({
      modules: world.modules, context: () => world.context(), dispatchOnly: true, servedCompanies: async () => [],
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
    const made = inputs(env({ ROVARA_CORE_LESSONS: "on" }));
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
    const made = inputs(env({}));
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

  it("L4-TSU: each company's runtime on the dispatcher carries its own taskSpendUsd over its own cost ledger: another company's row for the same task id is never counted, and what is not known throws in fixed words", async () => {
    const made = inputs(env({}));
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const logs: Array<Record<string, unknown>> = [];
    const built = createDispatcherCoreHost({ ...made.inputs, log: (entry) => { logs.push(entry); }, flow: () => ({ standingInstructions: null, modelAccess: null, learned: null }), extraModules: createFakeWorld().modules.filter((module) => owed.has(module.point)) });
    const [a, b] = [await built.app.runtimeFor(COMPANY_A), await built.app.runtimeFor(COMPANY_B)];
    expect(typeof a.flow.deps.taskSpendUsd).toBe("function");
    expect(a.flow.deps.taskSpendUsd).not.toBe(b.flow.deps.taskSpendUsd);
    const task = "44444444-4444-4444-8444-444444444444", taskB = "77777777-7777-4777-8777-777777777777";
    const total = async (companyId: typeof COMPANY_A, taskId: string, micros: number, over: Record<string, unknown> = {}) => {
      await a.flow.deps.store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId, workspaceId: `ws-${taskId}` } });
      await a.flow.deps.store.put({ item: { ...workspaceKey(companyId, `ws-${taskId}`), entityType: "WORKSPACE", id: `ws-${taskId}`, companyId, orgId: companyId } });
      await a.flow.deps.store.put({ item: { pk: costPartition(companyId, taskId), sk: "TOTAL", entityType: "COST_TOTAL", companyId, taskId, currency: "USD", micros, entries: 1, unpricedEntries: 0, ...over } });
    };
    await total(COMPANY_A, task, 6_000_000); await total(COMPANY_B, taskB, 91_000_000);
    expect(await a.flow.deps.taskSpendUsd!(task)).toBe(6);
    expect(await b.flow.deps.taskSpendUsd!(taskB)).toBe(91);
    await total(COMPANY_A, task, 7_000_000);
    expect(await a.flow.deps.taskSpendUsd!(task)).toBe(7);
    // the other company's task is no row of A's
    await expect(a.flow.deps.taskSpendUsd!(taskB)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    await total(COMPANY_A, task, 7_000_000, { unpricedEntries: 1 });
    await expect(a.flow.deps.taskSpendUsd!(task)).rejects.toThrow(TASK_SPEND_UNKNOWN);
    const refusals = logs.filter((entry) => entry["event"] === "dispatch.task_spend_refused");
    expect(refusals.map((entry) => entry["reason"])).toEqual(["run_unreported", "unpriced_usage"]);
    expect(JSON.stringify(refusals)).not.toContain(task);
  });

  it("wires the real dollar day gate on the dispatcher without an opt-in", async () => {
    const made = inputs(env({ ROVARA_CORE_COMPANY_DAY_CAP_USD: "25" }));
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const built = createDispatcherCoreHost({ ...made.inputs, flow: () => ({ standingInstructions: null, modelAccess: null, learned: null }), extraModules: createFakeWorld().modules.filter((module) => owed.has(module.point)) });
    const a = await built.app.runtimeFor(COMPANY_A);
    expect(typeof a.flow.deps.autofixDayBudgetHasRoom).toBe("function");
    const taskId = "44444444-4444-4444-8444-444444444444";
    await a.flow.deps.store.put({ item: { ...taskKey(taskId), companyId: COMPANY_A, taskId, project: "demo" } });
    expect(await a.flow.deps.autofixDayBudgetHasRoom!({ companyId: COMPANY_A, taskId, project: "demo" } as never, 26)).toBe(false);
    expect(await a.flow.deps.autofixDayBudgetHasRoom!({ companyId: COMPANY_A, taskId, project: "demo" } as never, 3)).toBe(true);
    // Review test (lead 4 Opus, e48d7b1b1): the dispatcher's reader counts TODAY's load on the host's own clock (a reader on another day would see an empty day and say "room").
    const today = made.inputs.now!().toISOString().slice(0, 10);
    await a.flow.deps.store.put({ item: { ...companyDayKey(COMPANY_A, today), loadMicros: 23_000_000, uncountedEntries: 0 } });
    expect(await a.flow.deps.autofixDayBudgetHasRoom!({ companyId: COMPANY_A, taskId, project: "demo" } as never, 3)).toBe(false);
    expect(await a.flow.deps.autofixDayBudgetHasRoom!({ companyId: COMPANY_A, taskId, project: "demo" } as never, 2)).toBe(true);
  });

  it("L4-TA6: each company's runtime on the dispatcher carries its own taskCapUsd (the live cap automatic fixing is held to) from the host's input, and nothing when the host gives none; the deployed dispatcher gives it", async () => {
    const made = inputs(env({}));
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const wiring = { flow: () => ({ standingInstructions: null, modelAccess: null, learned: null }), extraModules: createFakeWorld().modules.filter((module) => owed.has(module.point)) };
    const settings = { allowedCompanies: "all" as const, taskCapMicros: 1_000_000, companyDayCapMicros: 25_000_000 };
    const built = createDispatcherCoreHost({ ...made.inputs, ...wiring, taskCapUsd: (registry, companyId) => hostedTaskCapUsd({ store: registry.require("storage"), companyId, settings }) });
    const [a, b] = [await built.app.runtimeFor(COMPANY_A), await built.app.runtimeFor(COMPANY_B)];
    expect(typeof a.flow.deps.taskCapUsd).toBe("function");
    expect(a.flow.deps.taskCapUsd).not.toBe(b.flow.deps.taskCapUsd);
    const task = (companyId: typeof COMPANY_A, taskId: string) => ({ companyId, taskId, project: "demo" });
    const taskA = "44444444-4444-4444-8444-444444444444", taskB = "77777777-7777-4777-8777-777777777777";
    await a.flow.deps.store.put({ item: { ...taskKey(taskA), entityType: "DEVELOPER_TASK", taskId: taskA, companyId: COMPANY_A, workspaceId: "ws-a", project: "demo" } });
    await b.flow.deps.store.put({ item: { ...taskKey(taskB), entityType: "DEVELOPER_TASK", taskId: taskB, companyId: COMPANY_B, workspaceId: "ws-b", project: "demo" } });
    // the install's $1 cap, never the $15 automatic-fixing default
    expect(await a.flow.deps.taskCapUsd!(task(COMPANY_A, taskA) as never)).toBe(1);
    expect(await b.flow.deps.taskCapUsd!(task(COMPANY_B, taskB) as never)).toBe(1);
    // a company's reader never answers for another company's task
    await expect(a.flow.deps.taskCapUsd!(task(COMPANY_B, taskB) as never)).rejects.toThrow();
    await expect(b.flow.deps.taskCapUsd!(task(COMPANY_A, taskA) as never)).rejects.toThrow();
    // a host that gives none leaves the flow without one (the dispatcher below always gives it)
    expect((await createDispatcherCoreHost({ ...made.inputs, ...wiring }).app.runtimeFor(COMPANY_A)).flow.deps.taskCapUsd).toBeUndefined();
    const dispatcher = readFileSync(new URL("../../packages/broker/src/aws/dispatcher.ts", import.meta.url), "utf8");
    expect(dispatcher).toMatch(/taskCapUsd: \(registry, companyId\) => \{[^}]*hostedTaskCapUsd\(\{ store: registry\.require\("storage"\), companyId, settings: "settings" in read \? read\.settings : undefined, projectTaskCap: dispatcherProjectTaskCapOf\(\) \}\)/u);
  });

  it("lead 4 A1: each company's runtime on the dispatcher carries its own wiki reader, which gives a step nothing for another company's workspace or when no switch is on", async () => {
    const made = inputs(env({}));
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const built = createDispatcherCoreHost({ ...made.inputs, flow: () => ({ standingInstructions: null, modelAccess: null, learned: null }), extraModules: createFakeWorld().modules.filter((module) => owed.has(module.point)) });
    const [a, b] = [await built.app.runtimeFor(COMPANY_A), await built.app.runtimeFor(COMPANY_B)];
    expect(typeof a.flow.deps.wiki).toBe("function");
    expect(a.flow.deps.wiki).not.toBe(b.flow.deps.wiki);
    const step = { project: "alpha", taskId: "11111111-1111-4111-8111-111111111111", operationId: "aaaaaaaa-1111-4111-8111-111111111111", workflowMode: "PLAN", repositories: ["web"] };
    expect(await a.flow.deps.wiki!({ ...step, companyId: COMPANY_B })).toEqual({});
    expect(await a.flow.deps.wiki!({ ...step, companyId: COMPANY_A })).toEqual({});
  });

  it("L4-ART: each company's runtime on the dispatcher carries a company-bound artifacts reader: its own workspaces' documents read, another company's and a key outside the flow's shapes read as not there", async () => {
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const made = inputs(env({}));
    const logs: Array<Record<string, unknown>> = [];
    const built = createDispatcherCoreHost({ ...made.inputs, log: (entry) => { logs.push(entry); }, extraModules: createFakeWorld().modules.filter((module) => owed.has(module.point)), flow: { standingInstructions: null, modelAccess: null, learned: null } });
    const [a, b] = [await built.app.runtimeFor(COMPANY_A), await built.app.runtimeFor(COMPANY_B)];
    expect(typeof a.flow.deps.artifacts?.get).toBe("function");
    expect(a.flow.deps.artifacts).not.toBe(b.flow.deps.artifacts);
    const blobs = (await built.app.registry()).require("object-storage");
    const put = (key: string, body: string) => blobs.put(key, new TextEncoder().encode(body), { contentType: "text/plain", metadata: {}, retention: "plan" });
    const workspace = (companyId: typeof COMPANY_A, id: string, ownerKey: string) => a.flow.deps.store.put({ item: { ...workspaceKey(companyId, id), entityType: "WORKSPACE", id, companyId, orgId: companyId, ownerKey, projectName: "payments" } });
    await workspace(COMPANY_A, "ws-a-art", "owner-a-art"); await workspace(COMPANY_B, "ws-b-art", "owner-b-art");
    await put("workspaces/ws-a-art/operations/op-1/plan.md", "a's plan"); await put("workspaces/ws-b-art/operations/op-1/plan.md", "b's plan");
    // the engine's own ARTIFACT record of each (services/callbacks.ts), which the reader requires for a callback-shaped key
    for (const [companyId, id] of [[COMPANY_A, "ws-a-art"], [COMPANY_B, "ws-b-art"]] as const) await a.flow.deps.store.put({ item: { ...workspaceKey(companyId, id), sk: "ARTIFACT#op-1#plan.md", entityType: "ARTIFACT", objectKey: `workspaces/${id}/operations/op-1/plan.md` } });
    const read = async (runtime: typeof a, key: string) => { const bytes = await runtime.flow.deps.artifacts!.get(key, 1000); return bytes === undefined ? undefined : new TextDecoder().decode(bytes); };
    expect(await read(a, "workspaces/ws-a-art/operations/op-1/plan.md")).toBe("a's plan");
    expect(await read(b, "workspaces/ws-b-art/operations/op-1/plan.md")).toBe("b's plan");
    expect(await read(a, "workspaces/ws-b-art/operations/op-1/plan.md")).toBeUndefined();
    expect(await read(b, "workspaces/ws-a-art/operations/op-1/plan.md")).toBeUndefined();
    expect(await read(a, "workflow-e2e-admissions/sha256/abc.json")).toBeUndefined();
    // Refusals are logged in fixed words only
    const refusals = logs.filter((entry) => entry["event"] === "dispatch.artifact_read_refused");
    expect(refusals.map((entry) => entry["reason"])).toEqual(["workspace_not_company", "workspace_not_company", "key_not_task_document"]);
    expect(JSON.stringify(refusals)).not.toContain("ws-b-art");
  });

  it("L4-EVW: each company's runtime on the dispatcher carries the gateway's checked https origin for the eval request, only where the model gateway is configured", async () => {
    const owed = new Set<string>(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
    const extraModules = createFakeWorld().modules.filter((module) => owed.has(module.point));
    const gatewayEnv = { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example.test/", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-4-5" };
    const built = async (extra: Record<string, string | undefined>) => {
      const made = inputs(env({ ...extra }));
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
    const made = inputs(env({}));
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
    const host = createDispatcherCoreHost({ ...made.inputs, extraModules, flow, env: { ...made.inputs.env, ROVARA_CORE_AGENT_MODEL_CHOICE: "on" } });
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

  it("builds nothing until a core record arrives, and then refuses by name while the security-list points are owed: the record comes back, no machine is started", async () => {
    const { world, inputs: given } = inputs(env());
    const { app, host } = createDispatcherCoreHost(given);
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

// L4-SQS (journey audit B18): a whole core dispatch passes under the dispatcher's REAL SQS grants (the infrastructure's own constants: receive, delete, change visibility and attributes on the core dispatch
// queue; never a send, never the dead letters). The dispatch consumer is served by the Lambda batch, so the only SQS call is the visibility change of a record that comes back; the flow's outbox is the
// dispatcher's (it never relays), so the registry's SQS service, which the role could not open, is never asked.
describe("a core dispatch under the dispatcher's own SQS grants (B18)", () => {
  const BASE = "https://sqs.us-west-2.amazonaws.com/111122223333";
  const CORE_URL = `${BASE}/agentx-staging-core-dispatch`;
  const DEAD_URL = `${BASE}/agentx-staging-core-dispatch-dead`;
  const grants = { "agentx-staging-core-dispatch": CORE_DISPATCHER_QUEUE_ACTIONS };

  it("hands each operation to its company's machine, with no denied SQS call, and the flow's outbox on the dispatcher never relays", async () => {
    const fake = new FakeSqs();
    fake.createQueue(DEAD_URL);
    fake.createQueue(CORE_URL, { visibilityTimeout: 120, maxReceiveCount: 21, deadLetterUrl: DEAD_URL });
    const registryFence = new SqsIamFence(grants, fake);
    const visibilityFence = new SqsIamFence(grants);
    const registryQueues = createSqsQueueServiceFromSettings({ region: "us-west-2", queues: { "task-dispatch": { url: CORE_URL, deadLetterUrl: DEAD_URL } } }, registryFence.sender);
    const w = await createWorld({
      wrapDeps: (deps) => dispatcherFlowDeps({ ...deps, outbox: createTransactionalOutbox({ store: deps.store, queues: registryQueues }) }, deps.queues),
      changeVisibilityTo: async (receiptHandle, seconds) => { await visibilityFence.sender.send(new ChangeMessageVisibilityCommand({ QueueUrl: CORE_URL, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds })); },
    });
    await w.start(COMPANY_A);
    await w.start(COMPANY_B);
    let batch = await w.staged();
    expect(failures(await w.handler({ Records: batch }))).toEqual(batch.map((record) => record.messageId));
    await w.machinesWorld.settle();
    batch = batch.map(w.again);
    expect(failures(await w.handler({ Records: batch }))).toEqual([]);
    expect(w.machinesWorld.posts.filter((post) => post.status === 200)).toHaveLength(2);
    // Each company's deps carry the dispatcher's outbox: a relay does nothing, and the SQS service of the registry (which the role cannot open) was never asked.
    for (const result of w.depsFor.mock.results) expect(await (result.value as TaskFlowDeps).outbox.relay({ companyId: COMPANY_A })).toEqual({ delivered: 0, failed: 0, dead: 0 });
    expect(registryFence.allowed).toEqual([]);
    expect(registryFence.denied).toEqual([]);
    // The one SQS call a dispatch makes: ChangeMessageVisibility of a record that comes back (two records, one retry each), on the core queue, granted.
    expect(visibilityFence.denied).toEqual([]);
    expect(visibilityFence.allowed).toEqual([{ action: "sqs:ChangeMessageVisibility", queue: "agentx-staging-core-dispatch" }, { action: "sqs:ChangeMessageVisibility", queue: "agentx-staging-core-dispatch" }]);
  });
});
