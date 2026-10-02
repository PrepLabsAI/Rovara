// #154: the worker's setup error is redacted when the broker takes it in, before it is stored.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

const TOKEN = `ghp_${"Z9y8X7w6V5".repeat(4)}`;

async function startedTask() {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky test", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const workspaceId = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const prepareId = String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  return { ...harness, taskId, workspaceId, prepareId };
}

describe("a worker's setup error at the broker (#154)", () => {
  it("is stored redacted, so a token in setup stderr never reaches the State table or the task view", async () => {
    const { db, dev, finish, taskId, workspaceId, prepareId } = await startedTask();
    const raw = `setup step 0 (npm ci in repo/app) exited 1\nLast lines:\nnpm ERR! 401 Unauthorized: token ${TOKEN}`;
    await finish(workspaceId, prepareId, "FAILED", { error: raw });

    const stored = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`) as { error: string };
    expect(stored.error).toBe("setup step 0 (npm ci in repo/app) exited 1\nLast lines:\nnpm ERR! 401 Unauthorized: token [REDACTED]");
    expect(JSON.stringify(db.find(() => true))).not.toContain(TOKEN.slice(0, 12));

    const view = (await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body;
    expect(view).toMatchObject({ task: { status: "FAILED", failure: { category: "setup_failed", message: stored.error } } });
    expect(JSON.stringify(view)).not.toContain(TOKEN.slice(0, 12));
  });

  afterEach(() => { vi.useRealTimers(); });

  it("moves the task's updated_at to when setup failed, and records the failure as an event (#225)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T19:05:51.000Z"));
    const { dev, finish, taskId, workspaceId, prepareId } = await startedTask();
    vi.setSystemTime(new Date("2026-10-01T19:07:30.000Z"));
    const error = "setup step 0 (sh -c echo npm ci failed; exit 1 in repo/the-mentor-test) exited 1\nLast lines:\nnpm ci failed";
    await finish(workspaceId, prepareId, "FAILED", { error });

    const view = (await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body as { task: { createdAt: string; updatedAt: string; failure: { message: string }; events: Array<{ at: string; kind: string; text: string }> } };
    expect(view.task.createdAt).toBe("2026-10-01T19:05:51.000Z");
    expect(view.task.updatedAt).toBe("2026-10-01T19:07:30.000Z");
    expect(view.task.failure.message).toBe(error);
    expect(view.task.events).toEqual([{ at: "2026-10-01T19:07:30.000Z", kind: "error", text: "Workspace setup failed: setup step 0 (sh -c echo npm ci failed; exit 1 in repo/the-mentor-test) exited 1" }]);

    // The task list agrees with the view.
    const list = (await dev(MAYA, "GET", "/v1/dev/tasks")).body as { tasks: Array<{ taskId: string; updatedAt: string }> };
    expect(list.tasks.find((task) => task.taskId === taskId)?.updatedAt).toBe("2026-10-01T19:07:30.000Z");
  });

  it("records the failure event once when the worker sends the same result again (#225)", async () => {
    const { dev, finish, taskId, workspaceId, prepareId } = await startedTask();
    await finish(workspaceId, prepareId, "FAILED", { error: "setup step 0 (npm ci in repo/app) exited 1" });
    await finish(workspaceId, prepareId, "FAILED", { error: "setup step 0 (npm ci in repo/app) exited 1" });
    const view = (await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body as { task: { events: unknown[] } };
    expect(view.task.events).toHaveLength(1);
  });
});
