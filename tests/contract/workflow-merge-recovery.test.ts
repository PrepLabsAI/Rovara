import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  mergeRecoveryItem,
  runDueWorkflowMergeRecovery,
  seedWorkflowMergeRecovery,
  type GithubMergeReadBudget,
  type MergeRecoveryDependencies,
  type MergeRecoveryResult,
} from "../../packages/broker/src/aws/workflow-merge-recovery.js";
import { releaseItems } from "../../packages/broker/src/developer/limits.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TABLE = "state";
const RECOVERY_PK = "WORKFLOW_MERGE_RECOVERY";
const SWEEP_PK = "WORKFLOW_MERGE_SWEEP";
const FIVE_MINUTES = 5 * 60_000;

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function recoveryKey(taskId: string): { pk: string; sk: string } {
  return { pk: RECOVERY_PK, sk: `TASK#${taskId}` };
}

function taskKey(taskId: string): { pk: string; sk: string } {
  return { pk: `DEVTASK#${taskId}`, sk: "META" };
}

function taskRecord(taskId: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...taskKey(taskId),
    entityType: "DEVELOPER_TASK",
    taskId,
    workspaceId: `workspace-${taskId}`,
    charge: {
      member: { pk: "SLACK_LIMIT#team", sk: `MEMBER#${taskId}` },
      organization: { pk: "SLACK_LIMIT#team", sk: "ORGANIZATION" },
    },
    ...extras,
  };
}

async function enroll(db: FakeDynamoDb, taskId: string, at: number): Promise<void> {
  await db.send(new TransactWriteCommand({
    TransactItems: [mergeRecoveryItem(TABLE, taskId, new Date(at).toISOString())],
  }));
}

function harness(options: {
  now?: number;
  reconcile?: (taskId: string, budget: GithubMergeReadBudget) => Promise<MergeRecoveryResult>;
  validateSeed?: (taskId: string) => Promise<boolean>;
} = {}) {
  const db = new FakeDynamoDb();
  let now = options.now ?? Date.parse("2026-10-11T12:00:00.000Z");
  const commands: unknown[] = [];
  const reconcile = vi.fn(options.reconcile ?? (async () => ({ kind: "OBSERVED" } as const)));
  const documentClient = {
    send: async (command: unknown): Promise<unknown> => {
      commands.push(command);
      return db.send(command as never);
    },
  };
  const dependencies: MergeRecoveryDependencies = {
    documentClient,
    tableName: TABLE,
    now: () => now,
    reconcile,
    ...(options.validateSeed === undefined ? {} : { validateSeed: options.validateSeed }),
  };
  return {
    db,
    commands,
    reconcile,
    dependencies,
    now: () => now,
    setNow: (value: number) => { now = value; },
  };
}

