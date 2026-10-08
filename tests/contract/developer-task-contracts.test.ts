import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVELOPER_TASK_POLICY,
  DeveloperTaskPolicySchema,
  OperationSchema,
  ProjectDefinitionSchema,
  PullRequestRequestSchema,
  agentXError,
  developerTaskPolicy,
} from "../../packages/contracts/src/index.js";

const definition = {
  name: "payments",
  revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [],
  readiness: [],
  orchestratorInstructions: "Delegate work.",
};
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
  it("fills every default when the object is present but empty", () => {
    expect(DeveloperTaskPolicySchema.parse({})).toEqual({
      enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true,
    });
  });

  it("is optional on the definition, and part of the revision when given", () => {
    expect(ProjectDefinitionSchema.parse(definition)).not.toHaveProperty("developerTasks");
    const parsed = ProjectDefinitionSchema.parse({ ...definition, developerTasks: { share: "required", shareMode: { allowContinue: false } } });
    expect(parsed.developerTasks).toEqual({ enabled: true, share: "required", shareMode: { default: "view", allowContinue: false }, channelMembersMayUse: true });
  });

  it("refuses unknown keys and values", () => {
    expect(ProjectDefinitionSchema.safeParse({ ...definition, developerTasks: { enabled: "yes" } }).success).toBe(false);
    expect(ProjectDefinitionSchema.safeParse({ ...definition, developerTasks: { sharing: "on" } }).success).toBe(false);
    expect(ProjectDefinitionSchema.safeParse({ ...definition, developerTasks: { shareMode: { default: "edit" } } }).success).toBe(false);
  });

  it("reads the defaults for a definition without it", () => {
    expect(developerTaskPolicy(definition)).toEqual(DEFAULT_DEVELOPER_TASK_POLICY);
  });

  it("fails closed on a stored value it cannot read: tasks off, channel access off", () => {
    expect(developerTaskPolicy({ developerTasks: { enabled: 1 } })).toEqual({ ...DEFAULT_DEVELOPER_TASK_POLICY, enabled: false, channelMembersMayUse: false });
  });

  it("fails closed on a stored null: only a missing value takes the defaults", () => {
    expect(developerTaskPolicy({ developerTasks: null })).toEqual({ ...DEFAULT_DEVELOPER_TASK_POLICY, enabled: false, channelMembersMayUse: false });
    expect(developerTaskPolicy({ developerTasks: undefined })).toEqual(DEFAULT_DEVELOPER_TASK_POLICY);
  });
});

describe("the developer requester on operations (FR-022)", () => {
  it("accepts a Slack requester, as today", () => {
    expect(OperationSchema.parse({ ...operation, requestedBy: { teamId: "T0TEAM1", userId: "U0MAYA001" } }).requestedBy).toEqual({ teamId: "T0TEAM1", userId: "U0MAYA001" });
  });

  it("accepts a developer requester", () => {
    const requestedBy = { kind: "developer", developerId: "d".repeat(64), provider: "oidc" };
    expect(OperationSchema.parse({ ...operation, requestedBy }).requestedBy).toEqual(requestedBy);
  });

  it("accepts discard authorization only on a close operation", () => {
    expect(OperationSchema.parse({ ...operation, kind: "close", discardUnpublished: true }).discardUnpublished).toBe(true);
    expect(OperationSchema.safeParse({ ...operation, discardUnpublished: true }).success).toBe(false);
  });

  it("refuses a developer requester with a malformed ID or an extra field", () => {
    expect(OperationSchema.safeParse({ ...operation, requestedBy: { kind: "developer", developerId: "maya", provider: "slack" } }).success).toBe(false);
    expect(OperationSchema.safeParse({ ...operation, requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya" } }).success).toBe(false);
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
    ["PROJECT_NOT_FOUND", 404], ["PROJECT_ACCESS_DENIED", 403], ["PROJECT_TASKS_DISABLED", 403], ["TASK_NOT_FOUND", 404],
    ["TASK_BUSY", 409], ["CHANNEL_REQUIRED", 409], ["WORKSPACE_LIMIT", 409], ["SLACK_UNAVAILABLE", 503], ["CHANNEL_AMBIGUOUS", 409],
    ["CONFIRMATION_UNAVAILABLE", 409], ["CONFIRMATION_DECLINED", 409], ["CONFIRMATION_EXPIRED", 409], ["CHANGE_STALE", 409],
  ] as const)("%s answers HTTP %i", (code, status) => {
    expect(agentXError(code, "x").statusCode).toBe(status);
  });
});
