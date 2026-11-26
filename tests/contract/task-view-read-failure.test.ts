// MEMBERSHIP-READ-FAILS-SAFE: a task view's money visibility is a membership read (`taskMoneyVisible`): when it FAILS the view is the retryable 503, never a 200 served without the money (a degraded
// answer the person cannot tell from the whole one); a plain error from the seam still hides the money, as before.
import { describe, expect, it } from "vitest";
import { taskView } from "../../packages/broker/src/aws/developer-tasks.js";
import { membershipReadFailed } from "../../packages/broker/src/core/membership-read.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { pageTask, pagePlan } from "../support/page-tasks.js";

describe("taskView and the money visibility read", () => {
  const withActions = (f: ReturnType<typeof pageTask>) => { f.deps.actions = { workspace: async () => ({ status: "READY" }), operations: async () => [], pullRequests: async () => [] } as never; return f; };
  const record = (f: ReturnType<typeof pageTask>) => f.db.get(`DEVTASK#${f.taskId}`, "META") as unknown as DeveloperTaskRecord;

  it("(control) the view is served when the seam answers", async () => {
    const f = withActions(pageTask()); f.addVersion("plan", pagePlan());
    f.deps.taskMoneyVisible = async () => true;
    await expect(taskView(f.deps, record(f), { events: 0, details: false })).resolves.toBeDefined();
  });

  it("a money-visibility read that FAILED is the retryable 503; any other failure of the seam still hides the money", async () => {
    const f = withActions(pageTask()); f.addVersion("plan", pagePlan());
    f.deps.taskMoneyVisible = async () => { throw membershipReadFailed(); };
    await expect(taskView(f.deps, record(f), { events: 0, details: false })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    f.deps.taskMoneyVisible = async () => { throw new Error("some other failure"); };
    await expect(taskView(f.deps, record(f), { events: 0, details: false })).resolves.toBeDefined();
  });
});
