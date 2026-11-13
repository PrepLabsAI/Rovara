// The task-end seam: the host is told once that a task ended, whether the person closed it or a merged pull request completed it, and whichever came first. Fake adapters only.
import { describe, expect, it } from "vitest";
import { closeLoadedTask } from "../../packages/core/src/core/task-flow/close.js";
import { readTask } from "../../packages/core/src/core/task-flow/reads.js";
import { taskEndKey } from "../../packages/core/src/core/task-flow/task-end.js";
import { recoveryRowKey } from "../../packages/core/src/core/merge/store.js";
import { TASK_ID } from "../support/merge-world.js";
import { OWNER_ID, ORG, host } from "../support/service-host.js";

type Host = Awaited<ReturnType<typeof host>>;

/** A host whose seam records each call (and fails the first `failures` of them). */
async function listening(failures = 0): Promise<Host & { ended: Array<{ orgId: string; taskId: string }> }> {
  const w = await host();
  const ended: Array<{ orgId: string; taskId: string }> = [];
  let failing = failures;
  w.h.deps.taskEnded = async (event) => {
    ended.push(event);
    if (failing > 0) { failing -= 1; throw new Error("the host is down"); }
  };
  return Object.assign(w, { ended });
}

const mergeOnTheCodeHost = (w: Host): void => {
  const pr = w.world.prs[0]!;
  expect(pr.model.merge(String(pr.number), { revision: pr.head, method: "squash" }).outcome).toBe("merged");
};

const close = async (w: Host): Promise<void> => {
  const task = (await readTask(w.h.deps, TASK_ID))!;
  await closeLoadedTask(w.h.deps, task, OWNER_ID);
  expect((await readTask(w.h.deps, TASK_ID))!.closedAt).toBeDefined();
};

describe("the task-end seam", () => {
  it("a merge that completes the task tells the host once, in the sweep that recorded it", async () => {
    const w = await listening();
    mergeOnTheCodeHost(w);
    await w.tracking.sweep();
    expect((await readTask(w.h.deps, TASK_ID))!.workflow).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(w.ended).toEqual([{ orgId: ORG, taskId: TASK_ID }]);
    expect(await w.world.store.get(taskEndKey(TASK_ID))).toMatchObject({ cause: "merged", notifiedAt: expect.any(String) as unknown });
  });

  it("merge then close: the host got the first end, and the close does not tell it again", async () => {
    const w = await listening();
    mergeOnTheCodeHost(w);
    await w.tracking.sweep();
    await close(w);
    expect(w.ended).toHaveLength(1);
    // Closing again changes nothing.
    await close(w);
    expect(w.ended).toHaveLength(1);
  });

  it("close only: the host is told once", async () => {
    const w = await listening();
    await close(w);
    expect(w.ended).toEqual([{ orgId: ORG, taskId: TASK_ID }]);
    expect(await w.world.store.get(taskEndKey(TASK_ID))).toMatchObject({ cause: "closed", notifiedAt: expect.any(String) as unknown });
    await close(w);
    expect(w.ended).toHaveLength(1);
  });

  it("a redelivered merge tells the host once: the same merge seen again, and two passes that see it at the same time", async () => {
    const w = await listening();
    mergeOnTheCodeHost(w);
    const budget = { signal: new AbortController().signal, beforeRequest: () => undefined };
    // Two passes read the open task and both see the merge: one commit wins, the other's is refused.
    await Promise.all([w.tracking.deps.observeMerge(TASK_ID, budget), w.tracking.deps.observeMerge(TASK_ID, budget)]);
    expect(w.ended).toHaveLength(1);
    // The row comes back (a wake, a restart) and the pass runs again: the task is over, nothing is recorded or told.
    await w.world.store.put({ item: { ...recoveryRowKey(TASK_ID), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
    await w.tracking.sweep();
    await w.tracking.deps.observeMerge(TASK_ID, budget);
    expect(w.ended).toHaveLength(1);
  });

  it("a host that did not take the first call is told again by the next end, with the same event", async () => {
    const w = await listening(1);
    mergeOnTheCodeHost(w);
    await w.tracking.sweep();
    // The merge is recorded all the same: a host's failure never fails it.
    expect((await readTask(w.h.deps, TASK_ID))!.workflow?.stage).toBe("MERGED");
    expect(w.ended).toHaveLength(1);
    expect((await w.world.store.get(taskEndKey(TASK_ID)))!["notifiedAt"]).toBeUndefined();
    await close(w);
    expect(w.ended).toHaveLength(2);
    expect(w.ended[1]).toEqual(w.ended[0]);
    await close(w);
    expect(w.ended).toHaveLength(2);
  });

  it("a host with no seam writes nothing", async () => {
    const w = await host();
    mergeOnTheCodeHost(w);
    await w.tracking.sweep();
    await close(w);
    expect(await w.world.store.get(taskEndKey(TASK_ID))).toBeUndefined();
  });
});
