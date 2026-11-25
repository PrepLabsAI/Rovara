// Saved images, step SI-1: the numbers of the rebuild rules are named once, in contracts. Nothing reads most of them yet; this pins the values the design fixed (owner DEC 254zzz490 and the plan's section 3) and the
// relations the later lanes rely on (the watch ends before the lease; the stop is the failure after the last back-off step).
import { describe, expect, it } from "vitest";
import {
  SAVED_ENV_BUILD_WATCH_MS, SAVED_ENV_COMPANY_SLOTS, SAVED_ENV_INSTALL_SLOTS, SAVED_ENV_IN_USE_DAYS, SAVED_ENV_JOB_LEASE_MS, SAVED_ENV_KEEP, SAVED_ENV_LIFECYCLE_BACKSTOP_COUNT, SAVED_ENV_MONTHLY_CEILING,
  SAVED_ENV_REBUILD_BACKOFF_MS, SAVED_ENV_REBUILD_SPACING_MS, SAVED_ENV_REBUILD_STOP_AFTER, SAVED_ENV_URGENT_SPACING_MS, savedEnvLifecyclePolicy,
} from "@agentx/contracts";
import * as contracts from "@agentx/contracts";
import { SAVED_ENV_FAILURE_BACKOFF_MS, SAVED_ENV_JOB_LEASE_MS as BROKER_LEASE } from "../../packages/broker/src/core/test-env/saved-env.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("the saved image rebuild constants", () => {
  it("hold the numbers the design fixed", () => {
    expect(SAVED_ENV_KEEP).toBe(2);
    expect(SAVED_ENV_IN_USE_DAYS).toBe(14);
    expect([...SAVED_ENV_REBUILD_BACKOFF_MS]).toEqual([30 * MINUTE, 2 * HOUR, 8 * HOUR]);
    expect(SAVED_ENV_REBUILD_STOP_AFTER).toBe(4);
    expect(SAVED_ENV_COMPANY_SLOTS).toBe(2);
    expect(SAVED_ENV_INSTALL_SLOTS).toBe(4);
    expect(SAVED_ENV_REBUILD_SPACING_MS).toBe(24 * HOUR);
    expect(SAVED_ENV_URGENT_SPACING_MS).toBe(6 * HOUR);
    expect(SAVED_ENV_MONTHLY_CEILING).toBe(40);
    expect(SAVED_ENV_JOB_LEASE_MS).toBe(3 * HOUR);
    expect(SAVED_ENV_BUILD_WATCH_MS).toBe(2 * HOUR + 45 * MINUTE);
  });

  it("relate as the later lanes need: the watch ends before the lease, one company never holds the whole install, the stop follows the last back-off", () => {
    expect(SAVED_ENV_BUILD_WATCH_MS).toBeLessThan(SAVED_ENV_JOB_LEASE_MS);
    expect(SAVED_ENV_COMPANY_SLOTS).toBeLessThan(SAVED_ENV_INSTALL_SLOTS);
    expect(SAVED_ENV_REBUILD_STOP_AFTER).toBe(SAVED_ENV_REBUILD_BACKOFF_MS.length + 1);
    expect(SAVED_ENV_URGENT_SPACING_MS).toBeLessThan(SAVED_ENV_REBUILD_SPACING_MS);
  });

  it("leave today's behaviour alone: the broker's lease and first back-off are the same numbers as before", () => {
    expect(BROKER_LEASE).toBe(3 * HOUR);
    expect(SAVED_ENV_FAILURE_BACKOFF_MS).toBe(30 * MINUTE);
  });

  it("drop the company `keep` bounds: only the constant remains", () => {
    const names = Object.keys(contracts);
    for (const gone of ["SAVED_ENV_KEEP_MIN", "SAVED_ENV_KEEP_MAX", "SAVED_ENV_KEEP_DEFAULT", "SAVED_ENV_LIFECYCLE_MARGIN"]) expect(names).not.toContain(gone);
  });

  it("do not change the deployed repository policy: the count backstop stays 13", () => {
    expect(SAVED_ENV_LIFECYCLE_BACKSTOP_COUNT).toBe(13);
    const policy = savedEnvLifecyclePolicy();
    expect(policy.rules[1]).toEqual({
      rulePriority: 2, description: "Backstop: keep at most 13 images", selection: { tagStatus: "tagged", tagPatternList: ["*"], countType: "imageCountMoreThan", countNumber: 13 }, action: { type: "expire" },
    });
  });
});
