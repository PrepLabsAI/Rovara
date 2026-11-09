// Lane L6a: the same flow on the local adapters (L3): a SQLite document store and a SQLite queue in one file, as `rovara up` will wire them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDocumentStore, SqliteQueueService } from "../../packages/local-adapters/src/index.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the task flow on the SQLite store and queue", () => {
  it("starts a task, dispatches its preparation to a fake worker machine and moves it to Understand, with every record in the file", async () => {
    const folder = await mkdtemp(join(tmpdir(), "task-flow-"));
    const path = join(folder, "state.db");
    const h = createHarness({
      understandFirst: true,
      backend: (clock) => {
        const store = SqliteDocumentStore.open({ path, indexes: TASK_FLOW_INDEXES, sweepIntervalMs: 0, changeFeed: false });
        const queues = SqliteQueueService.open({ path, now: () => clock.now });
        cleanups.push(async () => { await queues.close(); await store.close(); await rm(folder, { recursive: true, force: true }); });
        return { store, queues };
      },
    });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a /health endpoint", workflow: true });
    expect(await h.flow.dispatchOnce()).toMatchObject({ retried: 1 });
    h.clock.advance(70);
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
    const [prepare] = h.machines.delivered(workspace.machine!.machineId);
    expect(prepare).toMatchObject({ kind: "prepare" });
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare!.operationId, fence: 1, status: "SUCCEEDED" });
    h.clock.advance(1);
    expect((await h.flow.get(h.owner, started.task.taskId)).workflow).toMatchObject({ stage: "UNDERSTAND", state: "RUNNING" });
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    expect((await h.flow.list(h.owner)).tasks).toHaveLength(1);
  });
});
