import { beforeAll, describe, expect, it, vi } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { chargeConflict, chargeItems, developerCharge, limitReached, readWorkspaceLimits, releaseConflict, releaseItems } from "../../packages/broker/src/developer/limits.js";
import { SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

const fallback = { member: 3, organization: 20 };
const thread = (n: number) => `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.00000${n}`;

beforeAll(async () => {
  await loadSlackBroker();
});

describe("readWorkspaceLimits (FR-053, R7)", () => {
  it("uses the stack parameters when no admin has set the limits", async () => {
    expect(await readWorkspaceLimits(new FakeDynamoDb(), "state", fallback)).toEqual({ member: 3, organization: 20, source: "parameters" });
  });

  it("uses the setting with a consistent read when it is set", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 5, perOrganization: 40, updatedBy: "admin", updatedAt: "2026-09-27T00:00:00.000Z" });
    const send = vi.spyOn(db, "send");
    expect(await readWorkspaceLimits(db, "state", fallback)).toEqual({ member: 5, organization: 40, source: "setting" });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Key: { pk: "SETTINGS", sk: "WORKSPACE_LIMITS" }, ConsistentRead: true });
  });

  it.each([
    [{ perPerson: 0, perOrganization: 20 }],
    [{ perPerson: 51, perOrganization: 100 }],
    [{ perPerson: 5, perOrganization: 4 }],
    [{ perPerson: "5", perOrganization: 20 }],
    [{ perOrganization: 20 }],
    [{ perPerson: -1, perOrganization: 20 }],
    [{ perPerson: 2.5, perOrganization: 20 }],
    [{ perPerson: 5, perOrganization: 1001 }],
  ])("falls back to the parameters, and logs it, for a setting it cannot use: %j", async (fields) => {
    const db = new FakeDynamoDb();
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", ...fields });
    const log = vi.fn();
    expect(await readWorkspaceLimits(db, "state", fallback, log)).toEqual({ ...fallback, source: "parameters" });
    expect(log).toHaveBeenCalledWith({ event: "workspace_limits.invalid_setting" });
  });
});

