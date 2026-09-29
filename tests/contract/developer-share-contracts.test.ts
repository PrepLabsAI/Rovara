// tests/contract/developer-share-contracts.test.ts
// Spec 025 phase 25c, Task 1: the shapes sharing adds. Every addition is optional, so a record or
// answer written before 25c still parses.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  AdminShareModeRequestSchema,
  AgentXErrorCodeSchema,
  AiToolTurnRecordSchema,
  ChannelTurnSchema,
  CLOSED_SHARED_NOTICE,
  DEVELOPER_API_VERSION,
  DeveloperTaskViewSchema,
  SHARED_BY_POLICY,
  ShareDeveloperTaskRequestSchema,
  SharedTaskRecordSchema,
  SlackThreadPrepareResultSchema,
  SlackThreadWorkspaceResultSchema,
  SlackWorkspaceCloseStartResultSchema,
  TurnRecordSchema,
  VIEW_ONLY_BY_POLICY,
  VIEW_ONLY_NOTICE,
  agentXError,
  sharedNoticeClaim,
  sharedNoticeKey,
  sharedTaskKey,
} from "../../packages/contracts/src/index.js";
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

  it("builds the shared thread key on the Slack thread subject, so a malformed thread is refused", () => {
    expect(sharedTaskKey({ teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }).pk).toBe("SHARED_TASK#T0BSHLLUGBD/C0123456789/1695500000.000001");
    expect(() => sharedTaskKey({ teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "not-a-ts" })).toThrow();
    expect(() => sharedTaskKey({ teamId: "T0BSHLLUGBD/x", channelId: "C0123456789", threadTs: "1695500000.000001" })).toThrow();
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
  const claim = async (db: FakeDynamoDb, now: number, kind?: "view" | "closed") => {
    try {
      await db.send(new UpdateCommand({ TableName: "threads", ...sharedNoticeClaim(subject, now, kind) }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  };

  it("claims the thread's SHARED_NOTICE item, and keeps it two intervals", () => {
    expect(sharedNoticeClaim(subject, 1_000_000)).toEqual({
      Key: sharedNoticeKey(subject),
      UpdateExpression: "SET noticedAt = :now, expiresAt = :expires",
      ConditionExpression: "attribute_not_exists(noticedAt) OR noticedAt <= :cutoff",
      ExpressionAttributeValues: { ":now": 1_000_000, ":expires": 1_007_200, ":cutoff": 996_400 },
    });
  });

  it("lets one caller through per thread per 3,600 seconds", async () => {
    const db = new FakeDynamoDb();
    expect(await claim(db, 1_000_000)).toBe(true);
    expect(await claim(db, 1_000_000)).toBe(false);
    expect(await claim(db, 1_003_599)).toBe(false);
    expect(await claim(db, 1_003_600)).toBe(true);
    expect(db.get(`THREAD#${subject}`, "SHARED_NOTICE")).toMatchObject({ noticedAt: 1_003_600, expiresAt: 1_010_800 });
  });

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

describe("the Slack service's shapes (C11, C16)", () => {
  it("adds VIEW_ONLY and an optional sharedTask, and keeps the WORKSPACE branch strict", () => {
    expect(SlackThreadWorkspaceResultSchema.parse({ outcome: "VIEW_ONLY", taskId: TASK, closed: false })).toMatchObject({ outcome: "VIEW_ONLY" });
    const workspace = { outcome: "WORKSPACE", workspaceId: WORKSPACE, status: "BUSY", operationId: null, created: false, orchestratorInstructions: "Delegate work." };
    expect(SlackThreadWorkspaceResultSchema.parse({ ...workspace, sharedTask: { taskId: TASK, developerName: "Maya Chen" } })).toMatchObject({ sharedTask: { taskId: TASK } });
    expect(SlackThreadWorkspaceResultSchema.safeParse({ ...workspace, unexpected: true }).success).toBe(false);
  });

  it("adds an optional open task count to both limit answers, and REFUSED to the close answer", () => {
    const limit = { outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [] };
    expect(SlackThreadWorkspaceResultSchema.parse({ ...limit, openTaskCount: 3 })).toMatchObject({ openTaskCount: 3 });
    expect(SlackThreadPrepareResultSchema.parse({ ...limit, openTaskCount: 1 })).toMatchObject({ openTaskCount: 1 });
    expect(SlackThreadWorkspaceResultSchema.parse(limit)).not.toHaveProperty("openTaskCount");
    expect(SlackWorkspaceCloseStartResultSchema.parse({ outcome: "REFUSED", reason: "shared_task" })).toMatchObject({ outcome: "REFUSED" });
  });
});

describe("records and codes", () => {
  it("lets a Slack turn record carry the task and the teammate's name, and still reads one without", () => {
    const base = {
      offeredTools: [], calls: [], emptyResponse: false, workerOperations: [], eventId: "Ev0000000001", subject: "T0BSHLLUGBD/C0123456789/1695500000.000001",
      receivedAt: "2026-09-29T10:00:00.000Z", requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, disposition: "answered",
      startedAt: "2026-09-29T10:00:00.000Z", finishedAt: "2026-09-29T10:00:01.000Z", durationMs: 1000, requestText: "run the linter", responseText: "done",
    };
    expect(TurnRecordSchema.parse({ ...base, taskId: TASK, requesterName: "Priya" })).toMatchObject({ taskId: TASK, requesterName: "Priya" });
    expect(TurnRecordSchema.parse(base)).not.toHaveProperty("taskId");
  });

  it("adds the share action to AI-tool records (Q9), and names an admin who made the change (C25)", () => {
    expect(AiToolTurnRecordSchema.shape.action.options).toEqual(["start", "continue", "pull_request", "cancel", "close", "share"]);
    expect(AiToolTurnRecordSchema.shape.admin.parse({ issuer: "https://identity.example.test", subject: "admin-subject", displayName: "Ada" })).toMatchObject({ subject: "admin-subject" });
    expect(AiToolTurnRecordSchema.shape.admin.safeParse(undefined).success).toBe(true);
  });

  it("takes an admin's mode switch with only a request ID and a mode (C25)", () => {
    expect(AdminShareModeRequestSchema.parse({ requestId: TASK, shareMode: "view" })).toEqual({ requestId: TASK, shareMode: "view" });
    expect(AdminShareModeRequestSchema.safeParse({ requestId: TASK, shareMode: "view", channel: "C0123456789" }).success).toBe(false);
    expect(AdminShareModeRequestSchema.safeParse({ requestId: TASK }).success).toBe(false);
  });

  it("adds CHANNEL_AMBIGUOUS as a 409, and moves the API to 1.2 (Q7)", () => {
    // errorStatus answers 409 for any code it does not list, so pin the code's membership too.
    expect(AgentXErrorCodeSchema.options).toContain("CHANNEL_AMBIGUOUS");
    expect(agentXError("CHANNEL_AMBIGUOUS", "name one").statusCode).toBe(409);
    expect(DEVELOPER_API_VERSION).toBe("1.2");
  });
});
