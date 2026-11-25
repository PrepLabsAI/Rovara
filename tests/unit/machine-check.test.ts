// WORKER-DELIVERY-IDENTITY (b-plus): the machine check that runs before every POST to a worker (packages/broker/src/aws/machine-check.ts), and its EC2 reader.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { describe, expect, it, vi } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { COMPUTE_LOST_WORDS } from "../../packages/broker/src/aws/session-lost.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { SETUP_UNVERIFIED_METRIC, createEc2MachineReader, dispatcherMachineChecks, withMetric } from "../../packages/broker/src/aws/machine-check-aws.js";
import {
  MACHINE_CHECK_UNAVAILABLE_WORDS,
  createMachineVerifier,
  machineMismatch,
  SETUP_UNVERIFIED_GRACE_ENDS_AT_MS,
  type InstanceFact,
  type MachineToCheck,
} from "../../packages/broker/src/aws/machine-check.js";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const INSTANCE_A = "i-0aaaaaaaaaaaaaaa1";
const INSTANCE_B = "i-0bbbbbbbbbbbbbbb2";
const ADDRESS = "10.42.128.10";
const SUBNET = "subnet-0aaaaaaaaaaaaaaaa";
const OTHER_VPC_SUBNET = "subnet-0bbbbbbbbbbbbbbbb";
const MACHINE: MachineToCheck = { kind: "workspace", workspaceId: WORKSPACE_A, generation: 3, instanceId: INSTANCE_A, privateIp: ADDRESS, subnetIds: [SUBNET] };
const RUNNING_A: InstanceFact = { instanceId: INSTANCE_A, state: "running", privateIp: ADDRESS, workspaceId: WORKSPACE_A, subnetId: SUBNET };

function verifier(options: { found?: InstanceFact | undefined; holders?: InstanceFact[]; describe?: () => Promise<InstanceFact | undefined>; marked?: boolean } = {}) {
  const byInstanceId = vi.fn<(id: string) => Promise<InstanceFact | undefined>>(options.describe ?? (async () => options.found));
  const byPrivateIp = vi.fn<(ip: string) => Promise<InstanceFact[]>>(async () => options.holders ?? []);
  const markLost = vi.fn(async () => options.marked ?? true);
  const lines: Array<Record<string, unknown>> = [];
  // A fixed clock before the grace date, so no test here changes meaning when the date passes.
  const verify = createMachineVerifier({ reader: { byInstanceId, byPrivateIp }, markLost, now: () => Date.parse("2026-11-25T00:00:00.000Z"), log: (entry) => { lines.push(entry); } });
  return { verify, byInstanceId, byPrivateIp, markLost, lines };
}

