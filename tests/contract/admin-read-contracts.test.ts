// tests/contract/admin-read-contracts.test.ts
// Spec 025 phase 25d, Task 1: the admin read shapes (FR-038) and the derived index records (A5).
import { describe, expect, it } from "vitest";
import {
  ADMIN_API_VERSION,
  ADMIN_INDEX_RETENTION_DAYS,
  ADMIN_LIST_MAX,
  ADMIN_USAGE_READ_MAX,
  AdminBindingsResponseSchema,
  AdminFailuresResponseSchema,
  AdminHealthResponseSchema,
  AdminMeResponseSchema,
  AdminProjectsResponseSchema,
  AdminRequesterSchema,
  AdminUsageGroupBySchema,
  AdminUsageResponseSchema,
  AdminWorkspacesResponseSchema,
  DEVELOPER_API_VERSION,
  FailureIndexRecordSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  SlackAuthCheckRequestSchema,
  SlackUserByEmailRequestSchema,
  UsageIndexRecordSchema,
  failureIndexKey,
  indexDay,
  indexExpiresAt,
  projectCatalogKey,
  usageIndexKey,
} from "../../packages/contracts/src/index.js";

const OPERATION = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const ENDED = "2026-09-30T08:15:00.000Z";

describe("the index keys (FR-038, A5)", () => {
  it("keys a failure by its day and end time, as FR-038 names it", () => {
    expect(failureIndexKey(ENDED, OPERATION)).toEqual({ pk: "FAILURE#2026-09-30", sk: `${ENDED}#${OPERATION}` });
    expect(usageIndexKey(ENDED, OPERATION)).toEqual({ pk: "USAGE#2026-09-30", sk: `${ENDED}#${OPERATION}` });
    expect(indexDay("2026-09-30T23:59:59.999Z")).toBe("2026-09-30");
    expect(projectCatalogKey("payments")).toEqual({ pk: "PROJECT_CATALOG", sk: "PROJECT#payments" });
  });

  it("refuses an index key for a time that is not an ISO instant", () => {
    expect(() => failureIndexKey("yesterday", OPERATION)).toThrow("an ISO time");
  });

  it("gives each index item its TTL attribute, 30 days on (A6, Q5)", () => {
    expect(INDEX_EXPIRY_ATTRIBUTE).toBe("indexExpiresAt");
    expect(indexExpiresAt(ENDED)).toBe(Math.floor(Date.parse(ENDED) / 1000) + 30 * 86_400);
  });
});

