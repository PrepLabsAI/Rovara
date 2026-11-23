import { expect, it } from "vitest";
import { sweepLogEntryOf } from "../../packages/broker/src/aws/core-job-services.js";

it("a deployed pass logs the sweep's fixed-word lines and keeps only their listed scalar fields", () => {
  expect(sweepLogEntryOf({ component: "merge_tracking", event: "github.request", method: "GET", pathTemplate: "/repos/:owner/:repo/pulls/:id", status: 200, ms: 12, remaining: 4_000, limit: 5_000, resetAt: 1, token: "ghs_SECRET", url: "https://api.github.com/repos/acme/app", nested: { a: 1 }, message: "free text" }))
    .toEqual({ component: "merge_tracking", event: "github.request", method: "GET", pathTemplate: "/repos/:owner/:repo/pulls/:id", status: 200, ms: 12, remaining: 4_000, limit: 5_000, resetAt: 1 });
  expect(sweepLogEntryOf({ component: "merge_tracking", event: "sweep.settle_failed", taskId: "t1", error: "Error", message: "write refused" })).toEqual({ component: "merge_tracking", event: "sweep.settle_failed", taskId: "t1", error: "Error" });
  for (const event of ["sweep.rows_deferred", "sweep.rate_reserve", "sweep.feedback_failed", "sweep.row_failed", "sweep.read_failed"]) expect(sweepLogEntryOf({ event })).toEqual({ event });
});

it("any other line stays a bare notice (it may carry text a customer wrote)", () => {
  expect(sweepLogEntryOf({ component: "merge_tracking", event: "merge_tracking.pass_failed", taskId: "t1", error: "TypeError" })).toBeUndefined();
  expect(sweepLogEntryOf({ event: 42 })).toBeUndefined();
  expect(sweepLogEntryOf({})).toBeUndefined();
});
