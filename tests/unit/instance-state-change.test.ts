// WORKER-DELIVERY-IDENTITY step 0 (ii): an instance that ends marks its READY session lost within seconds (packages/broker/src/aws/instance-state-change.ts), over the real session code.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ENDED_INSTANCE_STATES, createInstanceStateChangeHandler, type InstanceStateChangeEvent } from "../../packages/broker/src/aws/instance-state-change.js";
import { failActiveOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { COMPUTE_LOST_WORDS } from "../../packages/broker/src/aws/session-lost.js";
import { SessionManager } from "../../packages/broker/src/aws/sessions.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const hex = () => randomUUID().replaceAll("-", "").slice(0, 17);

function setup() {
  const db = new FakeDynamoDb();
  const sessions = new SessionManager({ documentClient: db, tableName: "state", now: () => NOW });
  const emit = vi.fn<(metrics: Record<string, number>) => void>();
  const lines: Array<Record<string, unknown>> = [];
  const handler = createInstanceStateChangeHandler({
    sessions,
    failActiveOperation: (workspaceId, error) => failActiveOperation(db, "state", workspaceId, error),
    emit,
    log: (entry) => { lines.push(entry); },
  });
  /** A workspace with a session in `state` on a fresh instance, and (optionally) a running operation. */
  const seed = (state: string, options: { operation?: boolean; generation?: number } = {}) => {
    const workspaceId = randomUUID();
    const instanceId = `i-${hex()}`;
    const operationId = randomUUID();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: options.operation === true ? "BUSY" : "READY", deploymentMode: "ec2-ebs", fence: 1, ...(options.operation === true ? { activeOperationId: operationId } : {}) });
    if (options.operation === true) db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, kind: "task", status: "RUNNING", fence: 1 });
    db.set({
      pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", entityType: "SESSION", workspaceId, state, sessionState: state, generation: options.generation ?? 1,
      availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa", volumeId: `vol-${hex()}`, instanceId, privateIp: "10.42.128.10",
      launchedAt: minutesAgo(60), readyAt: minutesAgo(58), lastActivityAt: minutesAgo(1),
    });
    return { workspaceId, instanceId, operationId };
  };
  const row = (workspaceId: string) => db.get(`WORKSPACE#${workspaceId}`, "SESSION")!;
  const event = (instanceId: string, state: string): InstanceStateChangeEvent => ({ source: "aws.ec2", "detail-type": "EC2 Instance State-change Notification", detail: { "instance-id": instanceId, state } });
  return { db, sessions, emit, lines, handler, seed, row, event };
}

