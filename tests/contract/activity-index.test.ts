// tests/contract/activity-index.test.ts
// Spec 025 A4, A5: an operation that ends FAILED or INTERRUPTED, and a worker's usage event, become
// index items the admin routes read without scanning.
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { FailureIndexRecordSchema, UsageIndexRecordSchema } from "../../packages/contracts/src/index.js";
import { indexActivity, type IndexStore } from "../../packages/broker/src/aws/activity-index.js";
import type { StreamRecord } from "../../packages/broker/src/developer/notifications.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const OPERATION = "11111111-1111-4111-8111-111111111111";
const TASK = "33333333-3333-4333-8333-333333333333";
const OWNER = "a".repeat(64);
const PLANTED = `ghp_${"A".repeat(36)}`;

function store(items: Record<string, unknown>[] = []): IndexStore & { puts: Record<string, unknown>[] } {
  const puts: Record<string, unknown>[] = [];
  return {
    puts,
    get: async (key) => items.find((item) => item.pk === key.pk && item.sk === key.sk),
    put: async (item) => { puts.push(item); },
  };
}
const modified = (before: Record<string, unknown>, after: Record<string, unknown>, eventID = "e1"): StreamRecord => ({
  eventID, eventName: "MODIFY", dynamodb: { NewImage: marshall(after, { removeUndefinedValues: true }), OldImage: marshall(before, { removeUndefinedValues: true }) },
});
const inserted = (item: Record<string, unknown>, eventID = "e2"): StreamRecord => ({ eventID, eventName: "INSERT", dynamodb: { NewImage: marshall(item, { removeUndefinedValues: true }) } });
const operation = (extra: Record<string, unknown>) => ({
  pk: `WORKSPACE#${WORKSPACE}`, sk: `OPERATION#${OPERATION}`, entityType: "OPERATION", id: OPERATION, workspaceId: WORKSPACE,
  kind: "task", status: "RUNNING", createdAt: "2026-09-30T08:00:00.000Z", updatedAt: "2026-09-30T08:00:00.000Z", fence: 2, ...extra,
});
const slackWorkspace = [
  { pk: `WORKSPACE#${WORKSPACE}`, sk: "META", projectName: "payments", ownerKey: OWNER },
  { pk: `SLACK_THREAD#${OWNER}`, sk: "META", thread: "T0BSHLLUGBD/C0123456789/1695500000.000100" },
];
const taskWorkspace = [
  { pk: `WORKSPACE#${WORKSPACE}`, sk: "META", projectName: "payments", ownerKey: OWNER },
  { pk: `WORKSPACE#${WORKSPACE}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK, developerId: "d".repeat(64) },
  { pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK, developerName: "Maya Chen" },
];

describe("the failure index (FR-038, A5)", () => {
  it("indexes a Slack task that ends FAILED, with its thread as the turn record link", async () => {
    const index = store(slackWorkspace);
    const result = await indexActivity([modified(operation({}), operation({
      status: "FAILED", error: "npm test exited 1", updatedAt: "2026-09-30T08:15:00.000Z", requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" },
    }))], index, vi.fn());
    expect(result).toEqual({ failures: 1, usage: 0, failed: 0 });
    expect(index.puts).toEqual([{
      pk: "FAILURE#2026-09-30", sk: `2026-09-30T08:15:00.000Z#${OPERATION}`, entityType: "FAILURE_INDEX",
      indexExpiresAt: Math.floor(Date.parse("2026-09-30T08:15:00.000Z") / 1000) + 30 * 86_400,
      operationId: OPERATION, workspaceId: WORKSPACE, project: "payments", origin: "slack",
      requester: { kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" },
      kind: "task", status: "FAILED", category: "task_failed", error: "npm test exited 1", endedAt: "2026-09-30T08:15:00.000Z",
      thread: "T0BSHLLUGBD/C0123456789/1695500000.000100",
    }]);
  });

  it("indexes a developer task's interrupted run as ai_tool, naming the developer and the task", async () => {
    const index = store(taskWorkspace);
    await indexActivity([modified(operation({}), operation({
      status: "INTERRUPTED", updatedAt: "2026-09-30T09:00:00.000Z", requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack" },
    }))], index, vi.fn());
    expect(index.puts[0]).toMatchObject({
      origin: "ai_tool", category: "interrupted", taskId: TASK, error: "the task operation ended INTERRUPTED",
      requester: { kind: "developer", developerId: "d".repeat(64), provider: "slack", name: "Maya Chen" },
    });
  });

  it("stores a failure's error redacted and cut, and logs only IDs", async () => {
    const index = store(slackWorkspace);
    const log = vi.fn();
    await indexActivity([modified(operation({}), operation({ status: "FAILED", updatedAt: "2026-09-30T08:15:00.000Z", error: `auth failed for ${PLANTED} ${"x".repeat(2_000)}` }))], index, log);
    const error = String(index.puts[0]?.error);
    expect(error).toContain("[REDACTED]");
    expect(error).not.toContain(PLANTED);
    expect(error.length).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(log.mock.calls)).not.toContain("auth failed");
  });

  it("indexes nothing for a success, a repeat of a terminal status, or another entity", async () => {
    const index = store(slackWorkspace);
    await indexActivity([
      modified(operation({}), operation({ status: "SUCCEEDED" })),
      modified(operation({ status: "FAILED" }), operation({ status: "FAILED", updatedAt: "2026-09-30T08:20:00.000Z" })),
      modified({ entityType: "WORKSPACE", status: "READY" }, { entityType: "WORKSPACE", status: "PREPARATION_FAILED" }),
    ], index, vi.fn());
    expect(index.puts).toEqual([]);
  });

  it("names the project unknown when the workspace record is gone, and the requester none when absent", async () => {
    const index = store([]);
    await indexActivity([modified(operation({}), operation({ status: "FAILED", updatedAt: "2026-09-30T08:15:00.000Z" }))], index, vi.fn());
    expect(index.puts[0]).toMatchObject({ project: "unknown", origin: "slack", requester: { kind: "none" } });
  });
});

