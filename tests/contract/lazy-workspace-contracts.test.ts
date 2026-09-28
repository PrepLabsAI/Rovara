import { describe, expect, it } from "vitest";
import { SlackThreadPrepareResultSchema, SlackThreadWorkspaceResultSchema } from "../../packages/contracts/src/slack.js";
import { WorkspaceInstanceSchema, WorkspaceStatusSchema } from "../../packages/contracts/src/workspace.js";

const PRE_LAZY_STATUSES = ["PREPARING", "READY", "PREPARATION_FAILED", "BUSY", "UNHEALTHY", "STOPPED", "RESUMING", "CLOSING", "CLOSED"];
const workspaceId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };

describe("a workspace with no compute", () => {
  it("appends UNPREPARED after every status older components know", () => {
    expect(WorkspaceStatusSchema.options).toEqual([...PRE_LAZY_STATUSES, "UNPREPARED"]);
  });

  it("stores a thread workspace record before its compute exists", () => {
    const record = WorkspaceInstanceSchema.parse({
      deploymentMode: "ec2-ebs" as const,
      id: workspaceId,
      ownerKey: "o".repeat(64),
      projectName: "payments",
      projectRevision: 1,
      rootPath: "/mnt/workspace",
      status: "UNPREPARED",
      fence: 0,
      createdAt: "2026-09-25T10:00:00.000Z",
      updatedAt: "2026-09-25T10:00:00.000Z",
    });
    expect(record).toMatchObject({ status: "UNPREPARED", fence: 0, activeOperationId: null });
  });

  it("lets a thread workspace result say the thread has no compute yet", () => {
    expect(SlackThreadWorkspaceResultSchema.parse({
      outcome: "WORKSPACE", workspaceId, status: "UNPREPARED", operationId: null, created: true, orchestratorInstructions: "Delegate work.",
    })).toMatchObject({ status: "UNPREPARED" });
  });
});

describe("the thread workspace preparation result", () => {
  it("parses a started, a raced, a refused and a closed preparation", () => {
    expect(SlackThreadPrepareResultSchema.parse({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId, created: true }))
      .toEqual({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId, created: true });
    expect(SlackThreadPrepareResultSchema.parse({ outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false }))
      .toMatchObject({ status: "READY", operationId: null });
    expect(SlackThreadPrepareResultSchema.parse({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [thread] }))
      .toMatchObject({ outcome: "LIMIT_REACHED", starterThreads: [thread] });
    expect(SlackThreadPrepareResultSchema.parse({ outcome: "CLOSED", workspaceId, closedAt: "2026-09-25T10:00:00.000Z" }))
      .toMatchObject({ outcome: "CLOSED" });
  });

  it("refuses fields outside the contract", () => {
    expect(SlackThreadPrepareResultSchema.safeParse({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId, created: true, orchestratorInstructions: "x" }).success).toBe(false);
    expect(SlackThreadPrepareResultSchema.safeParse({ outcome: "WORKSPACE", workspaceId, status: "WARMING", operationId, created: true }).success).toBe(false);
  });
});