describe("the machine check", () => {
  it("passes the row's own machine: running, at the row's address, tagged for the row's workspace", async () => {
    const { verify, markLost, byPrivateIp, byInstanceId, lines } = verifier({ found: RUNNING_A });
    expect(await verify(MACHINE)).toEqual({ ok: true });
    expect(byInstanceId).toHaveBeenCalledExactlyOnceWith(INSTANCE_A);
    expect(markLost).not.toHaveBeenCalled();
    expect(byPrivateIp).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it.each<[string, InstanceFact | undefined, string]>([
    ["EC2 says the instance is terminated", { ...RUNNING_A, state: "terminated" }, "not_running"],
    ["EC2 says it is shutting down", { ...RUNNING_A, state: "shutting-down" }, "not_running"],
    ["EC2 says it is stopped", { ...RUNNING_A, state: "stopped" }, "not_running"],
    ["EC2 no longer knows the instance", undefined, "not_found"],
    ["the instance runs at another address", { ...RUNNING_A, privateIp: "10.42.128.99" }, "address_changed"],
    ["the instance carries another workspace's tag", { ...RUNNING_A, workspaceId: WORKSPACE_B }, "workspace_tag"],
    ["the instance carries no workspace tag", { ...RUNNING_A, workspaceId: undefined }, "workspace_tag"],
  ])("sends nothing and marks the row lost when %s", async (_name, found, reason) => {
    const { verify, markLost, lines } = verifier({ found });
    expect(await verify(MACHINE)).toEqual({ ok: false, markedLost: true });
    // Conditional on exactly what the row says: its workspace, generation and instance.
    expect(markLost).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_A, generation: 3, instanceId: INSTANCE_A });
    expect(lines).toEqual([expect.objectContaining({ event: "dispatch.machine_gone", reason, markedLost: true, expectedWorkspaceId: WORKSPACE_A, expectedInstanceId: INSTANCE_A, privateIp: ADDRESS })]);
  });

  it("names who holds the address now, with both workspace ids, when another workspace's machine took it", async () => {
    const holder: InstanceFact = { instanceId: INSTANCE_B, state: "running", privateIp: ADDRESS, workspaceId: WORKSPACE_B };
    const { verify, lines, byPrivateIp } = verifier({ found: { ...RUNNING_A, state: "terminated" }, holders: [holder] });
    expect(await verify(MACHINE)).toEqual({ ok: false, markedLost: true });
    expect(byPrivateIp).toHaveBeenCalledExactlyOnceWith(ADDRESS);
    expect(lines).toEqual([expect.objectContaining({
      event: "dispatch.machine_gone", expectedWorkspaceId: WORKSPACE_A, heldByWorkspaceId: WORKSPACE_B, expectedInstanceId: INSTANCE_A, heldByInstanceId: INSTANCE_B, privateIp: ADDRESS,
    })]);
  });

  it("still answers gone, and still marks the row, when the holder lookup fails", async () => {
    const { verify, markLost, byPrivateIp } = verifier({ found: undefined });
    byPrivateIp.mockRejectedValue(new Error("throttled"));
    expect(await verify(MACHINE)).toEqual({ ok: false, markedLost: true });
    expect(markLost).toHaveBeenCalledOnce();
  });

  it("reports gone, without touching the row, when the row had already moved on", async () => {
    const { verify, lines } = verifier({ found: undefined, marked: false });
    expect(await verify(MACHINE)).toEqual({ ok: false, markedLost: false });
    expect(lines[0]).toMatchObject({ event: "dispatch.machine_gone", markedLost: false });
  });

  it("is not 'gone' when EC2 cannot be asked: a retryable refusal in fixed words, nothing marked, and the SDK's own text never carried", async () => {
    const { verify, markLost, lines } = verifier({ describe: async () => { throw Object.assign(new Error("RequestLimitExceeded arn:aws:ec2:secret-detail"), { name: "RequestLimitExceeded" }); } });
    const refusal = await verify(MACHINE).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((refusal as Error).message).toContain(MACHINE_CHECK_UNAVAILABLE_WORDS);
    expect(JSON.stringify(refusal instanceof Error ? refusal.message : refusal)).not.toContain("secret-detail");
    expect(markLost).not.toHaveBeenCalled();
    expect(lines).toEqual([{ level: "warn", event: "dispatch.machine_check_unavailable", errorName: "RequestLimitExceeded" }]);
  });

  it("refuses a workspace row with no instance id (it cannot be checked) and leaves the row alone: its write is conditional on an instance", async () => {
    const { verify, markLost, byInstanceId } = verifier({ found: RUNNING_A });
    expect(await verify({ ...MACHINE, instanceId: undefined })).toEqual({ ok: false, markedLost: false });
    expect(byInstanceId).not.toHaveBeenCalled();
    expect(markLost).not.toHaveBeenCalled();
  });

  it("allows a project setup row with no instance id (a catalog row registered before it could name one) without asking EC2, and says so", async () => {
    const { verify, byInstanceId, markLost, lines } = verifier({ found: undefined });
    expect(await verify({ ...MACHINE, kind: "project-setup", instanceId: undefined, setupExecutionId: WORKSPACE_B })).toEqual({ ok: true });
    expect(byInstanceId).not.toHaveBeenCalled();
    expect(markLost).not.toHaveBeenCalled();
    expect(lines).toEqual([expect.objectContaining({ event: "dispatch.machine_unverified", setupExecutionId: WORKSPACE_B })]);
  });

  it("ends grace on its date: from then on a setup row with no instance id is refused like a workspace row without one, and nothing is marked", async () => {
    const markSetupLost = vi.fn(async () => true);
    const lines: Array<Record<string, unknown>> = [];
    const setup: MachineToCheck = { ...MACHINE, kind: "project-setup", instanceId: undefined, setupExecutionId: WORKSPACE_B };
    const before = createMachineVerifier({ reader: { byInstanceId: async () => undefined, byPrivateIp: async () => [] }, markLost: async () => true, markSetupLost, now: () => SETUP_UNVERIFIED_GRACE_ENDS_AT_MS - 1, log: (entry) => { lines.push(entry); } });
    expect(await before(setup)).toEqual({ ok: true });
    const after = createMachineVerifier({ reader: { byInstanceId: async () => undefined, byPrivateIp: async () => [] }, markLost: async () => true, markSetupLost, now: () => SETUP_UNVERIFIED_GRACE_ENDS_AT_MS, log: (entry) => { lines.push(entry); } });
    expect(await after(setup)).toEqual({ ok: false, markedLost: false });
    expect(markSetupLost).not.toHaveBeenCalled();
    expect(lines.map((line) => line.event)).toEqual(["dispatch.machine_unverified", "dispatch.machine_gone"]);
    expect(lines[1]).toMatchObject({ reason: "no_instance_id", kind: "project-setup" });
    expect(new Date(SETUP_UNVERIFIED_GRACE_ENDS_AT_MS).toISOString()).toBe("2026-12-09T00:00:00.000Z");
  });

  it("counts every unverified setup delivery as one SetupMachineUnverified in the same log line (embedded metric format), and no other event", () => {
    const line = withMetric({ event: "dispatch.machine_unverified", privateIp: ADDRESS }, "AgentX");
    expect(line).toMatchObject({ SetupMachineUnverified: 1, _aws: { CloudWatchMetrics: [{ Namespace: "AgentX", Dimensions: [[]], Metrics: [{ Name: SETUP_UNVERIFIED_METRIC, Unit: "Count" }] }] } });
    expect(SETUP_UNVERIFIED_METRIC).toBe("SetupMachineUnverified");
    const gone = { event: "dispatch.machine_gone" };
    expect(withMetric(gone, "AgentX")).toBe(gone);
    const unverified = { event: "dispatch.machine_unverified" };
    expect(withMetric(unverified, undefined)).toBe(unverified);
    expect(withMetric(unverified, "")).toBe(unverified);
  });

  it("checks a project setup row that names its instance like a workspace row, except that the machine must carry NO workspace tag, and marks the setup session (never a workspace session)", async () => {
    const setup: MachineToCheck = { ...MACHINE, kind: "project-setup", setupExecutionId: WORKSPACE_B };
    const clean: InstanceFact = { ...RUNNING_A, workspaceId: undefined };
    expect(machineMismatch(setup, clean)).toBeUndefined();
    expect(machineMismatch(setup, RUNNING_A)).toBe("workspace_tag");
    const markSetupLost = vi.fn(async () => true);
    const markLost = vi.fn(async () => true);
    const verify = createMachineVerifier({ reader: { byInstanceId: async () => ({ ...clean, state: "terminated" }), byPrivateIp: async () => [] }, markLost, markSetupLost, log: () => undefined });
    expect(await verify(setup)).toEqual({ ok: false, markedLost: true });
    expect(markSetupLost).toHaveBeenCalledExactlyOnceWith({ setupExecutionId: WORKSPACE_B, generation: 3, instanceId: INSTANCE_A });
    expect(markLost).not.toHaveBeenCalled();
  });

  it("refuses an instance of the right id at the right address in ANOTHER VPC (private addresses are unique only within their VPC), and an instance whose subnet is unknown or unlisted", async () => {
    const otherVpc: InstanceFact = { ...RUNNING_A, subnetId: OTHER_VPC_SUBNET };
    expect(machineMismatch(MACHINE, otherVpc)).toBe("subnet_mismatch");
    expect(machineMismatch(MACHINE, { ...RUNNING_A, subnetId: undefined })).toBe("subnet_mismatch");
    expect(machineMismatch({ ...MACHINE, subnetIds: [] }, RUNNING_A)).toBe("subnet_mismatch");
    expect(machineMismatch({ ...MACHINE, subnetIds: [OTHER_VPC_SUBNET, SUBNET] }, RUNNING_A)).toBeUndefined();
    const { verify, markLost, lines } = verifier({ found: otherVpc });
    expect(await verify(MACHINE)).toEqual({ ok: false, markedLost: true });
    expect(markLost).toHaveBeenCalledOnce();
    expect(lines[0]).toMatchObject({ event: "dispatch.machine_gone", reason: "subnet_mismatch" });
  });

  it("holds each condition separately (mutation guard on machineMismatch)", () => {
    expect(machineMismatch(MACHINE, RUNNING_A)).toBeUndefined();
    expect(machineMismatch(MACHINE, { ...RUNNING_A, state: "pending" })).toBe("not_running");
    expect(machineMismatch(MACHINE, { ...RUNNING_A, privateIp: undefined })).toBe("address_changed");
    expect(machineMismatch(MACHINE, { ...RUNNING_A, workspaceId: WORKSPACE_B })).toBe("workspace_tag");
  });
});