describe("the usage index (A5, A9)", () => {
  const usageEvent = (payload: unknown) => inserted({
    pk: `OPERATION#${OPERATION}`, sk: "EVENT#000000000007", entityType: "EVENT", workspaceId: WORKSPACE, operationId: OPERATION,
    type: "usage", timestamp: "2026-09-30T08:10:00.000Z", payload,
  });
  const telemetry = {
    schemaVersion: 1, outcome: "SUCCEEDED", provider: "bedrock", modelId: "anthropic.claude", cacheRetention: "long",
    tokens: { input: 1_000, output: 200, cacheRead: 50, cacheWrite: 0, total: 1_250 }, cacheReadRatio: 0.05, costUsd: 0.42,
  };

  it("indexes a worker's usage event with the task's duration, tokens and cost", async () => {
    const index = store([...slackWorkspace, operation({ requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" } })]);
    const result = await indexActivity([usageEvent(telemetry)], index, vi.fn());
    expect(result.usage).toBe(1);
    expect(index.puts[0]).toEqual({
      pk: "USAGE#2026-09-30", sk: `2026-09-30T08:10:00.000Z#${OPERATION}`, entityType: "USAGE_INDEX",
      indexExpiresAt: Math.floor(Date.parse("2026-09-30T08:10:00.000Z") / 1000) + 30 * 86_400,
      operationId: OPERATION, workspaceId: WORKSPACE, project: "payments", origin: "slack",
      requester: { kind: "slack", teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, thread: "T0BSHLLUGBD/C0123456789/1695500000.000100",
      at: "2026-09-30T08:10:00.000Z", durationMs: 600_000, inputTokens: 1_050, outputTokens: 200, costUsd: 0.42,
    });
  });

  it.each([
    { input: 3, cacheRead: 900, cacheWrite: 70, expected: 973 },
    { input: 0, cacheRead: 900, cacheWrite: 0, expected: 900 },
    { input: 0, cacheRead: 0, cacheWrite: 70, expected: 70 },
    { input: 3, cacheRead: 0, cacheWrite: 0, expected: 3 },
  ])("indexes every worker input category once: $input/$cacheRead/$cacheWrite", async ({ input, cacheRead, cacheWrite, expected }) => {
    const index = store([...slackWorkspace, operation({})]);
    await indexActivity([usageEvent({ ...telemetry, tokens: { input, output: 200, cacheRead, cacheWrite, total: expected + 200 } })], index, vi.fn());
    expect(index.puts[0]).toMatchObject({ inputTokens: expected, outputTokens: 200, costUsd: 0.42 });
  });

  it("keeps an unknown cost as null, and skips a usage payload it cannot read, counting it", async () => {
    const index = store([...slackWorkspace, operation({})]);
    const log = vi.fn();
    const result = await indexActivity([usageEvent({ ...telemetry, costUsd: null }), usageEvent({ tokens: "lots" })], index, log);
    expect(index.puts[0]).toMatchObject({ costUsd: null });
    expect(result).toEqual({ failures: 0, usage: 1, failed: 1 });
    expect(log).toHaveBeenCalledWith({ event: "activity_index.usage_unreadable", operationId: OPERATION });
  });

  it("goes on after one record's write fails, and reports it by error name", async () => {
    const index = store(slackWorkspace);
    let first = true;
    index.put = async (item) => {
      if (first) { first = false; throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }); }
      index.puts.push(item);
    };
    const log = vi.fn();
    const failed = (id: string, at: string) => modified(operation({ id }), operation({ id, sk: `OPERATION#${id}`, status: "FAILED", updatedAt: at }), id);
    const result = await indexActivity([failed(OPERATION, "2026-09-30T08:15:00.000Z"), failed("44444444-4444-4444-8444-444444444444", "2026-09-30T08:16:00.000Z")], index, log);
    expect(result).toEqual({ failures: 1, usage: 0, failed: 1 });
    expect(log).toHaveBeenCalledWith({ event: "activity_index.write_failed", operationId: OPERATION, error: "ThrottlingException" });
  });
});

// Task 6 reads these items with the strict schemas after stripping the key attributes, so every
// item written must parse, and a field that would not parse is repaired or the item is not written.
describe("index items parse as the admin routes read them", () => {
  const KEYS = new Set(["pk", "sk", "entityType", "indexExpiresAt"]);
  const strip = (item: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(item ?? {}).filter(([key]) => !KEYS.has(key)));

  it("writes failure and usage items that the strict schemas accept", async () => {
    const index = store([...taskWorkspace, operation({ requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack" } })]);
    await indexActivity([
      modified(operation({}), operation({ status: "FAILED", updatedAt: "2026-09-30T08:15:00.000Z", error: "npm test exited 1", requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "slack" } })),
      inserted({
        pk: `OPERATION#${OPERATION}`, sk: "EVENT#000000000007", entityType: "EVENT", workspaceId: WORKSPACE, operationId: OPERATION, type: "usage", timestamp: "2026-09-30T08:10:00.000Z",
        payload: { schemaVersion: 1, outcome: "SUCCEEDED", provider: "bedrock", modelId: "anthropic.claude", cacheRetention: "long", tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }, cacheReadRatio: 0, costUsd: null },
      }),
    ], index, vi.fn());
    expect(index.puts).toHaveLength(2);
    expect(FailureIndexRecordSchema.safeParse(strip(index.puts[0])).success).toBe(true);
    expect(UsageIndexRecordSchema.safeParse(strip(index.puts[1])).success).toBe(true);
  });

  it("stores a requester that would not parse as none, and a long developer name cut to 200 characters", async () => {
    const index = store(slackWorkspace);
    await indexActivity([modified(operation({}), operation({ status: "FAILED", updatedAt: "2026-09-30T08:15:00.000Z", requestedBy: { teamId: "not-a-team", userId: "U0PRIYA001" } }))], index, vi.fn());
    expect(index.puts[0]).toMatchObject({ requester: { kind: "none" } });
    expect(FailureIndexRecordSchema.safeParse(strip(index.puts[0])).success).toBe(true);

    const named = store([...taskWorkspace.slice(0, 2), { pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK, developerName: "M".repeat(300) }]);
    await indexActivity([modified(operation({}), operation({ status: "FAILED", updatedAt: "2026-09-30T08:15:00.000Z", requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "oidc" } }))], named, vi.fn());
    expect(named.puts[0]).toMatchObject({ requester: { kind: "developer", developerId: "d".repeat(64), provider: "oidc", name: "M".repeat(200) } });
    expect(FailureIndexRecordSchema.safeParse(strip(named.puts[0])).success).toBe(true);
  });

  it("cuts a long project name to 63 characters and drops a thread that would not parse", async () => {
    const index = store([
      { pk: `WORKSPACE#${WORKSPACE}`, sk: "META", projectName: "p".repeat(64), ownerKey: OWNER },
      { pk: `SLACK_THREAD#${OWNER}`, sk: "META", thread: "t".repeat(129) },
    ]);
    const result = await indexActivity([modified(operation({}), operation({ status: "FAILED", updatedAt: "2026-09-30T08:15:00.000Z" }))], index, vi.fn());
    expect(result).toEqual({ failures: 1, usage: 0, failed: 0 });
    expect(index.puts[0]).toMatchObject({ project: "p".repeat(63), origin: "slack" });
    expect(index.puts[0]).not.toHaveProperty("thread");
    expect(FailureIndexRecordSchema.safeParse(strip(index.puts[0])).success).toBe(true);
  });

  it("names a missing operation kind unknown, not undefined", async () => {
    const index = store(slackWorkspace);
    const withoutKind: Record<string, unknown> = operation({ status: "FAILED", updatedAt: "2026-09-30T08:15:00.000Z" });
    delete withoutKind.kind;
    await indexActivity([modified(operation({}), withoutKind)], index, vi.fn());
    expect(index.puts[0]).toMatchObject({ kind: "unknown", error: "the unknown operation ended FAILED" });
    expect(FailureIndexRecordSchema.safeParse(strip(index.puts[0])).success).toBe(true);
  });

  it("writes nothing for an item that still would not parse, and logs its operation ID only", async () => {
    const index = store(slackWorkspace);
    const log = vi.fn();
    const result = await indexActivity([modified(operation({ id: "not-a-uuid" }), operation({ id: "not-a-uuid", status: "FAILED", updatedAt: "2026-09-30T08:15:00.000Z", error: "secret detail" }))], index, log);
    expect(index.puts).toEqual([]);
    expect(result).toEqual({ failures: 0, usage: 0, failed: 1 });
    expect(log).toHaveBeenCalledWith({ event: "activity_index.record_invalid", operationId: "not-a-uuid" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret detail");
  });
});

// A4: the index never pushes the publisher past its timeout, or the batch would be dispatched again.
describe("the index's deadline (A4)", () => {
  const failedAt = (id: string, at: string) => modified(operation({ id }), operation({ id, sk: `OPERATION#${id}`, status: "FAILED", updatedAt: at }), id);
  const SECOND = "44444444-4444-4444-8444-444444444444";

  it("indexes nothing once the deadline has passed, and logs how many records it skipped", async () => {
    const index = store(slackWorkspace);
    const log = vi.fn();
    const result = await indexActivity([
      failedAt(OPERATION, "2026-09-30T08:15:00.000Z"),
      modified(operation({}), operation({ status: "SUCCEEDED" })),
      failedAt(SECOND, "2026-09-30T08:16:00.000Z"),
    ], index, log, Date.now() - 1);
    expect(index.puts).toEqual([]);
    expect(result).toEqual({ failures: 0, usage: 0, failed: 0 });
    expect(log.mock.calls).toEqual([[{ event: "activity_index.deadline_reached", skipped: 2 }]]);
  });

  it("stops between records when the deadline passes mid-batch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-09-30T08:20:00.000Z"));
      const index = store(slackWorkspace);
      index.put = async (item) => { index.puts.push(item); vi.setSystemTime(Date.parse("2026-09-30T08:20:10.000Z")); };
      const log = vi.fn();
      const result = await indexActivity([failedAt(OPERATION, "2026-09-30T08:15:00.000Z"), failedAt(SECOND, "2026-09-30T08:16:00.000Z")], index, log, Date.parse("2026-09-30T08:20:05.000Z"));
      expect(result).toEqual({ failures: 1, usage: 0, failed: 0 });
      expect(index.puts).toHaveLength(1);
      expect(log).toHaveBeenCalledWith({ event: "activity_index.deadline_reached", skipped: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a store call that never answers once the deadline passes, and hands each call an abort signal", async () => {
    // The wall clock stands still, so the deadline's timer fires while Date.now() is still before
    // the deadline: under load a timer can fire a millisecond early, and the index must stop anyway.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-09-30T08:20:00.000Z"));
      const index = store(slackWorkspace);
      const signals: Array<AbortSignal | undefined> = [];
      index.get = (_key, options) => { signals.push(options?.signal); return new Promise(() => undefined); };
      const log = vi.fn();
      const result = await indexActivity([failedAt(OPERATION, "2026-09-30T08:15:00.000Z"), failedAt(SECOND, "2026-09-30T08:16:00.000Z")], index, log, Date.now() + 50);
      expect(result).toEqual({ failures: 0, usage: 0, failed: 1 });
      expect(index.puts).toEqual([]);
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal instanceof AbortSignal && signal.aborted)).toBe(true);
      expect(log).toHaveBeenCalledWith({ event: "activity_index.write_failed", operationId: OPERATION, error: "TimeoutError" });
      expect(log).toHaveBeenCalledWith({ event: "activity_index.deadline_reached", skipped: 1 });
    } finally {
      vi.useRealTimers();
    }
  }, 2_000);
});