describe("workflow merge recovery enrollment and seeding", () => {
  it("preserves an existing lease, due time, and failure count when publication enrolls again", async () => {
    const h = harness();
    const taskId = uuid(1);
    await enroll(h.db, taskId, h.now());
    await h.db.send(new UpdateCommand({
      TableName: TABLE,
      Key: recoveryKey(taskId),
      UpdateExpression: "SET attempts = :attempts, nextAttemptAt = :due, dispatchDueSk = :dueKey, leaseToken = :token, leaseExpiresAt = :lease",
      ExpressionAttributeValues: {
        ":attempts": 3,
        ":due": h.now() + 1_800_000,
        ":dueKey": `${new Date(h.now() + 1_800_000).toISOString()}#${taskId}`,
        ":token": "lease-one",
        ":lease": h.now() + 30_000,
      },
    }));

    await enroll(h.db, taskId, h.now() + 5_000);

    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).toMatchObject({
      taskId,
      attempts: 3,
      nextAttemptAt: h.now() + 1_800_000,
      leaseToken: "lease-one",
      leaseExpiresAt: h.now() + 30_000,
    });
    expect(h.db.refusals).toEqual([]);
  });

  it("requires a trusted validator, validates every UUID before writes, and caps one seed at 25", async () => {
    const noValidator = harness();
    await expect(seedWorkflowMergeRecovery(noValidator.dependencies, [uuid(1)])).rejects.toThrow(/validator/i);
    expect(noValidator.db.commandNames()).toEqual([]);

    const overCap = harness({ validateSeed: async () => true });
    await expect(seedWorkflowMergeRecovery(overCap.dependencies, Array.from({ length: 26 }, (_, index) => uuid(index + 1)))).rejects.toThrow(/25/);
    expect(overCap.db.commandNames()).toEqual([]);

    const malformed = harness({ validateSeed: async () => true });
    await expect(seedWorkflowMergeRecovery(malformed.dependencies, [uuid(1), "not-a-uuid"])).rejects.toThrow(/UUID/i);
    expect(malformed.db.commandNames()).toEqual([]);

    const seeded = harness({ validateSeed: async (taskId) => taskId !== uuid(2) });
    for (let index = 1; index <= 25; index += 1) seeded.db.set(taskRecord(uuid(index)));
    const result = await seedWorkflowMergeRecovery(seeded.dependencies, Array.from({ length: 25 }, (_, index) => uuid(index + 1)));
    expect(result).toEqual({ seeded: 24, skipped: 1 });
    expect(seeded.db.find((item) => item.pk === RECOVERY_PK)).toHaveLength(24);
    expect(seeded.db.commandNames()).not.toContain("ScanCommand");
    expect(seeded.db.refusals).toEqual([]);
  });
});
describe("workflow merge recovery sweep admission", () => {
  it("queries one exact due page and claims at most ten of eleven rows", async () => {
    const h = harness();
    for (let index = 1; index <= 11; index += 1) {
      const taskId = uuid(index);
      h.db.set(taskRecord(taskId));
      await enroll(h.db, taskId, h.now() - (12 - index) * 1_000);
    }

    const result = await runDueWorkflowMergeRecovery(h.dependencies);

    expect(result).toEqual({ attempted: 10, reconciled: 10, deferred: 0 });
    expect(h.reconcile).toHaveBeenCalledTimes(10);
    const queries = h.commands.filter((command) => command instanceof Object && (command as { constructor: { name: string } }).constructor.name === "QueryCommand") as Array<{ input: Record<string, unknown> }>;
    expect(queries).toHaveLength(1);
    expect(queries[0]?.input).toMatchObject({
      IndexName: "workflow-dispatch-due",
      KeyConditionExpression: "dispatchDuePk = :pk AND dispatchDueSk BETWEEN :low AND :high",
      Limit: 10,
      ExpressionAttributeValues: { ":pk": RECOVERY_PK, ":low": "0" },
    });
    expect(h.db.commandNames()).not.toContain("ScanCommand");
    expect(h.db.refusals).toEqual([]);
  });

  it("admits neither a future row nor a row with a live lease", async () => {
    const h = harness();
    const future = uuid(1);
    const leased = uuid(2);
    h.db.set(taskRecord(future));
    h.db.set(taskRecord(leased));
    await enroll(h.db, future, h.now() + 1);
    await enroll(h.db, leased, h.now() - 1);
    await h.db.send(new UpdateCommand({
      TableName: TABLE,
      Key: recoveryKey(leased),
      UpdateExpression: "SET leaseToken = :token, leaseExpiresAt = :expires",
      ExpressionAttributeValues: { ":token": "still-live", ":expires": h.now() + 1 },
    }));

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("cannot discover ordinary workflow-dispatch or plan-evidence rows through its exact partition query", async () => {
    const h = harness();
    h.db.set({
      pk: "WORKFLOW_DISPATCH",
      sk: "TASK#other#1",
      dispatchDuePk: "WORKFLOW_DISPATCH",
      dispatchDueSk: `${new Date(h.now() - 1).toISOString()}#other#1`,
    });
    h.db.set({
      pk: "PLAN_EVIDENCE",
      sk: "other#artifact",
      dispatchDuePk: "PLAN_EVIDENCE",
      dispatchDueSk: `${new Date(h.now() - 1).toISOString()}#other#artifact`,
    });

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("allows only one of two concurrent sweep invocations to acquire the global admission", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ reconcile: async () => { await blocked; return { kind: "OBSERVED" }; } });
    const taskId = uuid(1);
    h.db.set(taskRecord(taskId));
    await enroll(h.db, taskId, h.now() - 1);

    const first = runDueWorkflowMergeRecovery(h.dependencies);
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    const second = await runDueWorkflowMergeRecovery(h.dependencies);
    release();

    expect(second).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(await first).toEqual({ attempted: 1, reconciled: 1, deferred: 0 });
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it("does not settle a row after its lease token becomes stale", async () => {
    const taskId = uuid(1);
    const h = harness({ reconcile: async () => {
      const current = h.db.get(RECOVERY_PK, `TASK#${taskId}`)!;
      h.db.set({ ...current, leaseToken: "new-owner", leaseExpiresAt: h.now() + 30_000 });
      return { kind: "OBSERVED" };
    } });
    h.db.set(taskRecord(taskId));
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).toMatchObject({ leaseToken: "new-owner" });
  });

  it("recovers after an ambiguous settlement leaves the row lease behind", async () => {
    const taskId = uuid(1);
    const h = harness();
    h.db.set(taskRecord(taskId));
    await enroll(h.db, taskId, h.now() - 1);
    h.db.injectFault({
      command: "UpdateCommand",
      match: (input) => String(input.ConditionExpression).includes("leaseToken = :token") && String(input.UpdateExpression).includes("nextAttemptAt"),
      error: { name: "InternalServerError" },
    });

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).toMatchObject({ leaseExpiresAt: h.now() + 30_000 });

    h.setNow(h.now() + FIVE_MINUTES);
    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 1, deferred: 0 });
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });
});

