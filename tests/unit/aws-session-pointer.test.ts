import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SessionManager, workspaceBinding } from "../../packages/broker/src/aws/sessions.js";
import { failActiveOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { workspaceProjectReader } from "../../packages/broker/src/aws/turns.js";

const companyId = IMPLICIT_COMPANY_ID;
const otherCompany = "org_bbbbbbbbbbbbbbbbbbbb";
let db: FakeDynamoDb;
let ec2Calls: string[];
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
function seed(fields: Record<string, unknown> = {}) {
  const workspaceId = randomUUID();
  const pk = `ORG#${companyId}#WORKSPACE#${workspaceId}`;
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId, companyId });
  db.set({ pk, sk: "META", entityType: "WORKSPACE", id: workspaceId, companyId, orgId: companyId, status: "READY", fence: 1, ...fields });
  return { workspaceId, pk };
}
function ready(workspaceId: string) {
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", entityType: "SESSION", workspaceId, state: "READY", sessionState: "READY", generation: 1,
    volumeId: "vol-0123456789abcdef0", instanceId: "i-0123456789abcdef0", privateIp: "10.42.128.10", availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa",
    lastActivityAt: ago(30), launchedAt: ago(60), readyAt: ago(60) });
}
beforeEach(() => {
  db = new FakeDynamoDb(); ec2Calls = [];
  vi.resetModules();
  vi.stubEnv("STATE_TABLE_NAME", "state");
  vi.stubEnv("AGENTX_METRICS_NAMESPACE", "test");
  vi.stubEnv("AGENTX_ACCOUNT_ID", "111122223333");
  vi.stubEnv("AGENTX_INSTALL_ID", "test");
  vi.stubEnv("ENVIRONMENT_TAG", "test");
  vi.spyOn(DynamoDBDocumentClient, "from").mockReturnValue(db as never);
  vi.spyOn(EC2Client.prototype, "send").mockImplementation((async (command: { constructor: { name: string } }) => {
    ec2Calls.push(command.constructor.name);
    if (command.constructor.name === "DescribeInstancesCommand") return { Reservations: [] };
    if (command.constructor.name === "DescribeVolumesCommand") return { Volumes: [] };
    return {};
  }) as never);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("missed worker ping"); }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("AWS lifecycle follows workspace discovery", () => {
  it("does not reap a core run with a live operation when the worker ping fails", async () => {
    const { workspaceId } = seed({ activeOperationId: randomUUID() }); ready(workspaceId);
    const { handler } = await import("../../packages/broker/src/aws/session-reaper.js");
    expect((await handler()).skippedBusy).toEqual([workspaceId]);
    expect(db.get(`WORKSPACE#${workspaceId}`, "SESSION")).toMatchObject({ state: "READY" });
    expect(ec2Calls).not.toContain("TerminateInstancesCommand");
  });
  it("fences claimStop on the scoped operation, including an operation arriving after the session read", async () => {
    const { workspaceId, pk } = seed(); ready(workspaceId);
    const sessions = new SessionManager({ documentClient: db, tableName: "state", executions: { provisionerArn: "", deleterArn: "", start: async () => "" } });
    const seen = (await sessions.get(workspaceId))!;
    db.get(pk, "META")!.activeOperationId = randomUUID();
    expect(await sessions.claimStop(seen)).toBe(false);
    expect(db.get(`WORKSPACE#${workspaceId}`, "SESSION")).toMatchObject({ state: "READY" });
    delete db.get(pk, "META")!.activeOperationId;
    expect(await sessions.claimStop(seen)).toBe(true);
  });
  it("deletes a closed core workspace volume instead of quarantining it", async () => {
    const { workspaceId } = seed({ status: "CLOSED", closedAt: ago(120) });
    vi.mocked(EC2Client.prototype.send).mockImplementation((async (command: { constructor: { name: string } }) => {
      ec2Calls.push(command.constructor.name);
      if (command.constructor.name === "DescribeInstancesCommand") return { Reservations: [] };
      if (command.constructor.name === "DescribeVolumesCommand") return { Volumes: [{ VolumeId: "vol-0123456789abcdef0", State: "available", CreateTime: new Date(ago(600)), Tags: [{ Key: "agentx:workspace", Value: workspaceId }] }] };
      return {};
    }) as never);
    const { handler } = await import("../../packages/broker/src/aws/session-reconciler.js");
    expect((await handler()).closedVolumesDeleted).toEqual(["vol-0123456789abcdef0"]);
    expect(ec2Calls).toContain("DeleteVolumeCommand");
    expect(ec2Calls).not.toContain("CreateTagsCommand");
  });
  it("fails and releases a core workspace operation, leaving its pointer thin", async () => {
    const operationId = randomUUID(); const { workspaceId, pk } = seed({ status: "BUSY", activeOperationId: operationId });
    db.set({ pk, sk: `OPERATION#${operationId}`, kind: "task", status: "RUNNING", fence: 1, companyId });
    expect(await failActiveOperation(db, "state", workspaceId, "lost")).toBe(operationId);
    expect(db.get(pk, `OPERATION#${operationId}`)).toMatchObject({ status: "FAILED", error: "lost" });
    expect(db.get(pk, "META")).toMatchObject({ status: "READY" });
    expect(db.get(pk, "META")).not.toHaveProperty("activeOperationId");
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("status");
  });
  it("reads the scoped workspace project for turn exports and runtime binding", async () => {
    const { workspaceId } = seed({ deploymentMode: "ec2-ebs", projectName: "payments", projectRevision: 1 });
    expect(await workspaceProjectReader(db, "state")(workspaceId)).toBe("payments");
    const binding = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" };
    db.set({ pk: "PROJECT#payments", sk: "REV#000000000001", runtimeBinding: binding });
    expect(await workspaceBinding(db, "state", workspaceId)).toEqual(binding);
  });
  it.each(["missing", "foreign", "org mismatch"])("skips a %s scoped workspace while reaping a healthy session", async (fault) => {
    const operationId = randomUUID(); const { workspaceId, pk } = seed({ activeOperationId: operationId }); ready(workspaceId);
    const healthy = seed(); ready(healthy.workspaceId);
    if (fault === "missing") db.delete(pk, "META");
    else db.set({ ...db.get(pk, "META")!, ...(fault === "foreign" ? { companyId: otherCompany } : { orgId: otherCompany }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sessions = new SessionManager({ documentClient: db, tableName: "state", executions: { provisionerArn: "", deleterArn: "", start: async () => "" } });
    for (const read of [
      () => sessions.claimStop((db.get(`WORKSPACE#${workspaceId}`, "SESSION")) as never),
      () => failActiveOperation(db, "state", workspaceId, "lost"),
      () => workspaceBinding(db, "state", workspaceId),
      () => workspaceProjectReader(db, "state")(workspaceId),
    ]) {
      warn.mockClear();
      await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: workspace unavailable" });
      expect(warn.mock.calls).toEqual([[{ component: "broker", event: "workspace.pointer_integrity" }]]);
    }
    warn.mockClear();
    const result = await (await import("../../packages/broker/src/aws/session-reaper.js")).handler();
    expect(result.skippedBusy).toContain(workspaceId);
    expect(result.claimed).toContain(healthy.workspaceId);
    expect(ec2Calls.filter((call) => call === "TerminateInstancesCommand")).toHaveLength(1);
    expect(warn.mock.calls).toEqual([[{ component: "broker", event: "workspace.pointer_integrity" }]]);
  });
});
