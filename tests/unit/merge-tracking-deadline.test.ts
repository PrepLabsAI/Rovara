import { expect, it, vi } from "vitest";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/merge-tracking.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { verifiedFilesKey } from "../../packages/broker/src/core/build-step/changed-files.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { host, ORG } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";

it("ends a stalled host read at the hard sweep deadline and never persists its late result", async () => {
  const w = await host();
  const flow = { ...w.h.deps, codeHosts: w.registry };
  const task = (await readTask(flow, TASK_ID))!;
  const location = await workspaceKeys(flow, task.workspaceId);
  const key = verifiedFilesKey(location.workspaceKey, task.workflow!.candidate!.digest);
  const remote = (await w.world.host.repository("web", 1, "app", ORG))!.codeHost;
  const read = remote.getChangeRequest.bind(remote);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(remote, "getChangeRequest").mockImplementation(async (...args) => {
    const result = await read(...args);
    entered();
    await gate;
    return result;
  });
  vi.useFakeTimers();
  let pending: Promise<unknown> | undefined;
  try {
    const tracking = createMergeTrackingService({ flow, registry: w.registry, companyId: ORG, people: w.people, settings: fixedCodeSettings(),
      milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), now: () => w.clock.ms });
    let finished = false;
    pending = tracking.sweep({ budgetMs: 1000 }).then(() => { finished = true; });
    await started;
    w.clock.ms += 16_000;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(finished).toBe(true);
    expect(await w.h.store.get(key)).toBeUndefined();
  } finally {
    release();
    await pending;
    vi.useRealTimers();
  }
  expect(await w.h.store.get(key)).toBeUndefined();
});