describe("the EC2 reader", () => {
  const reservation = (...instances: Array<{ id: string; state: string; ip: string; workspace?: string }>) => ({
    Reservations: [{ Instances: instances.map((instance) => ({
      InstanceId: instance.id, State: { Name: instance.state }, PrivateIpAddress: instance.ip, SubnetId: SUBNET,
      Tags: [{ Key: "Environment", Value: "prod" }, ...(instance.workspace === undefined ? [] : [{ Key: "agentx:workspace", Value: instance.workspace }])],
    })) }],
  });

  it("describes the row's instance by id and reads its state, address and workspace tag", async () => {
    const send = vi.fn<(command: unknown) => Promise<ReturnType<typeof reservation>>>(async () => reservation({ id: INSTANCE_A, state: "running", ip: ADDRESS, workspace: WORKSPACE_A }));
    expect(await createEc2MachineReader({ send }).byInstanceId(INSTANCE_A)).toEqual(RUNNING_A);
    const command = send.mock.calls[0]![0] as DescribeInstancesCommand;
    expect(command).toBeInstanceOf(DescribeInstancesCommand);
    expect(command.input).toEqual({ InstanceIds: [INSTANCE_A] });
  });

  it("treats an instance EC2 has forgotten as no such machine, and any other failure as a failure to ask", async () => {
    const forgotten = vi.fn(async () => { throw Object.assign(new Error("The instance ID does not exist"), { name: "InvalidInstanceID.NotFound" }); });
    expect(await createEc2MachineReader({ send: forgotten }).byInstanceId(INSTANCE_A)).toBeUndefined();
    const throttled = vi.fn(async () => { throw Object.assign(new Error("slow down"), { name: "RequestLimitExceeded" }); });
    await expect(createEc2MachineReader({ send: throttled }).byInstanceId(INSTANCE_A)).rejects.toMatchObject({ name: "RequestLimitExceeded" });
  });

  it("ignores a different instance in the answer", async () => {
    const send = vi.fn<(command: unknown) => Promise<ReturnType<typeof reservation>>>(async () => reservation({ id: INSTANCE_B, state: "running", ip: ADDRESS, workspace: WORKSPACE_B }));
    expect(await createEc2MachineReader({ send }).byInstanceId(INSTANCE_A)).toBeUndefined();
  });

  it("asks who holds an address among pending and running instances only", async () => {
    const send = vi.fn<(command: unknown) => Promise<ReturnType<typeof reservation>>>(async () => reservation({ id: INSTANCE_B, state: "running", ip: ADDRESS, workspace: WORKSPACE_B }));
    expect(await createEc2MachineReader({ send }).byPrivateIp(ADDRESS)).toEqual([{ instanceId: INSTANCE_B, state: "running", privateIp: ADDRESS, subnetId: SUBNET, workspaceId: WORKSPACE_B }]);
    const command = send.mock.calls[0]![0] as DescribeInstancesCommand;
    expect(command.input).toEqual({ Filters: [
      { Name: "private-ip-address", Values: [ADDRESS] },
      { Name: "instance-state-name", Values: ["pending", "running"] },
    ] });
  });
});