describe("workflow merge recovery outcomes", () => {
  it("rotates a failing oldest row behind another overdue row and keeps active rows without TTL", async () => {
    const first = uuid(1);
    const second = uuid(2);
    const h = harness({ reconcile: async (taskId) => taskId === first ? { kind: "RETRY", retryAt: h.now(), scope: "task" } : { kind: "OBSERVED" } });
    for (const taskId of [first, second]) h.db.set(taskRecord(taskId));
    await enroll(h.db, first, h.now() - 2_000);
    await enroll(h.db, second, h.now() - 1_000);
    const secondOverdueKey = String(h.db.get(RECOVERY_PK, `TASK#${second}`)?.dispatchDueSk);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 2, reconciled: 1, deferred: 1 });
    const failed = h.db.get(RECOVERY_PK, `TASK#${first}`)!;
    expect(failed).toMatchObject({ attempts: 1, nextAttemptAt: h.now() + FIVE_MINUTES });
    expect(failed).not.toHaveProperty("indexExpiresAt");
    expect(String(failed.dispatchDueSk) > secondOverdueKey).toBe(true);
  });

  it("backs repeated task failures off for 5, 10, 20, then 30 minutes without dead-lettering", async () => {
    const taskId = uuid(1);
    const h = harness({ reconcile: async () => ({ kind: "RETRY", retryAt: h.now(), scope: "task" }) });
    h.db.set(taskRecord(taskId));
    await enroll(h.db, taskId, h.now() - 1);

    for (const expectedMinutes of [5, 10, 20, 30, 30]) {
      const before = h.now();
      expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
      const row = h.db.get(RECOVERY_PK, `TASK#${taskId}`)!;
      expect(row.nextAttemptAt).toBe(before + expectedMinutes * 60_000);
      expect(row).not.toHaveProperty("indexExpiresAt");
      expect(row).not.toHaveProperty("recoveryStatus");
      h.setNow(row.nextAttemptAt as number);
    }
  });

  it("quarantines malformed and missing discovery without changing the task", async () => {
    const h = harness();
    const taskId = uuid(1);
    const task = taskRecord(taskId, { title: "leave me alone" });
    h.db.set(task);
    h.db.set({
      pk: RECOVERY_PK,
      sk: "TASK#not-a-uuid",
      entityType: RECOVERY_PK,
      taskId: "not-a-uuid",
      dispatchDuePk: RECOVERY_PK,
      dispatchDueSk: `${new Date(h.now() - 1).toISOString()}#not-a-uuid`,
      nextAttemptAt: h.now() - 1,
    });
    const missing = uuid(2);
    await enroll(h.db, missing, h.now() - 1);

    const result = await runDueWorkflowMergeRecovery(h.dependencies);

    expect(result).toEqual({ attempted: 0, reconciled: 0, deferred: 2 });
    expect(h.db.get(RECOVERY_PK, "TASK#not-a-uuid")).toMatchObject({ recoveryStatus: "QUARANTINED", recoveryErrorClass: "MALFORMED_DISCOVERY" });
    expect(h.db.get(RECOVERY_PK, `TASK#${missing}`)).toMatchObject({ recoveryStatus: "QUARANTINED", recoveryErrorClass: "MISSING_TASK" });
    expect(h.db.get(task.pk as string, task.sk as string)).toEqual(task);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("quarantines an out-of-range timestamp and still reconciles the next healthy due row", async () => {
    const h = harness();
    const poisoned = uuid(1);
    const healthy = uuid(2);
    h.db.set({
      pk: RECOVERY_PK,
      sk: `TASK#${poisoned}`,
      entityType: RECOVERY_PK,
      taskId: poisoned,
      attempts: 0,
      nextAttemptAt: 1e20,
      dispatchDuePk: RECOVERY_PK,
      dispatchDueSk: `${new Date(h.now() - 2_000).toISOString()}#${poisoned}`,
    });
    const poisonedTask = taskRecord(poisoned, { title: "poisoned recovery must not change this task" });
    h.db.set(poisonedTask);
    h.db.set(taskRecord(healthy));
    await enroll(h.db, healthy, h.now() - 1_000);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 1, deferred: 1 });
    expect(h.db.get(RECOVERY_PK, `TASK#${poisoned}`)).toMatchObject({
      recoveryStatus: "QUARANTINED",
      recoveryErrorClass: "MALFORMED_DISCOVERY",
    });
    expect(h.db.get(taskKey(poisoned).pk, taskKey(poisoned).sk)).toEqual(poisonedTask);
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.reconcile).toHaveBeenCalledWith(healthy, expect.any(Object));
  });

  it("never writes quarantine fields onto a malformed discovery item outside the recovery partition", async () => {
    const h = harness();
    const taskId = uuid(1);
    const task = {
      ...taskRecord(taskId, { title: "keep every task field" }),
      dispatchDuePk: RECOVERY_PK,
      dispatchDueSk: `${new Date(h.now() - 1).toISOString()}#${taskId}`,
      nextAttemptAt: h.now() - 1,
      attempts: 0,
    };
    h.db.set(task);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 0, reconciled: 0, deferred: 1 });
    expect(h.db.get(taskKey(taskId).pk, taskKey(taskId).sk)).toEqual(task);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("keeps a terminal callback active until a durable release receipt exists", async () => {
    const taskId = uuid(1);
    const h = harness({ reconcile: async () => ({ kind: "TERMINAL", release: "queued" }) });
    h.db.set(taskRecord(taskId));
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).toMatchObject({ nextAttemptAt: h.now() + FIVE_MINUTES });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).not.toHaveProperty("indexExpiresAt");
  });

  it.each(["queued", "confirmed"] as const)("retires a %s terminal receipt only under the row lease fence", async (release) => {
    const taskId = uuid(release === "queued" ? 1 : 2);
    const h = harness({ reconcile: async () => ({ kind: "TERMINAL", release }) });
    const task = taskRecord(taskId);
    h.db.set(task);
    if (release === "queued") {
      h.db.set({ pk: "FINISHED_RELEASE", sk: `TASK#${taskId}`, entityType: "FINISHED_RELEASE", taskId });
    } else {
      h.db.set({ ...task, releasedAt: new Date(h.now()).toISOString() });
      h.db.set({ pk: `WORKSPACE#workspace-${taskId}`, sk: "META", status: "CLOSED" });
    }
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 1, deferred: 0 });
    const retired = h.db.get(RECOVERY_PK, `TASK#${taskId}`)!;
    expect(retired).toMatchObject({ recoveryStatus: "RETIRED", indexExpiresAt: Math.floor(h.now() / 1_000) + 7 * 24 * 60 * 60 });
    expect(retired).not.toHaveProperty("dispatchDuePk");
    expect(retired).not.toHaveProperty("leaseToken");
  });

  it("cannot retire a valid queued receipt after another sweep takes the row lease", async () => {
    const taskId = uuid(1);
    const h = harness({ reconcile: async () => {
      const current = h.db.get(RECOVERY_PK, `TASK#${taskId}`)!;
      h.db.set({ ...current, leaseToken: "new-owner", leaseExpiresAt: h.now() + 30_000 });
      return { kind: "TERMINAL", release: "queued" };
    } });
    h.db.set(taskRecord(taskId));
    h.db.set({ pk: "FINISHED_RELEASE", sk: `TASK#${taskId}`, entityType: "FINISHED_RELEASE", taskId });
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).toMatchObject({ leaseToken: "new-owner" });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).not.toHaveProperty("indexExpiresAt");
  });

  it("retains the row when terminal receipt reads fail", async () => {
    const taskId = uuid(1);
    const h = harness({ reconcile: async () => ({ kind: "TERMINAL", release: "queued" }) });
    h.db.set(taskRecord(taskId));
    await enroll(h.db, taskId, h.now() - 1);
    h.db.injectFault({
      command: "GetCommand",
      match: (input) => (input.Key as { pk?: string }).pk === "FINISHED_RELEASE",
      error: { name: "InternalServerError" },
    });

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).not.toHaveProperty("indexExpiresAt");
  });

  it("retires an already closed task only after its workspace and both charged counters prove cleanup", async () => {
    const taskId = uuid(1);
    const h = harness({ reconcile: async () => ({ kind: "TERMINAL", release: "confirmed" }) });
    const task = taskRecord(taskId, { closedAt: new Date(h.now()).toISOString() });
    h.db.set(task);
    h.db.set({ pk: `WORKSPACE#workspace-${taskId}`, sk: "META", status: "CLOSED" });
    h.db.set({ pk: "SLACK_LIMIT#team", sk: `MEMBER#${taskId}`, count: 1, tasks: new Set([taskId]) });
    h.db.set({ pk: "SLACK_LIMIT#team", sk: "ORGANIZATION", count: 1 });
    await h.db.send(new TransactWriteCommand({
      TransactItems: releaseItems(TABLE, {
        member: { pk: "SLACK_LIMIT#team", sk: `MEMBER#${taskId}` },
        organization: { pk: "SLACK_LIMIT#team", sk: "ORGANIZATION" },
      }, taskId),
    }));
    expect(h.db.get("SLACK_LIMIT#team", `MEMBER#${taskId}`)).not.toHaveProperty("tasks");
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 1, deferred: 0 });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).toMatchObject({ recoveryStatus: "RETIRED" });
  });

  it("keeps a closed task pending while a charged counter still contains it", async () => {
    const taskId = uuid(1);
    const h = harness({ reconcile: async () => ({ kind: "TERMINAL", release: "confirmed" }) });
    const task = taskRecord(taskId, { closedAt: new Date(h.now()).toISOString() });
    h.db.set(task);
    h.db.set({ pk: `WORKSPACE#workspace-${taskId}`, sk: "META", status: "CLOSED" });
    h.db.set({ pk: "SLACK_LIMIT#team", sk: `MEMBER#${taskId}`, count: 1, tasks: new Set([taskId]) });
    h.db.set({ pk: "SLACK_LIMIT#team", sk: "ORGANIZATION", count: 1 });
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).not.toHaveProperty("indexExpiresAt");
  });

  it("keeps a closed task pending when its charged member counter is unreadable", async () => {
    const taskId = uuid(1);
    const h = harness({ reconcile: async () => ({ kind: "TERMINAL", release: "confirmed" }) });
    const task = taskRecord(taskId, { closedAt: new Date(h.now()).toISOString() });
    h.db.set(task);
    h.db.set({ pk: `WORKSPACE#workspace-${taskId}`, sk: "META", status: "CLOSED" });
    h.db.set({ pk: "SLACK_LIMIT#team", sk: `MEMBER#${taskId}`, count: "zero" });
    h.db.set({ pk: "SLACK_LIMIT#team", sk: "ORGANIZATION", count: 0 });
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).not.toHaveProperty("indexExpiresAt");
  });
});

