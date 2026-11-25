// tests/contract/developer-share-contracts.test.ts
// Spec 025 phase 25c, Task 1: the shapes sharing adds. Every addition is optional, so a record or
// answer written before 25c still parses.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { AdminShareModeRequestSchema, AgentXErrorCodeSchema, ChannelTurnSchema, CLOSED_SHARED_NOTICE, DEVELOPER_API_VERSION, DeveloperTaskViewSchema, SHARED_BY_POLICY, ShareDeveloperTaskRequestSchema, SharedTaskRecordSchema, VIEW_ONLY_BY_POLICY, VIEW_ONLY_NOTICE, agentXError, sharedNoticeClaim, sharedNoticeKey, sharedTaskKey } from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const view = {
  taskId: TASK, title: "Fix the flaky retry test", project: "payments", status: "RUNNING", startingRevision: 1, client: "Claude Code",
  shared: true, createdAt: "2026-09-29T10:00:00.000Z", updatedAt: "2026-09-29T10:00:00.000Z", events: [],
};

describe("share shapes (C1, C2, C6)", () => {
  it("reads a shared view with its thread link, and a 25b view without any share field", () => {
    const shared = DeveloperTaskViewSchema.parse({
      ...view,
      share: { mode: "view", channelId: "C0123456789", channelName: "payments-dev", sharedReason: "required", threadUrl: "https://slack.com/archives/C0123456789/p1695500000000001" },
      channelTurns: [{ author: { slackUserId: "U0PRIYA001", name: "Priya" }, at: "2026-09-29T10:05:00.000Z", request: "also run the linter", outcome: "answered" }],
    });
    expect(shared.share).toMatchObject({ mode: "view", sharedReason: "required" });
    expect(DeveloperTaskViewSchema.parse({ ...view, shared: false }).share).toBeUndefined();
  });

  it("takes a share request with an optional mode and channel, and nothing else", () => {
    expect(ShareDeveloperTaskRequestSchema.parse({ requestId: TASK, shareMode: "continue", channel: "#payments-dev" })).toMatchObject({ shareMode: "continue" });
    expect(ShareDeveloperTaskRequestSchema.safeParse({ requestId: TASK, force: true }).success).toBe(false);
    expect(ShareDeveloperTaskRequestSchema.safeParse({ requestId: TASK, shareMode: "edit" }).success).toBe(false);
  });

  it("keys the shared thread record by team, channel and thread, and parses it with its storage keys", () => {
    const key = sharedTaskKey({ teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" });
    expect(key).toEqual({ pk: "SHARED_TASK#T0BSHLLUGBD/C0123456789/1695500000.000001", sk: "META" });
    const record = SharedTaskRecordSchema.parse({
      ...key, entityType: "SHARED_TASK", taskId: TASK, workspaceId: WORKSPACE, ownerKey: "a".repeat(64), developerId: "d".repeat(64),
      developerName: "Maya Chen", project: "payments", mode: "continue", sharedAt: "2026-09-29T10:00:00.000Z",
    });
    expect(record).toMatchObject({ mode: "continue" });
    expect(sharedNoticeKey("T0BSHLLUGBD/C0123456789/1695500000.000001")).toEqual({ pk: "THREAD#T0BSHLLUGBD/C0123456789/1695500000.000001", sk: "SHARED_NOTICE" });
  });

  it("refuses a malformed time on a channel turn and a shared thread record", () => {
    const turn = { author: { slackUserId: "U0PRIYA001" }, at: "2026-09-29T10:05:00.000Z", request: "run the linter", outcome: "answered" };
    expect(ChannelTurnSchema.safeParse(turn).success).toBe(true);
    expect(ChannelTurnSchema.safeParse({ ...turn, at: "yesterday" }).success).toBe(false);
    const record = {
      taskId: TASK, workspaceId: WORKSPACE, ownerKey: "a".repeat(64), developerId: "d".repeat(64),
      developerName: "Maya Chen", project: "payments", mode: "view", sharedAt: "2026-09-29T10:00:00.000Z",
    };
    expect(SharedTaskRecordSchema.safeParse({ ...record, closedAt: "2026-09-29T11:00:00.000Z" }).success).toBe(true);
    expect(SharedTaskRecordSchema.safeParse({ ...record, sharedAt: "29 Sep 2026" }).success).toBe(false);
    expect(SharedTaskRecordSchema.safeParse({ ...record, closedAt: "later" }).success).toBe(false);
  });

  it("uses the spec's exact reasons, and notices with no em dash", () => {
    expect([SHARED_BY_POLICY, VIEW_ONLY_BY_POLICY]).toEqual(["required by project", "continue not allowed by project"]);
    for (const text of [VIEW_ONLY_NOTICE, CLOSED_SHARED_NOTICE]) {
      expect(text).not.toContain("\u2014");
      expect(text).toContain("new message in the channel");
    }
  });
});

describe("the shared thread's hourly notice claim (C10, F13)", () => {
  const subject = "T0BSHLLUGBD/C0123456789/1695500000.000001";
  const claim = async (db: FakeDynamoDb, now: number, kind: "view" | "closed" = "view") => {
    try {
      await db.send(new UpdateCommand({ TableName: "threads", ...sharedNoticeClaim(subject, now, kind) }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  };

  it("claims the closed notice apart from the view-only one, on the same item (live check)", async () => {
    expect(sharedNoticeClaim(subject, 1_000_000, "closed")).toEqual({
      Key: sharedNoticeKey(subject),
      UpdateExpression: "SET closedNoticedAt = :now, expiresAt = :expires",
      ConditionExpression: "attribute_not_exists(closedNoticedAt) OR closedNoticedAt <= :cutoff",
      ExpressionAttributeValues: { ":now": 1_000_000, ":expires": 1_007_200, ":cutoff": 996_400 },
    });
    const db = new FakeDynamoDb();
    // A marker written before this change holds only noticedAt: it blocks the view-only notice, not the closed one.
    expect(await claim(db, 1_000_000)).toBe(true);
    expect(await claim(db, 1_001_080, "closed")).toBe(true);
    expect(await claim(db, 1_002_000, "closed")).toBe(false);
    expect(await claim(db, 1_002_000, "view")).toBe(false);
    expect(await claim(db, 1_004_680, "closed")).toBe(true);
    expect(db.get(`THREAD#${subject}`, "SHARED_NOTICE")).toMatchObject({ noticedAt: 1_000_000, closedNoticedAt: 1_004_680, expiresAt: 1_011_880 });
  });

});

describe("records and codes", () => {

  it("takes an admin's mode switch with only a request ID and a mode (C25)", () => {
    expect(AdminShareModeRequestSchema.parse({ requestId: TASK, shareMode: "view" })).toEqual({ requestId: TASK, shareMode: "view" });
    expect(AdminShareModeRequestSchema.safeParse({ requestId: TASK, shareMode: "view", channel: "C0123456789" }).success).toBe(false);
    expect(AdminShareModeRequestSchema.safeParse({ requestId: TASK }).success).toBe(false);
  });

  it("adds CHANNEL_AMBIGUOUS as a 409, and moves the API to 1.2 (Q7)", () => {
    // errorStatus answers 409 for any code it does not list, so pin the code's membership too.
    expect(AgentXErrorCodeSchema.options).toContain("CHANNEL_AMBIGUOUS");
    expect(agentXError("CHANNEL_AMBIGUOUS", "name one").statusCode).toBe(409);
    expect(DEVELOPER_API_VERSION).toBe("1.3");
  });
});