// The reader against the SDK's REAL shapes: a real EC2Client whose transport answers with EC2's own XML wire format, so the error name, the State/Tags/PrivateIpAddress fields and the request
// filters are those the service sends and the SDK parses, not ones this test invented.
describe("the EC2 reader through the real SDK client", () => {
  const XMLNS = "http://ec2.amazonaws.com/doc/2016-11-15/";
  const instanceXml = (id: string, state: { code: number; name: string }, ip: string | undefined, tags: Array<[string, string]>) => `<item>
    <instanceId>${id}</instanceId><imageId>ami-0123456789abcdef0</imageId><instanceState><code>${state.code}</code><name>${state.name}</name></instanceState>
    <instanceType>m6g.large</instanceType><launchTime>2026-11-24T10:00:00.000Z</launchTime>${ip === undefined ? "" : `<privateIpAddress>${ip}</privateIpAddress><subnetId>${SUBNET}</subnetId><vpcId>vpc-0123456789abcdef0</vpcId>`}
    <tagSet>${tags.map(([key, value]) => `<item><key>${key}</key><value>${value}</value></item>`).join("")}</tagSet></item>`;
  const describeXml = (...instances: string[]) => `<?xml version="1.0" encoding="UTF-8"?><DescribeInstancesResponse xmlns="${XMLNS}"><requestId>req-1</requestId>
    <reservationSet><item><reservationId>r-0123456789abcdef0</reservationId><ownerId>111122223333</ownerId><instancesSet>${instances.join("")}</instancesSet></item></reservationSet></DescribeInstancesResponse>`;
  const errorXml = (code: string, message: string) => `<?xml version="1.0" encoding="UTF-8"?><Response><Errors><Error><Code>${code}</Code><Message>${message}</Message></Error></Errors><RequestID>req-2</RequestID></Response>`;

  function client(answer: { status: number; xml: string }) {
    const bodies: string[] = [];
    const ec2 = new EC2Client({
      region: "us-east-1", credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" }, maxAttempts: 1,
      requestHandler: {
        async handle(request: { body?: unknown }) {
          bodies.push(String(request.body));
          return { response: { statusCode: answer.status, headers: { "content-type": "text/xml;charset=UTF-8" }, body: Readable.from([Buffer.from(answer.xml)]) } };
        },
        updateHttpClientConfig() { /* none */ },
        httpHandlerConfigs() { return {}; },
      } as never,
    });
    return { ec2, bodies };
  }

  it("reads the state, private address and workspace tag the way EC2 sends them", async () => {
    const { ec2, bodies } = client({ status: 200, xml: describeXml(instanceXml(INSTANCE_A, { code: 16, name: "running" }, ADDRESS, [["Environment", "prod"], ["agentx:workspace", WORKSPACE_A]])) });
    expect(await createEc2MachineReader(ec2).byInstanceId(INSTANCE_A)).toEqual(RUNNING_A);
    expect(bodies[0]).toContain("Action=DescribeInstances");
    expect(bodies[0]).toContain(`InstanceId.1=${INSTANCE_A}`);
  });

  it("reads a terminated instance (no private address, no workspace tag once EC2 clears them) as not running and never as the row's machine", async () => {
    const { ec2 } = client({ status: 200, xml: describeXml(instanceXml(INSTANCE_A, { code: 48, name: "terminated" }, undefined, [])) });
    const fact = await createEc2MachineReader(ec2).byInstanceId(INSTANCE_A);
    expect(fact).toEqual({ instanceId: INSTANCE_A, state: "terminated", privateIp: undefined, subnetId: undefined, workspaceId: undefined });
    expect(machineMismatch(MACHINE, fact)).toBe("not_running");
  });

  it("treats EC2's own InvalidInstanceID.NotFound answer (HTTP 400) as no such machine", async () => {
    const { ec2 } = client({ status: 400, xml: errorXml("InvalidInstanceID.NotFound", `The instance ID '${INSTANCE_A}' does not exist`) });
    expect(await createEc2MachineReader(ec2).byInstanceId(INSTANCE_A)).toBeUndefined();
  });

  it("treats a throttle (HTTP 503 RequestLimitExceeded) and a malformed id as a failure to ask, never as gone", async () => {
    for (const [status, code] of [[503, "RequestLimitExceeded"], [400, "InvalidInstanceID.Malformed"], [403, "UnauthorizedOperation"]] as const) {
      const { ec2 } = client({ status, xml: errorXml(code, "details with arn:aws:iam::111122223333:role/x") });
      await expect(createEc2MachineReader(ec2).byInstanceId(INSTANCE_A), code).rejects.toMatchObject({ name: code });
    }
  });

  it("asks who holds an address with the private-ip and state filters in EC2's wire form", async () => {
    const { ec2, bodies } = client({ status: 200, xml: describeXml(instanceXml(INSTANCE_B, { code: 16, name: "running" }, ADDRESS, [["agentx:workspace", WORKSPACE_B]])) });
    expect(await createEc2MachineReader(ec2).byPrivateIp(ADDRESS)).toEqual([{ instanceId: INSTANCE_B, state: "running", privateIp: ADDRESS, subnetId: SUBNET, workspaceId: WORKSPACE_B }]);
    const decoded = decodeURIComponent(bodies[0]!);
    expect(decoded).toContain("Filter.1.Name=private-ip-address");
    expect(decoded).toContain(`Filter.1.Value.1=${ADDRESS}`);
    expect(decoded).toContain("Filter.2.Name=instance-state-name");
    expect(decoded).toContain("Filter.2.Value.1=pending");
    expect(decoded).toContain("Filter.2.Value.2=running");
  });
});