describe("workflow merge recovery global cooldown and request budget", () => {
  it.each(["task", "github-global"] as const)("keeps an unrepresentable %s retry time safely retryable", async (scope) => {
    const taskId = uuid(1);
    const h = harness({ reconcile: async () => ({ kind: "RETRY", retryAt: 1e20, scope }) });
    h.db.set(taskRecord(taskId));
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).toMatchObject({ nextAttemptAt: h.now() + FIVE_MINUTES });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).not.toHaveProperty("indexExpiresAt");
  });

  it("persists a global cooldown before stopping and admits no request at the ordinary five-minute tick", async () => {
    const first = uuid(1);
    const second = uuid(2);
    const h = harness({ reconcile: async (taskId, budget) => {
      budget.beforeRequest();
      return taskId === first
        ? { kind: "RETRY", retryAt: h.now() + 60 * 60_000, scope: "github-global" }
        : { kind: "OBSERVED" };
    } });
    for (const taskId of [first, second]) h.db.set(taskRecord(taskId));
    await enroll(h.db, first, h.now() - 2_000);
    await enroll(h.db, second, h.now() - 1_000);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.db.get(SWEEP_PK, "META")).toMatchObject({ nextSweepAt: h.now() + 60 * 60_000 });

    h.setNow(h.now() + FIVE_MINUTES);
    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 0, reconciled: 0, deferred: 0 });
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale global token lower a newer cooldown", async () => {
    const taskId = uuid(1);
    const later = Date.parse("2026-10-11T15:00:00.000Z");
    const h = harness({ reconcile: async () => {
      const global = h.db.get(SWEEP_PK, "META")!;
      h.db.set({ ...global, leaseToken: "new-sweep", nextSweepAt: later });
      return { kind: "RETRY", retryAt: h.now() + FIVE_MINUTES, scope: "github-global" };
    } });
    h.db.set(taskRecord(taskId));
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.db.get(SWEEP_PK, "META")).toMatchObject({ leaseToken: "new-sweep", nextSweepAt: later });
  });

  it("rejects request 257 before admission and retains recovery", async () => {
    const taskId = uuid(1);
    let admitted = 0;
    const h = harness({ reconcile: async (_taskId, budget) => {
      for (let index = 0; index < 257; index += 1) {
        budget.beforeRequest();
        admitted += 1;
      }
      return { kind: "OBSERVED" };
    } });
    h.db.set(taskRecord(taskId));
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(admitted).toBe(256);
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).not.toHaveProperty("indexExpiresAt");
  });

  it("aborts GitHub admission at the twenty-second deadline and retains recovery", async () => {
    const taskId = uuid(1);
    const h = harness({ reconcile: async (_taskId, budget) => {
      h.setNow(h.now() + 20_000);
      expect(budget.signal.aborted).toBe(false);
      budget.beforeRequest();
      return { kind: "OBSERVED" };
    } });
    h.db.set(taskRecord(taskId));
    await enroll(h.db, taskId, h.now() - 1);

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.db.get(RECOVERY_PK, `TASK#${taskId}`)).not.toHaveProperty("indexExpiresAt");
  });

  it("does not continue after an unknown cooldown settlement result", async () => {
    const first = uuid(1);
    const second = uuid(2);
    const h = harness({ reconcile: async (taskId, budget) => {
      budget.beforeRequest();
      return taskId === first
        ? { kind: "RETRY", retryAt: h.now() + 60 * 60_000, scope: "github-global" }
        : { kind: "OBSERVED" };
    } });
    for (const taskId of [first, second]) h.db.set(taskRecord(taskId));
    await enroll(h.db, first, h.now() - 2_000);
    await enroll(h.db, second, h.now() - 1_000);
    h.db.injectFault({
      command: "UpdateCommand",
      match: (input) => (input.Key as { pk?: string }).pk === SWEEP_PK && String(input.ConditionExpression).includes("leaseToken"),
      error: { name: "InternalServerError" },
    });

    expect(await runDueWorkflowMergeRecovery(h.dependencies)).toEqual({ attempted: 1, reconciled: 0, deferred: 1 });
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.db.get(RECOVERY_PK, `TASK#${second}`)).toMatchObject({ nextAttemptAt: h.now() - 1_000 });
  });
});
