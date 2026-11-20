import { expect, it, vi } from "vitest";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/merge-tracking.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { RISK_UNVERIFIED_REASON, verifiedFilesKey } from "../../packages/broker/src/core/build-step/changed-files.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { host, ORG } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";

async function world() {
  const w = await host();
  const logs: Record<string, unknown>[] = [];
  const flow = { ...w.h.deps, codeHosts: w.registry, log: (entry: Record<string, unknown>) => logs.push(entry) };
  const task = (await readTask(flow, TASK_ID))!;
  await w.world.setWorkflow({ risk: { level: "high", reasons: [RISK_UNVERIFIED_REASON], candidateDigest: task.workflow!.candidate!.digest } });
  const location = await workspaceKeys(flow, task.workspaceId);
  const key = verifiedFilesKey(location.workspaceKey, task.workflow!.candidate!.digest);
  const remote = (await w.world.host.repository("web", 1, "app", ORG))!.codeHost;
  const tracking = createMergeTrackingService({
    flow, registry: w.registry, companyId: ORG, people: w.people, settings: fixedCodeSettings(),
    milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), now: () => w.clock.ms,
  });
  return { ...w, flow, logs, key, remote, tracking };
}

it("verifies a one-file PR even when selecting its due row spends all sweep time", async () => {
  const w = await world();
  const otherId = "22222222-2222-4222-8222-222222222222";
  const own = (await w.h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: "META" }))!;
  await w.h.store.put({ item: { ...own, pk: `DEVTASK#${otherId}`, taskId: otherId } });
  await w.h.store.put({ item: { ...recoveryRowKey(otherId), kind: "tracking", taskId: otherId, nextAttemptAt: 0 } });
  const otherBefore = await w.h.store.get(recoveryRowKey(otherId));
  const get = w.h.store.get.bind(w.h.store);
  let spent = false;
  vi.spyOn(w.h.store, "get").mockImplementation(async (key) => {
    const row = await get(key);
    if (!spent && key.pk === `DEVTASK#${TASK_ID}` && key.sk === "META") { spent = true; w.clock.ms += 1000; }
    return row;
  });
  const observation = vi.spyOn(w.remote, "mergeObservation");
  expect(await w.tracking.sweep({ budgetMs: 1000 })).toEqual({ attempted: 1 });
  expect(await w.h.store.get(w.key)).toMatchObject({ complete: true, files: [expect.objectContaining({ path: "src/a.ts" })] });
  expect((await readTask(w.flow, TASK_ID))!.workflow!.risk!.reasons).not.toContain(RISK_UNVERIFIED_REASON);
  // Its own allowance never gives reconciliation extra reads or lets a second due row run.
  expect(observation).not.toHaveBeenCalled();
  expect(await w.h.store.get(recoveryRowKey(otherId))).toEqual(otherBefore);
  expect(w.logs.filter((entry) => entry["event"] === "build_step.changed_files_unavailable")).toEqual([]);
});

it("can verify a root README within its own allowance, including the instruction and docs-site probes", async () => {
  const w = await world();
  vi.spyOn(w.remote, "changedFiles").mockResolvedValue({ files: [{ path: "README.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n Hello\n+Tested." }] });
  await w.tracking.sweep();
  expect(await w.h.store.get(w.key)).toMatchObject({ complete: true, files: [expect.objectContaining({ path: "README.md" })] });
});

it.each(["time", "requests"] as const)("keeps unverified risk and reports actual usage when the verification %s allowance runs out", async (limit) => {
  const w = await world();
  const read = w.remote.getChangeRequest.bind(w.remote);
  const started = w.clock.ms;
  vi.spyOn(w.remote, "getChangeRequest").mockImplementation(async (...args) => {
    const result = await read(...args);
    if (limit === "time") w.clock.ms += 15_000;
    return result;
  });
  if (limit === "requests") {
    vi.spyOn(w.remote, "changedFiles").mockResolvedValue({ files: Array.from({ length: 40 }, (_, i) => ({ path: `docs/part${i}/guide.md`, status: "modified" as const, additions: 1, deletions: 0 })) });
  }
  const files = vi.spyOn(w.remote, "changedFiles");
  await w.tracking.sweep({ budgetMs: 1000 });
  expect(await w.h.store.get(w.key)).toBeUndefined();
  expect((await readTask(w.flow, TASK_ID))!.workflow!.risk).toMatchObject({ level: "high", reasons: [RISK_UNVERIFIED_REASON] });
  const unavailable = w.logs.filter((entry) => entry["event"] === "build_step.changed_files_unavailable");
  expect(unavailable).toEqual([expect.objectContaining({ error: "GithubBudgetExhaustedError", ms: w.clock.ms - started, requests: limit === "time" ? 1 : 128 })]);
  if (limit === "time") expect(files).not.toHaveBeenCalled();
  const recovery = await w.h.store.get(recoveryRowKey(TASK_ID));
  expect(recovery?.["nextAttemptAt"]).toBeGreaterThan(w.clock.ms);
});