describe("the dispatcher's wiring", () => {
  it("is never built without the State table: an unset or empty name fails loudly, not as a check that cannot mark a row", () => {
    const sessions = { markLost: async () => true };
    expect(() => dispatcherMachineChecks({ documentClient: { send: async () => ({}) } as never, tableName: undefined, sessions })).toThrow("STATE_TABLE_NAME is required");
    expect(() => dispatcherMachineChecks({ documentClient: { send: async () => ({}) } as never, tableName: "", sessions })).toThrow("STATE_TABLE_NAME is required");
    expect(dispatcherMachineChecks({ documentClient: { send: async () => ({}) } as never, tableName: "state", sessions, ec2: { send: async () => ({}) } }).verifyMachine).toBeTypeOf("function");
  });
});

describe("ending the delivery's operation when the machine is gone", () => {
  /** A workspace running a task (active operation, `taskStatus`) and an outbox record of `kind` for an operation of its own. */
  function seed(kind: "cancel" | "task", taskStatus: string) {
    const db = new FakeDynamoDb();
    const workspaceId = randomUUID();
    const taskOperation = randomUUID();
    const ownOperation = kind === "task" ? taskOperation : randomUUID();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "BUSY", deploymentMode: "ec2-ebs", fence: 1, activeOperationId: taskOperation });
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${taskOperation}`, kind: "task", status: kind === "task" ? "DISPATCHING" : taskStatus, fence: 1 });
    if (kind === "cancel") db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${ownOperation}`, kind: "cancel", status: "DISPATCHING", fence: 1 });
    const record = { id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId: ownOperation, workspaceId, deploymentMode: "ec2-ebs",
      invocation: { protocolVersion: 1, kind, operationId: ownOperation, workspaceId, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: kind === "task" ? { conversationId: randomUUID(), prompt: "x" } : { targetOperationId: taskOperation } } } as unknown as Ec2OutboxRecord;
    db.set({ pk: `OUTBOX#${record.id}`, sk: "OUTBOX", ...record });
    const checks = dispatcherMachineChecks({ documentClient: db, tableName: "state", sessions: { markLost: async () => true }, ec2: { send: async () => ({}) }, log: () => undefined });
    return { db, workspaceId, taskOperation, ownOperation, record, checks };
  }

  it("fails the task a cancel targets too, not only the cancel: the workspace is released now, not at the stuck-cancel sweep", async () => {
    const { db, workspaceId, taskOperation, ownOperation, record, checks } = seed("cancel", "CANCEL_REQUESTED");
    await checks.failOperation(record, COMPUTE_LOST_WORDS, { markedLost: true });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${ownOperation}`)).toMatchObject({ status: "FAILED", error: COMPUTE_LOST_WORDS });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperation}`)).toMatchObject({ status: "FAILED", error: COMPUTE_LOST_WORDS });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect(db.get(`OUTBOX#${record.id}`, "OUTBOX")).toMatchObject({ status: "FAILED" });
  });

  it("ends a project setup run through its own keys (execution and operation), never a WORKSPACE# row, as the dispatcher wires it", async () => {
    const db = new FakeDynamoDb();
    const setupId = randomUUID(); const operationId = randomUUID(); const correlation = randomUUID();
    db.set({ pk: `PROJECT_SETUP#${setupId}`, sk: "EXECUTION", state: "DISPATCHING" });
    db.set({ pk: `PROJECT_SETUP#${setupId}`, sk: `OPERATION#${operationId}`, status: "DISPATCHING" });
    const record = { id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId: correlation, deploymentMode: "ec2-ebs",
      invocation: { protocolVersion: 1, kind: "project-setup-smoke", operationId, workspaceId: correlation, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { domain: "project-setup-source-interface/v1", setupExecutionId: setupId, subjectId: randomUUID(), approvalRevision: 1, transportCorrelationId: correlation, executionRef: { key: "k", sha256: "a".repeat(64) } } } } as unknown as Ec2OutboxRecord;
    const checks = dispatcherMachineChecks({ documentClient: db, tableName: "state", sessions: { markLost: async () => true }, ec2: { send: async () => ({}) }, log: () => undefined });
    await checks.failOperation(record, COMPUTE_LOST_WORDS, { markedLost: true });
    expect(db.find((item) => item.state === "FAILED")).toHaveLength(1);
    expect(db.find((item) => item.status === "FAILED")).toHaveLength(1);
    expect(db.find((item) => String(item.pk).startsWith("WORKSPACE#"))).toEqual([]);
  });

  it("leaves the workspace's active operation alone when this call did not move the row (another path repaired it and owns what follows)", async () => {
    const { db, workspaceId, taskOperation, ownOperation, record, checks } = seed("cancel", "CANCEL_REQUESTED");
    await checks.failOperation(record, COMPUTE_LOST_WORDS, { markedLost: false });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${ownOperation}`)).toMatchObject({ status: "FAILED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperation}`)).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "BUSY", activeOperationId: taskOperation });
  });

  it("leaves the workspace's active operation alone when it is not the cancel's target (a task that replaced it)", async () => {
    const { db, workspaceId, taskOperation, record, checks } = seed("cancel", "CANCEL_REQUESTED");
    const replacement = randomUUID();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${replacement}`, kind: "task", status: "RUNNING", fence: 1 });
    db.set({ ...db.get(`WORKSPACE#${workspaceId}`, "META")!, activeOperationId: replacement });
    await checks.failOperation(record, COMPUTE_LOST_WORDS, { markedLost: true });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${replacement}`)).toMatchObject({ status: "RUNNING" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperation}`)).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ activeOperationId: replacement });
  });

  it("fails a task's own operation once, with nothing left over to fail, for every other kind", async () => {
    const { db, workspaceId, taskOperation, record, checks } = seed("task", "DISPATCHING");
    await checks.failOperation(record, COMPUTE_LOST_WORDS, { markedLost: true });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperation}`)).toMatchObject({ status: "FAILED", error: COMPUTE_LOST_WORDS });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(db.get(`OUTBOX#${record.id}`, "OUTBOX")).toMatchObject({ status: "FAILED" });
  });
});
