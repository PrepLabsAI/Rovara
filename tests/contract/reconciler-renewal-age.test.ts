// ARGUARD: the sessions reconciler (every 10 minutes, whether or not the renewal's schedule is on) reports the age of the last successful renewal, so RuntimeRequalifyStale still fires
// after six days when the daily schedule has been switched off. It reports nothing before the schedule was ever enabled.
import { describe, expect, it, vi } from "vitest";
import { REQUALIFY_AGE_METRIC, REQUALIFY_PROFILE_ID, requalifyLastSuccessKey, requalifyScheduleEnabledKey } from "../../packages/contracts/src/index.js";
import { renewalAgeMetrics, readRenewalAgeDays } from "../../packages/broker/src/aws/reconciler-renewal-age.js";
import { createReconcilerHandler, type ReconcilerDependencies } from "../../packages/broker/src/aws/session-reconciler.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const DAY = 24 * 3_600_000;
const NOW = new Date("2026-10-30T12:00:00.000Z");
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
const enabled = (db: FakeDynamoDb, daysAgo: number) => db.set({ ...requalifyScheduleEnabledKey(REQUALIFY_PROFILE_ID), entityType: "RUNTIME_REQUALIFY_SCHEDULE_ENABLED", at: at(daysAgo) });
const success = (db: FakeDynamoDb, daysAgo: number) => db.set({ ...requalifyLastSuccessKey(REQUALIFY_PROFILE_ID), entityType: "RUNTIME_REQUALIFY_LAST_SUCCESS", at: at(daysAgo), runId: "0b6f2c3e-8f0e-4c55-9d2e-1a2b3c4d5e6f" });
const age = (db: FakeDynamoDb) => readRenewalAgeDays(db, "state", NOW);

describe("readRenewalAgeDays", () => {
  it("reports nothing before the schedule was ever enabled, even when a renewal was started by hand", async () => {
    const db = new FakeDynamoDb();
    expect(await age(db)).toBeUndefined();
    success(db, 8);
    expect(await age(db)).toBeUndefined();
  });

  it("counts from the first enable until a renewal succeeds, and from the last success after", async () => {
    const db = new FakeDynamoDb();
    enabled(db, 7);
    expect(await age(db)).toBe(7);
    success(db, 2.5);
    expect(await age(db)).toBe(2.5);
  });

  it("refuses a row that is not as the renewal writes it, rather than reporting a made-up age", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...requalifyScheduleEnabledKey(REQUALIFY_PROFILE_ID), at: "yesterday" });
    await expect(age(db)).rejects.toThrow();
  });
});

describe("renewalAgeMetrics", () => {
  const log = vi.fn();
  it("is empty where the reader is not wired, and where nothing was enabled", async () => {
    expect(await renewalAgeMetrics(undefined, NOW, log)).toEqual({});
    expect(await renewalAgeMetrics(async () => undefined, NOW, log)).toEqual({});
  });
  it("counts an unreadable record as a failure, logs only the error name, and never throws", async () => {
    const failing = vi.fn();
    expect(await renewalAgeMetrics(async () => { throw Object.assign(new Error("secret detail"), { name: "AccessDeniedException" }); }, NOW, failing)).toEqual({ ReconcilerRenewalAgeReadFailures: 1 });
    expect(JSON.stringify(failing.mock.calls)).toContain("AccessDeniedException");
    expect(JSON.stringify(failing.mock.calls)).not.toContain("secret detail");
  });
});

describe("the reconciler run", () => {
  function reconciler(options: { renewalAgeDays?: ReconcilerDependencies["renewalAgeDays"] }) {
    const emit = vi.fn<(metrics: Record<string, number>) => void>();
    const run = createReconcilerHandler({
      sessions: { listByState: async () => [], get: async () => undefined } as never,
      instances: async () => [], volumes: async () => [], executionStatus: async () => undefined, ping: async () => "Healthy",
      terminate: async () => undefined, deleteVolume: async () => undefined, quarantine: async () => undefined, failActiveOperation: async () => undefined,
      closedAt: async () => undefined, binding: async () => undefined, emit, now: () => NOW, log: () => undefined,
      ...(options.renewalAgeDays === undefined ? {} : { renewalAgeDays: options.renewalAgeDays }),
    });
    return { run, emit };
  }

  it("emits the age every run when a reader is wired, with no daily check involved (the schedule may be off)", async () => {
    const db = new FakeDynamoDb();
    enabled(db, 7);
    const { run, emit } = reconciler({ renewalAgeDays: (now) => readRenewalAgeDays(db, "state", now) });
    await run();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ [REQUALIFY_AGE_METRIC]: 7, ReconcilerRenewalAgeReadFailures: 0 }));
  });

});