describe("an instance that ends", () => {
  it.each(["terminated", "shutting-down", "stopping"])("marks only the READY session that holds it lost when it is %s, and fails that session's running operation", async (state) => {
    const { db, handler, seed, row, event, emit, lines } = setup();
    const victim = seed("READY", { operation: true });
    const bystander = seed("READY", { operation: true });

    expect(await handler(event(victim.instanceId, state))).toBe("marked_lost");

    expect(row(victim.workspaceId)).toMatchObject({ state: "STOPPED", sessionState: "STOPPED" });
    expect(row(victim.workspaceId)).not.toHaveProperty("instanceId");
    expect(row(victim.workspaceId)).not.toHaveProperty("privateIp");
    expect(db.get(`WORKSPACE#${victim.workspaceId}`, `OPERATION#${victim.operationId}`)).toMatchObject({ status: "FAILED", error: COMPUTE_LOST_WORDS });
    expect(db.get(`WORKSPACE#${victim.workspaceId}`, "META")).toMatchObject({ status: "READY" });
    // The other workspace's READY session and running operation are untouched.
    expect(row(bystander.workspaceId)).toMatchObject({ state: "READY", instanceId: bystander.instanceId });
    expect(db.get(`WORKSPACE#${bystander.workspaceId}`, `OPERATION#${bystander.operationId}`)).toMatchObject({ status: "RUNNING" });
    // The reconciler's own metric, so the lost-instance alarm still fires for an instance this handler marked first.
    expect(emit).toHaveBeenCalledExactlyOnceWith({ ReconcilerLostInstances: 1, InstanceStateChangeLost: 1 });
    expect(lines).toEqual([{ event: "instance_state_change.marked_lost", workspaceId: victim.workspaceId, instanceId: victim.instanceId, state, failedOperationId: victim.operationId }]);
  });

  it("does nothing for an instance no READY session names, or whose session already moved on (a stop is STOPPING before the instance ends)", async () => {
    const { handler, seed, row, event, emit } = setup();
    const stopping = seed("STOPPING");
    const provisioning = seed("PROVISIONING");
    expect(await handler(event(`i-${hex()}`, "terminated"))).toBe("no_session");
    expect(await handler(event(stopping.instanceId, "terminated"))).toBe("no_session");
    expect(await handler(event(provisioning.instanceId, "terminated"))).toBe("no_session");
    expect(row(stopping.workspaceId)).toMatchObject({ state: "STOPPING", instanceId: stopping.instanceId });
    expect(emit).not.toHaveBeenCalled();
  });

  it("is idempotent: a repeated event for the same instance finds no READY session the second time", async () => {
    const { handler, seed, event, emit } = setup();
    const { instanceId } = seed("READY", { operation: true });
    expect(await handler(event(instanceId, "shutting-down"))).toBe("marked_lost");
    expect(await handler(event(instanceId, "terminated"))).toBe("no_session");
    expect(emit).toHaveBeenCalledOnce();
  });

  it("leaves a session alone, and fails nothing, when it moved on between the lookup and the mark", async () => {
    const { handler, seed, row, event, emit, db, sessions } = setup();
    const { workspaceId, instanceId, operationId } = seed("READY", { operation: true });
    const seen = (await sessions.get(workspaceId))!;
    // The lookup saw it READY; the stop claim lands before the conditional mark.
    vi.spyOn(sessions, "findReadyByInstance").mockImplementation(async () => {
      db.set({ ...row(workspaceId), state: "STOPPING", sessionState: "STOPPING" });
      return seen;
    });
    expect(await handler(event(instanceId, "terminated"))).toBe("already_moved");
    expect(row(workspaceId)).toMatchObject({ state: "STOPPING", instanceId });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ status: "RUNNING" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("is held to the rule's own shape: not an EC2 event, a state that does not end a worker, or a malformed instance id is ignored without a lookup", async () => {
    const { handler, seed, event, sessions, row } = setup();
    const { workspaceId, instanceId } = seed("READY");
    const lookup = vi.spyOn(sessions, "findReadyByInstance");
    for (const state of ["pending", "running", "stopped"]) expect(await handler(event(instanceId, state))).toBe("ignored");
    expect(await handler({ ...event(instanceId, "terminated"), source: "aws.s3" })).toBe("ignored");
    expect(await handler(event("not-an-instance", "terminated"))).toBe("ignored");
    expect(await handler(event(`${instanceId};drop`, "terminated"))).toBe("ignored");
    expect(await handler({ source: "aws.ec2" })).toBe("ignored");
    expect(await handler({ ...event(instanceId, "terminated"), detail: { "instance-id": 7, state: "terminated" } })).toBe("ignored");
    expect(lookup).not.toHaveBeenCalled();
    expect(row(workspaceId)).toMatchObject({ state: "READY" });
  });

  it("handles the FULL envelope EventBridge delivers for an EC2 Instance State-change Notification (version, id, account, time, region, resources, detail), as EC2 sends it", async () => {
    const { handler, seed, row, db } = setup();
    const victim = seed("READY", { operation: true });
    // The shape in AWS's documentation of the event; the handler is typed on the fields it reads, and must not depend on any other.
    const envelope = {
      version: "0", id: "7bf73129-1428-4cd3-a780-95db273d1602", "detail-type": "EC2 Instance State-change Notification", source: "aws.ec2", account: "111122223333",
      time: "2026-11-25T12:00:00Z", region: "us-east-1", resources: [`arn:aws:ec2:us-east-1:111122223333:instance/${victim.instanceId}`],
      detail: { "instance-id": victim.instanceId, state: "shutting-down" },
    };
    expect(await handler(envelope)).toBe("marked_lost");
    expect(row(victim.workspaceId)).toMatchObject({ state: "STOPPED" });
    expect(db.get(`WORKSPACE#${victim.workspaceId}`, `OPERATION#${victim.operationId}`)).toMatchObject({ status: "FAILED", error: COMPUTE_LOST_WORDS });
    // The event for the same instance's later state (EC2 sends shutting-down, then terminated) finds nothing left to do.
    expect(await handler({ ...envelope, id: "other", detail: { "instance-id": victim.instanceId, state: "terminated" } })).toBe("no_session");
  });

  it("finds the one READY session among many by a filtered read of the READY index, never touching another's", async () => {
    const { handler, seed, row, event } = setup();
    const others = Array.from({ length: 5 }, () => seed("READY"));
    const target = seed("READY");
    expect(await handler(event(target.instanceId, "terminated"))).toBe("marked_lost");
    expect(row(target.workspaceId)).toMatchObject({ state: "STOPPED" });
    for (const other of others) expect(row(other.workspaceId)).toMatchObject({ state: "READY", instanceId: other.instanceId });
  });

  it("ends a worker on exactly the three states the rule delivers", () => {
    expect([...ENDED_INSTANCE_STATES].sort()).toEqual(["shutting-down", "stopping", "terminated"]);
  });
});
