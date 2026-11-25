// WORKER-DELIVERY-IDENTITY (b-plus), plan item 6: a stale READY row whose address now answers as ANOTHER workspace's worker must get nothing. The dispatcher's delivery (ec2-delivery.ts) is run over the
// real session manager and the real machine check, with EC2 played by the session world's instances; every request that would reach a worker is recorded, and none may carry the capability, the
// grant or the token.
import { describe, expect, it, vi } from "vitest";
import type { Ec2RuntimeBinding } from "../../packages/contracts/src/index.js";
import { createEc2Delivery, type Ec2DeliveryDependencies } from "../../packages/broker/src/aws/ec2-delivery.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { createMachineVerifier, type InstanceFact, type MachineReader, MACHINE_CHECK_UNAVAILABLE_WORDS } from "../../packages/broker/src/aws/machine-check.js";
import { failOutboxOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { COMPUTE_LOST_WORDS } from "../../packages/broker/src/aws/session-lost.js";
import { failProjectSetupOperation } from "../../packages/broker/src/aws/machine-check-aws.js";
import { ProjectSetupSessionManager, markProjectSetupSessionLost } from "../../packages/broker/src/aws/sessions.js";
import { projectSetupBindingDigest } from "../../packages/broker/src/aws/project-setup-runtime-catalog.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { projectSetupExecutionKey, projectSetupOperationKey, projectSetupSessionKey } from "@agentx/contracts";
import { BINDING, COMPANY_A, COMPANY_B, TABLE, createSessionMachinesWorld } from "../support/session-machines-world.js";

const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const CAPABILITY = "capability-that-can-act-".padEnd(64, "x");

function setup() {
  const world = createSessionMachinesWorld({ startedAt: NOW });
  const workspaceA = world.workspace(COMPANY_A);
  const workspaceB = world.workspace(COMPANY_B);
  const operationId = crypto.randomUUID();
  const record: Ec2OutboxRecord = {
    id: crypto.randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId: workspaceA, deploymentMode: "ec2-ebs",
    invocation: { protocolVersion: 1, kind: "resume", operationId, workspaceId: workspaceA, fence: 2, projectRevision: 1, callbackCapability: CAPABILITY, payload: {} },
  };
  world.db.set({ ...world.db.get(`WORKSPACE#${workspaceA}`, "META")!, status: "BUSY", activeOperationId: operationId, fence: 2 });
  world.db.set({ pk: `WORKSPACE#${workspaceA}`, sk: `OPERATION#${operationId}`, kind: "resume", status: "DISPATCHING", fence: 2, eventSequence: 0 });
  world.db.set({ pk: `OUTBOX#${record.id}`, sk: "OUTBOX", ...record });

  // EC2, as the session world's instances: terminated once `running` is false, tagged with their workspace, at their address.
  const factOf = (instance: { instanceId: string; running: boolean; privateIp: string; workspaceId: string }): InstanceFact =>
    ({ instanceId: instance.instanceId, state: instance.running ? "running" : "terminated", privateIp: instance.privateIp, workspaceId: instance.workspaceId, subnetId: BINDING.subnets[0]!.subnetId });
  const ec2 = {
    describeFails: false,
    asked: [] as string[],
    forgotten: new Set<string>(),
    /** Replaces what EC2 says about an instance (an address or tag that differs from the row's). */
    said: new Map<string, Partial<InstanceFact>>(),
  };
  const reader: MachineReader = {
    async byInstanceId(instanceId) {
      ec2.asked.push(instanceId);
      if (ec2.describeFails) throw Object.assign(new Error("RequestLimitExceeded: account 111122223333"), { name: "RequestLimitExceeded" });
      const instance = world.instances.get(instanceId);
      if (instance === undefined || ec2.forgotten.has(instanceId)) return undefined;
      return { ...factOf(instance), ...ec2.said.get(instanceId) };
    },
    async byPrivateIp(privateIp) {
      return [...world.instances.values()].filter((instance) => instance.running && instance.privateIp === privateIp).map(factOf);
    },
  };
  const lines: Array<Record<string, unknown>> = [];
  const verifyMachine = createMachineVerifier({ reader, markLost: (seen) => world.sessions.markLost(seen), log: (entry) => { lines.push(entry); } });
  // The network: every request that reaches an address is recorded as raw bytes. A machine of another workspace there answers 401, as the honest worker does.
  const network: Array<{ url: string; authorization: string; body: string }> = [];
  const post = vi.fn<Ec2DeliveryDependencies["post"]>(async (url, init) => {
    network.push({ url, ...init });
    return { status: 401, body: JSON.stringify({ error: "wrong_workspace" }) };
  });
  const failOperation = vi.fn((failed: Ec2OutboxRecord, error: string) => failOutboxOperation(world.db, TABLE, failed, error));
  const deliver = createEc2Delivery({
    sessions: world.sessions,
    binding: async () => BINDING,
    sign: (message) => world.sign(message),
    post, verifyMachine, failOperation,
    progress: async () => undefined,
    applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined,
    now: () => NOW,
  });
  return { world, workspaceA, workspaceB, record, ec2, lines, network, post, failOperation, deliver };
}

type Fixture = ReturnType<typeof setup>;

/** The workspace's machine starts and the record is delivered once, so the row is READY with an instance and an address. */
async function ready(fixture: Fixture) {
  const { world, workspaceA, record, deliver } = fixture;
  expect(await deliver(record, record.invocation)).toBe("WAITING_FOR_SESSION");
  await world.settle();
  const session = (await world.sessions.get(workspaceA))!;
  expect(session).toMatchObject({ state: "READY", generation: 1 });
  return session;
}

function expectNothingSensitiveSent(network: Fixture["network"]) {
  expect(network).toEqual([]);
  const raw = JSON.stringify(network);
  expect(raw).not.toContain(CAPABILITY);
  expect(raw).not.toContain("Bearer");
}

describe("a stale READY row whose address now answers as another workspace's worker", () => {
  it("sends nothing, marks the row lost, ends the operation with the fixed words, and logs both workspace ids", async () => {
    const fixture = setup();
    const { world, workspaceA, workspaceB, record, network, post, lines, deliver } = fixture;
    const stale = await ready(fixture);
    // The row's instance dies without the row hearing of it, and another workspace's new machine takes its address.
    world.instances.get(stale.instanceId!)!.running = false;
    world.instances.set("i-0bbbbbbbbbbbbbbb2", { instanceId: "i-0bbbbbbbbbbbbbbb2", privateIp: stale.privateIp!, workspaceId: workspaceB, generation: 1, running: true, accepted: new Set(), active: new Set() });
    expect(await world.sessions.get(workspaceA)).toMatchObject({ state: "READY", privateIp: stale.privateIp });

    expect(await deliver(record, record.invocation)).toBe("MACHINE_GONE");

    // Nothing left: no POST, so no capability, no token, no body, and no request at all to that address.
    expect(post).not.toHaveBeenCalled();
    expectNothingSensitiveSent(network);
    // The row is lost (the reconciler's own transition): STOPPED, no instance, no address; the volume is kept.
    const row = (await world.sessions.get(workspaceA))!;
    expect(row).toMatchObject({ state: "STOPPED", generation: 1, volumeId: stale.volumeId });
    expect(row).not.toHaveProperty("instanceId");
    expect(row).not.toHaveProperty("privateIp");
    // The operation ends with the reconciler's fixed words, the workspace is released, the outbox record is failed.
    expect(world.db.get(`WORKSPACE#${workspaceA}`, `OPERATION#${record.operationId}`)).toMatchObject({ status: "FAILED", error: COMPUTE_LOST_WORDS });
    expect(world.db.get(`WORKSPACE#${workspaceA}`, "META")).toMatchObject({ status: "READY" });
    expect(world.db.get(`WORKSPACE#${workspaceA}`, "META")).not.toHaveProperty("activeOperationId");
    expect(world.db.get(`OUTBOX#${record.id}`, "OUTBOX")).toMatchObject({ status: "FAILED", error: COMPUTE_LOST_WORDS });
    // The event names the workspace the row expected and the one that answers there now.
    expect(lines).toEqual([expect.objectContaining({
      level: "warn", event: "dispatch.machine_gone", reason: "not_running", markedLost: true,
      expectedWorkspaceId: workspaceA, heldByWorkspaceId: workspaceB, expectedInstanceId: stale.instanceId, heldByInstanceId: "i-0bbbbbbbbbbbbbbb2", privateIp: stale.privateIp,
    })]);
  });

  it("makes no retry to that address: a second delivery of the same record starts a new machine and posts nothing", async () => {
    const fixture = setup();
    const { world, workspaceA, workspaceB, record, network, deliver } = fixture;
    const stale = await ready(fixture);
    world.instances.get(stale.instanceId!)!.running = false;
    world.instances.set("i-0bbbbbbbbbbbbbbb2", { instanceId: "i-0bbbbbbbbbbbbbbb2", privateIp: stale.privateIp!, workspaceId: workspaceB, generation: 1, running: true, accepted: new Set(), active: new Set() });
    expect(await deliver(record, record.invocation)).toBe("MACHINE_GONE");
    expect(await deliver(record, record.invocation)).toBe("WAITING_FOR_SESSION");
    expect(await world.sessions.get(workspaceA)).toMatchObject({ state: "PROVISIONING", generation: 2 });
    expectNothingSensitiveSent(network);
  });
});

describe("the check before every POST", () => {
  it("lets the row's own machine through: one POST, DELIVERED", async () => {
    const fixture = setup();
    const { record, post, network, deliver, ec2, failOperation, lines } = fixture;
    const session = await ready(fixture);
    post.mockImplementation(async (url, init) => { network.push({ url, ...init }); return { status: 200, body: "{}" }; });
    expect(await deliver(record, record.invocation)).toBe("DELIVERED");
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]![0]).toBe(`http://${session.privateIp}:8080/invocations`);
    expect(ec2.asked).toEqual([session.instanceId]);
    expect(failOperation).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it.each<[string, (instanceId: string, ip: string, ec2: Fixture["ec2"], other: string) => void, string]>([
    ["EC2 says terminated", (id, _ip, ec2) => { ec2.said.set(id, { state: "terminated" }); }, "not_running"],
    ["EC2 says shutting down", (id, _ip, ec2) => { ec2.said.set(id, { state: "shutting-down" }); }, "not_running"],
    ["EC2 no longer knows the instance", (id, _ip, ec2) => { ec2.forgotten.add(id); }, "not_found"],
    ["the instance holds a different IP", (id, _ip, ec2) => { ec2.said.set(id, { privateIp: "10.42.0.200" }); }, "address_changed"],
    ["the instance carries a different workspace tag", (id, _ip, ec2, other) => { ec2.said.set(id, { workspaceId: other }); }, "workspace_tag"],
    ["the instance carries no workspace tag", (id, _ip, ec2) => { ec2.said.set(id, { workspaceId: undefined }); }, "workspace_tag"],
    // Private addresses repeat across VPCs, and EC2 answers for an instance of any VPC of the account: the right id at the right address in another VPC is not the machine the POST would reach.
    ["the instance is at the same address in ANOTHER VPC (a subnet the session is not in)", (id, _ip, ec2) => { ec2.said.set(id, { subnetId: "subnet-0bbbbbbbbbbbbbbbb" }); }, "subnet_mismatch"],
  ])("sends no POST when %s", async (_name, change, reason) => {
    const fixture = setup();
    const { world, workspaceA, workspaceB, record, network, post, lines, deliver, ec2 } = fixture;
    const session = await ready(fixture);
    change(session.instanceId!, session.privateIp!, ec2, workspaceB);
    expect(await deliver(record, record.invocation)).toBe("MACHINE_GONE");
    expect(post).not.toHaveBeenCalled();
    expectNothingSensitiveSent(network);
    expect(await world.sessions.get(workspaceA)).toMatchObject({ state: "STOPPED" });
    expect(world.db.get(`WORKSPACE#${workspaceA}`, `OPERATION#${record.operationId}`)).toMatchObject({ status: "FAILED", error: COMPUTE_LOST_WORDS });
    expect(lines).toEqual([expect.objectContaining({ event: "dispatch.machine_gone", reason, expectedWorkspaceId: workspaceA })]);
  });

  it("is a retryable refusal, not 'gone', when EC2 cannot be asked: nothing sent, the row untouched, the operation still running", async () => {
    const fixture = setup();
    const { world, workspaceA, record, network, post, deliver, ec2, failOperation, lines } = fixture;
    const session = await ready(fixture);
    ec2.describeFails = true;
    const refusal = await deliver(record, record.invocation).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((refusal as Error).message).toContain(MACHINE_CHECK_UNAVAILABLE_WORDS);
    expect(String((refusal as Error).message)).not.toContain("111122223333");
    expect(post).not.toHaveBeenCalled();
    expectNothingSensitiveSent(network);
    expect(await world.sessions.get(workspaceA)).toMatchObject({ state: "READY", instanceId: session.instanceId });
    expect(failOperation).not.toHaveBeenCalled();
    expect(world.db.get(`WORKSPACE#${workspaceA}`, `OPERATION#${record.operationId}`)).toMatchObject({ status: "DISPATCHING" });
    expect(lines).toEqual([{ level: "warn", event: "dispatch.machine_check_unavailable", errorName: "RequestLimitExceeded" }]);
    // The next attempt, with EC2 answering again, goes out.
    ec2.describeFails = false;
    post.mockImplementation(async (url, init) => { network.push({ url, ...init }); return { status: 200, body: "{}" }; });
    expect(await deliver(record, record.invocation)).toBe("DELIVERED");
  });

  it("asks after the token is signed, so the check is the last thing before the bytes leave", async () => {
    const fixture = setup();
    const { record, deliver, ec2, post } = fixture;
    await ready(fixture);
    const order: string[] = [];
    const sign = vi.fn(async (message: Uint8Array) => { order.push("sign"); return fixture.world.sign(message); });
    const fresh = createEc2Delivery({
      sessions: fixture.world.sessions, binding: async () => BINDING, sign,
      post: async () => { order.push("post"); return { status: 200, body: "{}" }; },
      verifyMachine: async () => { order.push("verify"); return { ok: true }; }, failOperation: async () => undefined,
      progress: async () => undefined, applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined, now: () => NOW,
    });
    expect(await fresh(record, record.invocation)).toBe("DELIVERED");
    expect(order).toEqual(["sign", "verify", "post"]);
    expect(ec2.asked).toEqual([]);
    expect(post).not.toHaveBeenCalled();
    void deliver;
  });
});

describe("the project setup path (WDI-SETUP)", () => {
  const SETUP_ADDRESS = "10.42.128.50";
  const SETUP_INSTANCE = "i-0cccccccccccccccc";
  const WORKSPACE_TAG = "99999999-9999-4999-8999-999999999999";
  const binding: Ec2RuntimeBinding = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" };

  /** A READY setup session (with `instanceId` unless it is an old catalog row), its execution, operation and outbox record, EC2 as `instance`, and the real delivery over all of it. */
  function setup(options: { instanceId?: string | undefined; instance?: Partial<InstanceFact> | "absent"; ec2Fails?: boolean; afterDescribe?: () => void } = {}) {
    const instanceId = "instanceId" in options ? options.instanceId : SETUP_INSTANCE;
    const db = new FakeDynamoDb();
    const setupId = crypto.randomUUID(), subjectId = crypto.randomUUID(), correlation = crypto.randomUUID(), operationId = crypto.randomUUID();
    db.set({ ...projectSetupSessionKey(setupId), entityType: "PROJECT_SETUP_SESSION", schemaVersion: 1, setupExecutionId: setupId, subjectId, transportCorrelationId: correlation,
      approvalRevision: 1, bindingDigest: "a".repeat(64), state: "READY", generation: 4, privateIp: SETUP_ADDRESS, ...(instanceId === undefined ? {} : { instanceId }) });
    db.set({ ...projectSetupExecutionKey(setupId), state: "DISPATCHING" });
    db.set({ ...projectSetupOperationKey(setupId, operationId), status: "DISPATCHING" });
    const lines: Array<Record<string, unknown>> = [];
    const asked: string[] = [];
    const reader: MachineReader = {
      async byInstanceId(id) {
        asked.push(id);
        options.afterDescribe?.();
        if (options.ec2Fails === true) throw Object.assign(new Error("RequestLimitExceeded 111122223333"), { name: "RequestLimitExceeded" });
        if (options.instance === "absent") return undefined;
        return { instanceId: id, state: "running", privateIp: SETUP_ADDRESS, workspaceId: undefined, subnetId: binding.subnets[0]!.subnetId, ...options.instance };
      },
      byPrivateIp: async () => [],
    };
    const verifyMachine = createMachineVerifier({ reader, now: () => NOW, markLost: async () => false, markSetupLost: (seen) => markProjectSetupSessionLost(db, TABLE, seen), log: (entry) => { lines.push(entry); } });
    const network: Array<{ url: string; authorization: string; body: string }> = [];
    const post = vi.fn<Ec2DeliveryDependencies["post"]>(async (url, init) => { network.push({ url, ...init }); return { status: 200, body: "{}" }; });
    const invocation = { protocolVersion: 1 as const, operationId, workspaceId: correlation, fence: 1, projectRevision: 1, callbackCapability: CAPABILITY, kind: "project-setup-smoke" as const,
      payload: { domain: "project-setup-source-interface/v1" as const, setupExecutionId: setupId, subjectId, approvalRevision: 1, transportCorrelationId: correlation, executionRef: { key: "k", sha256: "a".repeat(64) } } };
    const record = { id: crypto.randomUUID(), entityType: "OUTBOX" as const, status: "QUEUED" as const, operationId, workspaceId: correlation, deploymentMode: "ec2-ebs" as const, invocation: invocation as unknown as Ec2OutboxRecord["invocation"] };
    const deliver = createEc2Delivery({
      sessions: { ensureSession: async () => { throw new Error("setup must not use workspace sessions"); } },
      binding: async () => { throw new Error("setup must not load workspace binding"); },
      projectSetupBinding: async () => binding,
      projectSetupSessions: new ProjectSetupSessionManager({ documentClient: db, tableName: TABLE }),
      guardProjectSetupDispatch: async () => "ALLOWED",
      sign: async () => new Uint8Array([1]), post, workerFeatures: async () => ["project.setupSmoke"],
      verifyMachine, failOperation: (failed, error) => failProjectSetupOperation(db, TABLE, failed, error),
      progress: async () => undefined, applicationPlanNotNegotiated: async () => undefined, planQualityNotNegotiated: async () => undefined, now: () => NOW,
    });
    // The session's own binding digest is checked by ensureSession: use the digest of this binding.
    db.set({ ...db.get(...Object.values(projectSetupSessionKey(setupId)) as [string, string])!, bindingDigest: projectSetupBindingDigest(binding) });
    return { db, setupId, operationId, record, deliver, post, network, lines, asked, session: () => db.get(...Object.values(projectSetupSessionKey(setupId)) as [string, string])! };
  }

  it("sends the body to the setup runtime that is the row's: running, at its address, carrying no workspace tag", async () => {
    const { deliver, record, post, asked, lines } = setup();
    expect(await deliver(record, record.invocation)).toBe("DELIVERED");
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]![0]).toBe(`http://${SETUP_ADDRESS}:8080/invocations`);
    expect(asked).toEqual([SETUP_INSTANCE]);
    expect(lines).toEqual([]);
  });

  it.each<[string, Partial<InstanceFact> | "absent", string]>([
    ["EC2 says it is terminated", { state: "terminated" }, "not_running"],
    ["EC2 no longer knows the instance", "absent", "not_found"],
    ["it holds a different address", { privateIp: "10.42.128.99" }, "address_changed"],
    ["a workspace's worker holds the address (it carries a workspace tag)", { workspaceId: WORKSPACE_TAG }, "workspace_tag"],
    ["the instance is at the same address in ANOTHER VPC (a subnet outside the runtime binding's)", { subnetId: "subnet-0bbbbbbbbbbbbbbbb" }, "subnet_mismatch"],
  ])("sends nothing, marks the setup session lost and ends the run when %s", async (_name, instance, reason) => {
    const { db, setupId, operationId, deliver, record, post, network, lines, session } = setup({ instance });
    expect(await deliver(record, record.invocation)).toBe("MACHINE_GONE");
    expect(post).not.toHaveBeenCalled();
    expectNothingSensitiveSent(network);
    expect(session()).toMatchObject({ state: "STOPPED", generation: 4 });
    expect(session()).not.toHaveProperty("privateIp");
    expect(session()).not.toHaveProperty("instanceId");
    expect(db.get(...Object.values(projectSetupExecutionKey(setupId)) as [string, string])).toMatchObject({ state: "FAILED", error: COMPUTE_LOST_WORDS });
    expect(db.get(...Object.values(projectSetupOperationKey(setupId, operationId)) as [string, string])).toMatchObject({ status: "FAILED", error: COMPUTE_LOST_WORDS });
    expect(lines).toEqual([expect.objectContaining({ event: "dispatch.machine_gone", kind: "project-setup", reason, markedLost: true, expectedInstanceId: SETUP_INSTANCE, privateIp: SETUP_ADDRESS })]);
  });

  it("is a retryable refusal, not 'gone', when EC2 cannot be asked: nothing sent, the session and the run untouched", async () => {
    const { db, setupId, deliver, record, post, session } = setup({ ec2Fails: true });
    const refusal = await deliver(record, record.invocation).catch((error: unknown) => error as Error);
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((refusal as Error).message).not.toContain("111122223333");
    expect(post).not.toHaveBeenCalled();
    expect(session()).toMatchObject({ state: "READY", instanceId: SETUP_INSTANCE });
    expect(db.get(...Object.values(projectSetupExecutionKey(setupId)) as [string, string])).toMatchObject({ state: "DISPATCHING" });
  });

  // GRACE (decision in machine-check.ts): a catalog row registered before it could name its instance has nothing to compare. It is allowed, and every such delivery says so.
  it("allows, and says so in the log, a setup run whose runtime catalog row was registered without an instance id (a release must not stop setup runs in flight)", async () => {
    const { deliver, record, post, asked, lines, session } = setup({ instanceId: undefined });
    expect(await deliver(record, record.invocation)).toBe("DELIVERED");
    expect(post).toHaveBeenCalledOnce();
    expect(asked).toEqual([]);
    expect(lines).toEqual([expect.objectContaining({ level: "warn", event: "dispatch.machine_unverified", reason: "setup_runtime_has_no_instance_id", privateIp: SETUP_ADDRESS })]);
    expect(session()).toMatchObject({ state: "READY" });
  });

  it("leaves a setup session that moved on between the question and the mark alone, and changes nothing of a run another path already ended (the two writes are one transaction)", async () => {
    let moveOn: () => void = () => undefined;
    const fixture = setup({ instance: { state: "terminated" }, afterDescribe: () => { moveOn(); } });
    const { db, setupId, operationId, deliver, record, post, session, lines } = fixture;
    moveOn = () => { db.set({ ...session(), instanceId: "i-0dddddddddddddddd" }); };
    db.set({ ...projectSetupExecutionKey(setupId), state: "SUCCEEDED" });
    expect(await deliver(record, record.invocation)).toBe("MACHINE_GONE");
    expect(post).not.toHaveBeenCalled();
    expect(session()).toMatchObject({ state: "READY", generation: 4, instanceId: "i-0dddddddddddddddd" });
    expect(db.get(...Object.values(projectSetupExecutionKey(setupId)) as [string, string])).toMatchObject({ state: "SUCCEEDED" });
    expect(db.get(...Object.values(projectSetupOperationKey(setupId, operationId)) as [string, string])).toMatchObject({ status: "DISPATCHING" });
    expect(lines).toEqual([expect.objectContaining({ event: "dispatch.machine_gone", markedLost: false })]);
  });
});
