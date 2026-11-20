import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOPER_TASK_POLICY, OperationSchema, PullRequestRequestSchema, agentXError, developerTaskPolicy } from "../../packages/contracts/src/index.js";

const operation = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  kind: "task",
  requestId: "33333333-3333-4333-8333-333333333333",
  payloadHash: "a".repeat(64),
  status: "ACCEPTED",
  fence: 2,
  createdAt: "2026-09-27T12:00:00.000Z",
  updatedAt: "2026-09-27T12:00:00.000Z",
};

describe("developerTasks project policy (FR-014)", () => {

  it("fails closed on a stored null: only a missing value takes the defaults", () => {
    expect(developerTaskPolicy({ developerTasks: null })).toEqual({ ...DEFAULT_DEVELOPER_TASK_POLICY, enabled: false, channelMembersMayUse: false });
    expect(developerTaskPolicy({ developerTasks: undefined })).toEqual(DEFAULT_DEVELOPER_TASK_POLICY);
  });
});

describe("the developer requester on operations (FR-022)", () => {

  it("accepts discard authorization only on a close operation", () => {
    expect(OperationSchema.parse({ ...operation, kind: "close", discardUnpublished: true }).discardUnpublished).toBe(true);
    expect(OperationSchema.safeParse({ ...operation, discardUnpublished: true }).success).toBe(false);
  });

});

describe("draft pull requests (R14)", () => {
  it("accepts draft, and leaves it out when not given", () => {
    const base = { requestId: operation.requestId, repository: "demo", title: "Fix the retry test" };
    expect(PullRequestRequestSchema.parse({ ...base, draft: true }).draft).toBe(true);
    expect(PullRequestRequestSchema.parse(base)).not.toHaveProperty("draft");
  });
});

describe("developer error codes (FR-049)", () => {
  it.each([
    ["PROJECT_NOT_FOUND", 404], ["PROJECT_ACCESS_DENIED", 403],
  ] as const)("%s answers HTTP %i", (code, status) => {
    expect(agentXError(code, "x").statusCode).toBe(status);
  });
});
