// ARGUARD: the daily check reports how long ago the last renewal succeeded, so `RuntimeRequalifyStale` has a number to breach on. Before this the only metric was a 1 on success, so a
// renewal that never ran left no data and no alarm.
import { beforeEach, describe, expect, it } from "vitest";
import { REQUALIFY_AGE_METRIC, REQUALIFY_PROFILE_ID, REQUALIFY_STALE_AFTER_DAYS, requalifyLastSuccessKey, requalifyScheduleEnabledKey } from "../../packages/contracts/src/index.js";
import { runRequalifyAction } from "../../packages/broker/src/aws/runtime-requalify-steps.js";
import { recordRenewalSuccess } from "../../packages/broker/src/aws/runtime-requalify-heartbeat.js";
import { FakeCloud } from "../support/requalify-fake-cloud.js";

const DAY = 24 * 3_600_000;
const RUN_ID = "11111111-2222-4333-8444-555555555555";
let cloud: FakeCloud;
const check = (force = false) => runRequalifyAction(cloud.deps(), { action: "due", ...(force ? { force: true } : {}) });
const ages = () => cloud.metricValues.filter((metric) => metric.name === REQUALIFY_AGE_METRIC).map((metric) => metric.value);
const enabledRow = () => cloud.ddb.get(cloud.key(requalifyScheduleEnabledKey(REQUALIFY_PROFILE_ID)));
const successRow = () => cloud.ddb.get(cloud.key(requalifyLastSuccessKey(REQUALIFY_PROFILE_ID)));

beforeEach(() => {
  cloud = new FakeCloud();
  // Rows far from expiry: the check starts nothing, so this is only about the heartbeat.
  cloud.seedRegistered({ generation: 1, pointerInstance: cloud.addRunner().id, expiresInMs: 6 * DAY });
});

describe("the daily check's heartbeat", () => {
  it("records the first scheduled run as the moment the schedule was enabled, once, and reports age 0 that day", async () => {
    await check();
    expect(enabledRow()).toMatchObject({ entityType: "RUNTIME_REQUALIFY_SCHEDULE_ENABLED", at: new Date(cloud.clock).toISOString() });
    expect(ages()).toEqual([0]);
    // A later run never moves the first-enabled time.
    const first = enabledRow()!["at"];
    cloud.clock += 2 * DAY;
    await check();
    expect(enabledRow()!["at"]).toBe(first);
    expect(ages()).toEqual([0, 2]);
  });

  it("reports the days since the last successful renewal, and reaches the alarm's threshold after six days without one", async () => {
    await recordRenewalSuccess(cloud.deps(), RUN_ID);
    expect(successRow()).toMatchObject({ entityType: "RUNTIME_REQUALIFY_LAST_SUCCESS", runId: RUN_ID, at: new Date(cloud.clock).toISOString() });
    cloud.clock += 5.5 * DAY;
    await check();
    cloud.clock += 1 * DAY;
    await check();
    const [fiveAndAHalf, sixAndAHalf] = ages();
    expect(fiveAndAHalf).toBe(5.5);
    expect(fiveAndAHalf!).toBeLessThan(REQUALIFY_STALE_AFTER_DAYS);
    expect(sixAndAHalf).toBe(6.5);
    expect(sixAndAHalf!).toBeGreaterThanOrEqual(REQUALIFY_STALE_AFTER_DAYS);
    // A new success resets it.
    await recordRenewalSuccess(cloud.deps(), RUN_ID);
    await check();
    expect(ages().at(-1)).toBe(0);
  });

  it("counts from the first enable when no renewal has ever succeeded, so a schedule that never renews still breaches", async () => {
    await check();
    cloud.clock += 6 * DAY;
    await check();
    expect(ages()).toEqual([0, 6]);
  });

  it("does nothing for the operator's forced start: it is not the schedule and must not mark it enabled", async () => {
    await check(true);
    expect(enabledRow()).toBeUndefined();
    expect(ages()).toEqual([]);
  });

  it("never fails the check, and does not start or stop a renewal, when the metric cannot be written", async () => {
    cloud.failMetrics = true;
    await expect(check()).resolves.toEqual({ started: false, reason: "not-due" });
    expect(enabledRow()).toBeDefined();
  });

  it("a renewal that is due still starts, and the age is reported alongside", async () => {
    cloud.ddb.clear();
    cloud.seedRegistered({ generation: 1, pointerInstance: cloud.addRunner().id, expiresInMs: 60 * 3_600_000 });
    await expect(check()).resolves.toEqual({ started: true, reason: "expiring" });
    expect(ages()).toEqual([0]);
  });
});
