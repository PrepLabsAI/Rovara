import { beforeAll, describe, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { chargeConflict, chargeItems, developerCharge, limitReached } from "../../packages/broker/src/developer/limits.js";
import { SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, loadSlackBroker, registerSlackProject } from "../support/slack-broker.js";

const fallback = { member: 3, organization: 20 };
const thread = (n: number) => `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.00000${n}`;

beforeAll(async () => {
  await loadSlackBroker();
});

describe("developer counters (FR-020, R6)", () => {
  const developerId = "d".repeat(64);

  it("gives an unlinked developer their own counter, and uses the developer organization counter without a team", () => {
    expect(developerCharge({ teamId: SLACK_TEAM, developerId }).member).toEqual({ pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER" });
    expect(developerCharge({ developerId }).organization).toEqual({ pk: "DEVELOPER_LIMIT#ORGANIZATION", sk: "ORGANIZATION" });
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

});

describe("Slack threads read the setting too (R7)", () => {

  it("refuses a Slack thread at the stack-parameter limit when the setting is malformed", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", perPerson: 0, perOrganization: 20 });
    expect((await ensureWorkspace(handler, thread(1), "U0PRATIK01")).body.created).toBe(true);
    expect((await ensureWorkspace(handler, thread(2), "U0PRATIK01")).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1 });
  });

});
