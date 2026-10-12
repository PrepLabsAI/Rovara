import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { guardTaskDispatch, resumeTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER = "a".repeat(64);
const OWNER_SLACK = "U0OWNER001";

function task(): DeveloperTaskRecord {
  return {
    pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID,
    developerId: OWNER, provider: "slack", developerName: "Avery", slackUserId: OWNER_SLACK,
    client: "slack", project: "payments", title: "Payments", workspaceId: WORKSPACE_ID,
    ownerKey: "f".repeat(64), conversationId: randomUUID(), startingRevision: 1,
    charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
    shared: true, share: { teamId: "T0PEOPLE1", channelId: "C0PEOPLE1", mode: "view", sharedReason: "requested", sharedAt: "2026-10-11T10:00:00.000Z" },
    createdAt: "2026-10-11T10:00:00.000Z", updatedAt: "2026-10-11T10:00:00.000Z",
    workflow: { revision: 7, stage: "IMPLEMENT", state: "RUNNING" } as never,
  };
}

function record(): Ec2OutboxRecord {
  const operationId = randomUUID();
  return {
    id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId: WORKSPACE_ID, deploymentMode: "ec2-ebs",
    invocation: { protocolVersion: 1, kind: "task", operationId, workspaceId: WORKSPACE_ID, fence: 4, projectRevision: 1,
      callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "continue", conversationStarted: true } },
  };
}

function harness(withPeople = true) {
  const db = new FakeDynamoDb();
  const current = task();
  const outbox = record();
  db.set(current as unknown as Record<string, unknown>);
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK_ID, developerId: OWNER });
  db.set({ pk: `OUTBOX#${outbox.id}`, sk: "OUTBOX", ...outbox });
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: `OPERATION#${outbox.operationId}`, status: "DISPATCHING", fence: 4 });
  db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "META", status: "BUSY", activeOperationId: outbox.operationId, fence: 4 });
  if (withPeople) db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 3, orphaned: false,
    people: [{ developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", role: "owner" }] });
  const checkTaskPerson = vi.fn(async () => ({
    subject: { developerId: OWNER, slackUserId: OWNER_SLACK },
    identity: { developerId: OWNER, slackUserId: OWNER_SLACK, name: "Avery", method: "slack" as const, issuer: "https://slack.com", subject: OWNER_SLACK },
    eligible: true, channelMember: true,
  }));
  return { db, current, outbox, checkTaskPerson };
}

describe("task dispatch access", () => {
  it("leaves legacy work without a PEOPLE sidecar unchanged", async () => {
    const h = harness(false);
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox)).resolves.toBe("ALLOWED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("keeps terminal cleanup independent when a PEOPLE task is ownerless", async () => {
    const h = harness();
    const cleanup = { ...h.outbox, invocation: { ...h.outbox.invocation, kind: "close", payload: {} } } as Ec2OutboxRecord;
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, cleanup)).resolves.toBe("ALLOWED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("retries instead of acknowledging when a task pointer cannot be verified", async () => {
    const h = harness();
    h.db.delete(`DEVTASK#${TASK_ID}`, "META");
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox)).rejects.toThrow(/could not be verified/);
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("allows a freshly qualified effective owner without storing an allow receipt", async () => {
    const h = harness();
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).resolves.toBe("ALLOWED");
    expect(h.checkTaskPerson).toHaveBeenCalledWith(h.current, OWNER);
    expect(h.db.find((item) => String(item.sk).includes("TASK_ACCESS"))).toEqual([]);
  });

  it("durably parks PEOPLE work when proof is unconfigured and preserves operation identity", async () => {
    const h = harness();
    await expect(guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox)).resolves.toBe("PARKED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS", operationId: h.outbox.operationId, invocation: h.outbox.invocation });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toMatchObject({ taskId: TASK_ID, peopleRevision: 3, reason: "PROOF_UNAVAILABLE" });
    expect(h.db.get(`DEVTASK#${TASK_ID}`, `TASK_ACCESS_PAUSE#${h.outbox.id}`)).toMatchObject({ operationId: h.outbox.operationId, workspaceId: WORKSPACE_ID });
  });

  it("parks ownerless work and a duplicate remains parked without another proof attempt", async () => {
    const h = harness();
    h.checkTaskPerson.mockResolvedValue({ ...(await h.checkTaskPerson()), eligible: false, channelMember: false });
    expect(await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).toBe("PARKED");
    h.checkTaskPerson.mockClear();
    expect(await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).toBe("PARKED");
    expect(h.checkTaskPerson).not.toHaveBeenCalled();
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")?.reason).toBe("OWNERLESS");
  });

  it("parks unknown proof without treating it as a departed owner", async () => {
    const h = harness();
    h.checkTaskPerson.mockRejectedValue(new Error("proof unavailable"));
    expect(await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox)).toBe("PARKED");
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")?.reason).toBe("PROOF_UNAVAILABLE");
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")?.orphaned).toBe(false);
  });

  it("uses stable effective owner actor IDs", async () => {
    const h = harness();
    await guardTaskDispatch({ documentClient: h.db, tableName: "state", checkTaskPerson: h.checkTaskPerson }, h.outbox);
    expect(taskOwnerKey(OWNER, TASK_ID)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redrives the exact parked invocation only after an explicit current-owner request", async () => {
    const h = harness();
    await guardTaskDispatch({ documentClient: h.db, tableName: "state" }, h.outbox);
    const original = structuredClone(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX"));
    const newOwner = "b".repeat(64);
    h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: false,
      people: [{ developerId: newOwner, slackUserId: "U0NEWOWNER1", name: "Bailey", role: "owner" }] });
    const requestId = randomUUID();
    const payloadHash = "d".repeat(64);

    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 4, actorId: taskOwnerKey(newOwner, TASK_ID), requestId, payloadHash,
    })).resolves.toBe(true);

    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "OUTBOX")).toMatchObject({
      status: "PENDING", operationId: original?.operationId, invocation: original?.invocation,
    });
    expect(h.db.get(`OUTBOX#${h.outbox.id}`, "TASK_ACCESS_PAUSE")).toBeUndefined();
    expect(h.db.get(`DEVTASK#${TASK_ID}`, `TASK_ACCESS_RETRY#${requestId}`)).toMatchObject({
      actorId: taskOwnerKey(newOwner, TASK_ID), operationId: h.outbox.operationId, payloadHash,
    });
    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 4, actorId: taskOwnerKey(newOwner, TASK_ID), requestId, payloadHash,
    })).resolves.toBe(true);
    await expect(resumeTaskDispatch({ documentClient: h.db, tableName: "state", now: () => Date.parse("2026-10-11T10:05:00.000Z") }, {
      task: h.current, peopleRevision: 4, actorId: taskOwnerKey(newOwner, TASK_ID), requestId, payloadHash: "e".repeat(64),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
