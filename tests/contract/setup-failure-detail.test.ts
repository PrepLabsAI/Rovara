// #154: the worker's setup error is redacted when the broker takes it in, before it is stored.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
});