describe("developer counters (FR-020, R6)", () => {
  const developerId = "d".repeat(64);

  it("shares the linked Slack member's counter and the Slack organization counter", () => {
    expect(developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId })).toEqual({
      member: { pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "MEMBER#U0MAYA001" },
      organization: { pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "ORGANIZATION" },
    });
  });

  it("gives an unlinked developer their own counter, and uses the developer organization counter without a team", () => {
    expect(developerCharge({ teamId: SLACK_TEAM, developerId }).member).toEqual({ pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER" });
    expect(developerCharge({ developerId }).organization).toEqual({ pk: "DEVELOPER_LIMIT#ORGANIZATION", sk: "ORGANIZATION" });
  });

  it("charges and releases one slot on each counter, and records the task in a set, never in threads", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "MEMBER#U0MAYA001", entityType: "SLACK_LIMIT", count: 1, threads: [thread(1)] });
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-1") } });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).toMatchObject({ count: 2, threads: [thread(1)], tasks: new Set(["task-1"]) });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: releaseItems("state", charge, "task-1") } });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).toMatchObject({ count: 1, threads: [thread(1)] });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).not.toHaveProperty("tasks");
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 0 });
  });

  it("refuses a charge at the limit, and says which counter is full", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "MEMBER#U0MAYA001", count: 3 });
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    await expect(db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-2") } })).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(await limitReached(db, "state", charge, fallback)).toBe("member");
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "MEMBER#U0MAYA001", count: 0 });
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "ORGANIZATION", count: 20 });
    expect(await limitReached(db, "state", charge, fallback)).toBe("organization");
  });

  it("a second charge of the same taskId doesn't bump the count", async () => {
    const db = new FakeDynamoDb();
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-3") } });
    await expect(db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-3") } })).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).toMatchObject({ count: 1, tasks: new Set(["task-3"]) });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
  });

  it("a second release of the same taskId leaves count and tasks unchanged", async () => {
    const db = new FakeDynamoDb();
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-5") } });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: releaseItems("state", charge, "task-5") } });
    await expect(db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: releaseItems("state", charge, "task-5") } })).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).toMatchObject({ count: 0 });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).not.toHaveProperty("tasks");
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 0 });
  });

  it("chargeConflict tells a repeat charge apart from a full counter", async () => {
    const db = new FakeDynamoDb();
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-4") } });
    const repeat = await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-4") } }).catch((error: unknown) => error);
    expect(await chargeConflict(db, "state", charge, "task-4", repeat)).toBe("already_charged");
  });

  it("chargeConflict reports the member limit for a different task once the member is full", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "MEMBER#U0MAYA001", count: 3, tasks: new Set(["task-a"]) });
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    const full = await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-b") } }).catch((error: unknown) => error);
    expect(await chargeConflict(db, "state", charge, "task-b", full)).toBe("member");
  });

  it("chargeConflict reports the organization limit", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "ORGANIZATION", count: 20 });
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    const full = await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-c") } }).catch((error: unknown) => error);
    expect(await chargeConflict(db, "state", charge, "task-c", full)).toBe("organization");
  });

  it("chargeConflict reports a repeat charge even when the organization has since reached its limit", async () => {
    const db = new FakeDynamoDb();
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-x") } });
    // Other members have since driven the organization counter to its limit.
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "ORGANIZATION", count: 20 });
    const repeat = await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-x") } }).catch((error: unknown) => error);
    expect(await chargeConflict(db, "state", charge, "task-x", repeat)).toBe("already_charged");
  });

  it("chargeConflict still reports the organization limit for a genuine new task, not a repeat", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "ORGANIZATION", count: 20 });
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    const full = await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-y") } }).catch((error: unknown) => error);
    expect(await chargeConflict(db, "state", charge, "task-y", full)).toBe("organization");
  });

  it("a second release of one task does not touch a sibling task's slot", async () => {
    const db = new FakeDynamoDb();
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-7") } });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-8") } });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: releaseItems("state", charge, "task-7") } });
    await expect(db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: releaseItems("state", charge, "task-7") } })).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).toMatchObject({ count: 1, tasks: new Set(["task-8"]) });
  });

  it("releaseConflict recognizes a repeat release", async () => {
    const db = new FakeDynamoDb();
    const charge = developerCharge({ teamId: SLACK_TEAM, slackUserId: "U0MAYA001", developerId });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: chargeItems("state", charge, fallback, "task-6") } });
    await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: releaseItems("state", charge, "task-6") } });
    const repeat = await db.send({ constructor: { name: "TransactWriteCommand" }, input: { TransactItems: releaseItems("state", charge, "task-6") } }).catch((error: unknown) => error);
    expect(await releaseConflict(db, "state", charge, "task-6", repeat)).toBe("already_released");
  });
});

describe("Slack threads read the setting too (R7)", () => {
  it("uses the setting's per-person limit at workspace creation", async () => {
    const { db, handler } = createBroker({ memberLimit: 3 });
    await registerSlackProject(handler);
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 1, perOrganization: 20 });
    expect((await ensureWorkspace(handler, thread(1), "U0PRATIK01")).body.created).toBe(true);
    expect((await ensureWorkspace(handler, thread(2), "U0PRATIK01")).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1 });
  });

  it("keeps existing workspaces when the limit is lowered below the count, and refuses new ones", async () => {
    const { db, handler } = createBroker({ memberLimit: 3 });
    await registerSlackProject(handler);
    expect((await ensureWorkspace(handler, thread(1), "U0PRATIK01")).body.created).toBe(true);
    expect((await ensureWorkspace(handler, thread(2), "U0PRATIK01")).body.created).toBe(true);
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 1, perOrganization: 20 });
    expect((await ensureWorkspace(handler, thread(1), "U0PRATIK01")).body).toMatchObject({ outcome: "WORKSPACE", created: false });
    expect((await ensureWorkspace(handler, thread(3), "U0PRATIK01")).body).toMatchObject({ outcome: "LIMIT_REACHED", maximum: 1 });
  });

  it("refuses a Slack thread at the stack-parameter limit when the setting is malformed", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 0, perOrganization: 20 });
    expect((await ensureWorkspace(handler, thread(1), "U0PRATIK01")).body.created).toBe(true);
    expect((await ensureWorkspace(handler, thread(2), "U0PRATIK01")).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1 });
  });

  it("does not read the setting for a thread that already has a workspace", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await ensureWorkspace(handler, thread(1), "U0PRATIK01");
    const send = vi.spyOn(db, "send");
    await ensureWorkspace(handler, thread(1), "U0PRATIK01");
    expect(send.mock.calls.some(([command]) => (command.input.Key as { pk?: string } | undefined)?.pk === "SETTINGS")).toBe(false);
  });
});