describe("the index records (A5)", () => {
  const failure = {
    operationId: OPERATION, workspaceId: WORKSPACE, project: "payments", origin: "ai_tool",
    requester: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya Chen" },
    kind: "prepare", status: "FAILED", category: "setup_failed", error: "npm ci exited 1", endedAt: ENDED,
    taskId: "33333333-3333-4333-8333-333333333333",
  };

  it("reads a failure with each requester kind, and refuses an unknown category", () => {
    expect(FailureIndexRecordSchema.parse(failure)).toMatchObject({ origin: "ai_tool", category: "setup_failed" });
    expect(AdminRequesterSchema.parse({ kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" })).toMatchObject({ kind: "slack" });
    expect(AdminRequesterSchema.parse({ kind: "none" })).toEqual({ kind: "none" });
    expect(FailureIndexRecordSchema.safeParse({ ...failure, category: "cosmic_rays" }).success).toBe(false);
    expect(FailureIndexRecordSchema.safeParse({ ...failure, error: "x".repeat(1_001) }).success).toBe(false);
  });

  it("reads a usage item whose cost is unknown", () => {
    const usage = { ...failure, at: ENDED, durationMs: 90_000, inputTokens: 1_200, outputTokens: 300, costUsd: null };
    for (const key of ["kind", "status", "category", "error", "endedAt"]) delete (usage as Record<string, unknown>)[key];
    expect(UsageIndexRecordSchema.parse(usage)).toMatchObject({ costUsd: null, durationMs: 90_000 });
  });
});

describe("the wire shapes", () => {
  it("adds the admin API version beside the developer one, which stays 1.2 (A1)", () => {
    expect(ADMIN_API_VERSION).toBe("1.0");
    expect(DEVELOPER_API_VERSION).toBe("1.2");
    expect(ADMIN_INDEX_RETENTION_DAYS).toBe(30);
  });

  it("groups usage only four ways (FR-030)", () => {
    expect(AdminUsageGroupBySchema.options).toEqual(["project", "requester", "origin", "day"]);
  });

  it("reads a workspace list and a health answer, and keeps fields a newer control plane adds", () => {
    const workspaces = AdminWorkspacesResponseSchema.parse({
      workspaces: [{ id: WORKSPACE, project: "payments", origin: "slack", owner: { threadUrl: "https://slack.com/archives/C0123456789/p1695500000000100" }, status: "READY", busy: false, lastActivityAt: ENDED }],
      limits: { perPerson: 3, perOrganization: 20, source: "parameters" }, counts: { organization: 1 }, truncated: false, extra: "kept",
    });
    expect(workspaces).toMatchObject({ extra: "kept" });
    const health = AdminHealthResponseSchema.parse({
      version: { developerApi: "1.2", adminApi: "1.0" },
      alarms: [{ name: "agentx-live25d-SlackDeadLetters", state: "OK" }], alarmsCheck: { status: "ok" },
      deadLetterQueues: [{ name: "dispatch", depth: 0 }], slack: { status: "unknown", detail: "not set up" }, github: { status: "ok", detail: "installed on 1 account" },
      workerModes: [{ mode: "ec2-ebs", configured: true }], workspaces: { READY: 2 }, workspacesTruncated: false,
    });
    expect(health.slack).toEqual({ status: "unknown", detail: "not set up" });
  });

  it("says why an admin has no Slack link", () => {
    expect(AdminMeResponseSchema.parse({ issuer: "https://identity.example.test", subject: "admin-subject", slack: { linked: false, reason: "no_email" } }).slack.reason).toBe("no_email");
    expect(AdminMeResponseSchema.safeParse({ issuer: "i", subject: "s", slack: { linked: false, reason: "because" } }).success).toBe(false);
  });
});

describe("DeveloperIdentity's new invoke requests (A11 to A13)", () => {
  it("takes an email lookup and an auth check, and nothing else", () => {
    expect(SlackUserByEmailRequestSchema.parse({ kind: "slack-user-by-email", email: "ada@example.com" })).toMatchObject({ email: "ada@example.com" });
    expect(SlackUserByEmailRequestSchema.safeParse({ kind: "slack-user-by-email", email: "not an email" }).success).toBe(false);
    expect(SlackAuthCheckRequestSchema.parse({ kind: "slack-auth-check" })).toEqual({ kind: "slack-auth-check" });
    expect(SlackAuthCheckRequestSchema.safeParse({ kind: "slack-auth-check", token: "xoxb-1" }).success).toBe(false);
  });
});

// Task 1 fix round 1: review findings (Important 1, Minors 1, 2 and 5).
const FAILURE = {
  operationId: OPERATION, workspaceId: WORKSPACE, project: "payments", origin: "ai_tool",
  requester: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya Chen" },
  kind: "prepare", status: "FAILED", category: "setup_failed", error: "npm ci exited 1", endedAt: ENDED,
};
const PROJECT = {
  name: "payments", latestRevision: 3, registeredAt: ENDED,
  repositories: [{ name: "api", url: "https://github.com/example/api" }], runtimeMode: "ec2-ebs",
  connectors: [{ name: "github", type: "github" }],
  developerTasks: { enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true },
};

describe("the wire answers read fields a newer control plane adds at any depth (Important 1)", () => {
  it("reads a project whose task policy has a new field, also inside shareMode", () => {
    const answer = AdminProjectsResponseSchema.parse({
      projects: [{ ...PROJECT, developerTasks: { ...PROJECT.developerTasks, newPolicyField: 1, shareMode: { default: "view", allowContinue: true, newShareField: true } } }],
    });
    expect(answer.projects[0]?.developerTasks).toMatchObject({ enabled: true });
  });

  it("reads a failure whose requester has a new field, while the stored record stays strict", () => {
    const withNewRequesterField = { ...FAILURE, requester: { ...FAILURE.requester, team: "platform" } };
    const answer = AdminFailuresResponseSchema.parse({ failures: [withNewRequesterField], since: ENDED, until: ENDED });
    expect(answer.failures[0]?.requester).toMatchObject({ kind: "developer" });
    expect(AdminFailuresResponseSchema.parse({ failures: [{ ...FAILURE, requester: { kind: "none", why: "admin" } }], since: ENDED, until: ENDED }).failures).toHaveLength(1);
    expect(FailureIndexRecordSchema.safeParse(withNewRequesterField).success).toBe(false);
    expect(AdminRequesterSchema.safeParse({ kind: "none", why: "admin" }).success).toBe(false);
  });

  it("keeps closed enums closed on the wire", () => {
    expect(AdminFailuresResponseSchema.safeParse({ failures: [{ ...FAILURE, category: "cosmic_rays" }], since: ENDED, until: ENDED }).success).toBe(false);
    expect(AdminFailuresResponseSchema.safeParse({ failures: [{ ...FAILURE, requester: { kind: "robot" } }], since: ENDED, until: ENDED }).success).toBe(false);
  });

  it("keeps an extra top-level field on every admin answer (Minor 5)", () => {
    const answers: Array<[{ parse: (value: unknown) => unknown }, Record<string, unknown>]> = [
      [AdminProjectsResponseSchema, { projects: [PROJECT] }],
      [AdminBindingsResponseSchema, { bindings: [{ teamId: "T0BSHLLUGBD", channelId: "C0123456789", projectName: "payments", updatedAt: ENDED }], notices: [] }],
      [AdminFailuresResponseSchema, { failures: [FAILURE], since: ENDED, until: ENDED }],
      [AdminUsageResponseSchema, { groupBy: "day", since: ENDED, until: ENDED, groups: [], truncated: false }],
      [AdminWorkspacesResponseSchema, { workspaces: [], limits: { perPerson: 3, perOrganization: 20, source: "setting" }, counts: { organization: 0 }, truncated: false }],
      [AdminHealthResponseSchema, { version: { developerApi: "1.2", adminApi: "1.0" }, alarms: [], alarmsCheck: { status: "ok" }, deadLetterQueues: [], slack: { status: "ok" }, github: { status: "ok" }, workerModes: [], workspaces: {}, workspacesTruncated: false }],
      [AdminMeResponseSchema, { issuer: "i", subject: "s", slack: { linked: true, userId: "U0PRIYA001" } }],
    ];
    for (const [schema, answer] of answers) expect(schema.parse({ ...answer, extra: "kept" })).toMatchObject({ extra: "kept" });
  });

  it("pins the list and usage read limits (Minor 5)", () => {
    expect(ADMIN_LIST_MAX).toBe(100);
    expect(ADMIN_USAGE_READ_MAX).toBe(5_000);
  });
});

describe("the index keys take only real instants, written one way (Minors 1 and 2)", () => {
  it("writes each time at millisecond precision so keys sort by time", () => {
    expect(failureIndexKey("2026-09-30T08:15:00Z", OPERATION).sk).toBe(`2026-09-30T08:15:00.000Z#${OPERATION}`);
    expect(usageIndexKey("2026-09-30T08:15:00.5Z", OPERATION).sk).toBe(`2026-09-30T08:15:00.500Z#${OPERATION}`);
    const earlier = failureIndexKey("2026-09-30T08:15:00Z", OPERATION).sk;
    const later = failureIndexKey("2026-09-30T08:15:00.500Z", OPERATION).sk;
    expect(earlier < later).toBe(true);
  });

  it("refuses a time that looks like ISO but is no real instant", () => {
    for (const at of ["2026-13-45T99:00:00Z", "2026-02-30T08:15:00Z"]) {
      expect(() => indexDay(at)).toThrow("an index key needs an ISO time");
      expect(() => failureIndexKey(at, OPERATION)).toThrow("an index key needs an ISO time");
      expect(() => usageIndexKey(at, OPERATION)).toThrow("an index key needs an ISO time");
      expect(() => indexExpiresAt(at)).toThrow("an index key needs an ISO time");
    }
  });
});
