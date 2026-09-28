// Spec 025 Task 10: reading and listing developer tasks (FR-016, FR-025, FR-036, R4, R18, FR-024, SC-004).
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";

const PLANTED = "xoxb-2222222222-planted-secret";
const DIFF = ["## demo", "", "### status", " M src/retry.ts", "### diff", "diff --git a/src/retry.ts b/src/retry.ts", "--- a/src/retry.ts", "+++ b/src/retry.ts", "@@ -1 +1,2 @@", "-old", "+new", "+more"].join("\n");

async function running() {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await harness.finish(workspaceId, prepareId, "SUCCEEDED");
  const operationId = String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const read = async (query = "") => (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}${query}`)).body;
  return { ...harness, taskId, workspaceId, prepareId, operationId, read };
}

describe("GET /v1/dev/tasks/{taskId} (FR-016, FR-025)", () => {
  it("follows the task from STARTING to SUCCEEDED, with progress, then the summary, changed files and artifacts", async () => {
    const { read, events, artifact, finish, workspaceId, operationId } = await running();
    await events(workspaceId, operationId, [
      { type: "lifecycle", payload: { status: "RUNNING" } },
      { type: "tool_start", payload: { type: "tool_execution_start", toolName: "bash" } },
    ]);
    expect(await read()).toMatchObject({ task: { status: "RUNNING", events: [{ kind: "status" }, { kind: "tool", text: "Started bash" }] } });
    await events(workspaceId, operationId, [{ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The retry test waits on a real clock. I faked it; all 212 tests pass." }] } } }]);
    await artifact(workspaceId, operationId, "workspace.diff", DIFF);
    await finish(workspaceId, operationId, "SUCCEEDED");
    const { task } = await read() as { task: Record<string, unknown> };
    expect(task).toMatchObject({
      status: "SUCCEEDED",
      summary: "The retry test waits on a real clock. I faked it; all 212 tests pass.",
      changedFiles: [{ repository: "demo", path: "src/retry.ts", added: 2, removed: 1 }],
      artifacts: [{ name: "workspace.diff", size: Buffer.byteLength(DIFF) }],
    });
    expect(task).not.toHaveProperty("failure");
  });

  it("returns only as many events as asked, and none for events=0", async () => {
    const { read, events, workspaceId, operationId } = await running();
    await events(workspaceId, operationId, Array.from({ length: 5 }, (_, index) => ({ type: "progress", payload: { message: `step ${index}` } })));
    expect(((await read("?events=2")) as { task: { events: Array<{ text: string }> } }).task.events.map((entry) => entry.text)).toEqual(["step 3", "step 4"]);
    expect(((await read("?events=0")) as { task: { events: unknown[] } }).task.events).toEqual([]);
    expect(((await read("?events=51")) as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
  });

  it("gives a failed task its category and redacted message, and an interrupted one interrupted", async () => {
    const first = await running();
    await first.finish(first.workspaceId, first.operationId, "FAILED", { error: `tests failed near ${PLANTED}` });
    const failed = (await first.read()) as { task: { status: string; failure: { category: string; message: string } } };
    expect(failed.task).toMatchObject({ status: "FAILED", failure: { category: "task_failed" } });
    expect(JSON.stringify(failed)).not.toContain(PLANTED);
    const second = await running();
    await second.finish(second.workspaceId, second.operationId, "INTERRUPTED", { error: "worker process lost" });
    expect(((await second.read()) as { task: { failure: { category: string } } }).task.failure.category).toBe("interrupted");
  });

  it("answers TASK_NOT_FOUND to another developer and for a malformed ID (FR-036)", async () => {
    const { dev, taskId } = await running();
    for (const [who, id] of [[OMAR, taskId], [MAYA, "not-a-task"], [MAYA, randomUUID()]] as const) {
      const response = await dev(who, "GET", `/v1/dev/tasks/${id}`);
      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(String((response.body.error as { message: string }).message)).toContain("agentx_list_tasks");
    }
  });

  it("never returns a planted secret from events, the summary, artifact names or errors (SC-004)", async () => {
    const { read, events, artifact, finish, workspaceId, operationId } = await running();
    await events(workspaceId, operationId, [
      { type: "progress", payload: { message: `export SLACK=${PLANTED}` } },
      { type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `done, token ${PLANTED}` }] } } },
      { type: "error", payload: { message: `warning ${PLANTED}` } },
    ]);
    await artifact(workspaceId, operationId, `notes-${PLANTED}.txt`, "x");
    await finish(workspaceId, operationId, "SUCCEEDED");
    expect(JSON.stringify(await read("?events=50"))).not.toContain(PLANTED);
  });
});

describe("GET /v1/dev/tasks (FR-016)", () => {
  it("lists only the caller's tasks, newest first, with filters and a limit, and refreshes live statuses", async () => {
    const harness = await createDeveloperTaskBroker({ memberLimit: 5 });
    const ids: string[] = [];
    for (const title of ["one", "two", "three"]) {
      const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: title });
      ids.push((response.body.task as { taskId: string }).taskId);
      // Distinct createdAt values, so "newest first" has one answer.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const first = harness.db.get(`DEVTASK#${ids[0]}`, "META") as { workspaceId: string; createdAt: string };
    const prepareId = String((harness.db.get(`WORKSPACE#${first.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await harness.finish(first.workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });

    const all = (await harness.dev(MAYA, "GET", "/v1/dev/tasks")).body as { tasks: Array<{ taskId: string; title: string; status: string }> };
    expect(all.tasks.map((task) => task.title)).toEqual(["three", "two", "one"]);
    expect(all.tasks.find((task) => task.taskId === ids[0])?.status).toBe("FAILED");
    expect(harness.db.get(`DEVELOPER#${MAYA.developerId}`, `TASK#${first.createdAt}#${ids[0]}`)).toMatchObject({ status: "FAILED" });
    expect(((await harness.dev(MAYA, "GET", "/v1/dev/tasks?status=FAILED")).body as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect(((await harness.dev(MAYA, "GET", "/v1/dev/tasks?project=other")).body as { tasks: unknown[] }).tasks).toHaveLength(0);
    expect(((await harness.dev(MAYA, "GET", "/v1/dev/tasks?limit=2")).body as { tasks: unknown[] }).tasks).toHaveLength(2);
    expect(((await harness.dev(OMAR, "GET", "/v1/dev/tasks")).body as { tasks: unknown[] }).tasks).toHaveLength(0);
    expect(((await harness.dev(MAYA, "GET", "/v1/dev/tasks?limit=0")).body as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
  });
});

describe("GET /v1/dev/tasks/{taskId}/events", () => {
  it("returns the latest readable events of the current operation", async () => {
    const { dev, events, taskId, workspaceId, operationId } = await running();
    await events(workspaceId, operationId, [{ type: "progress", payload: { message: "a" } }, { type: "progress", payload: { message: "b" } }]);
    expect(((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}/events?limit=1`)).body as { events: Array<{ text: string }> }).events.map((entry) => entry.text)).toEqual(["b"]);
  });
});

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

/** Starts a task for Maya in an existing harness and runs its prepare, so its task operation is active. */
async function startRunning(harness: Harness, instructions: string) {
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await harness.finish(workspaceId, prepareId, "SUCCEEDED");
  const operationId = String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  return { taskId, workspaceId, operationId };
}

const getKeys = (harness: Harness) => harness.s3.send.mock.calls
  .map(([command]) => command)
  .filter((command) => command.constructor.name === "GetObjectCommand")
  .map((command) => command.input.Key);

describe("reads of an owned task (R8, R11, FR-036)", () => {
  it("does not recheck project access to read the developer's own task", async () => {
    const { read, channelMembers, channelInfo } = await running();
    const before = channelMembers.mock.calls.length + channelInfo.mock.calls.length;
    channelMembers.mockImplementation(async () => ({ ok: true, memberOf: [] }));
    expect(await read()).toMatchObject({ task: { status: "RUNNING" } });
    expect(channelMembers.mock.calls.length + channelInfo.mock.calls.length).toBe(before);
  });

  it("answers TASK_NOT_FOUND on the events route to another developer", async () => {
    const { dev, taskId } = await running();
    const response = await dev(OMAR, "GET", `/v1/dev/tasks/${taskId}/events`);
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(JSON.stringify(response.body)).not.toContain("payments");
  });
});

describe("artifacts are read only from the task's own workspace (R18)", () => {
  it("never reads a diff through a crafted artifact name", async () => {
    const harness = await createDeveloperTaskBroker();
    const other = await startRunning(harness, "the other task");
    await harness.artifact(other.workspaceId, other.operationId, "workspace.diff", DIFF);
    const mine = await startRunning(harness, "my task");
    for (const name of [`../../${other.workspaceId}/${other.operationId}/workspace.diff`, "../workspace.diff", "workspace.diff/../../x", "workspace.diff\u0000"]) {
      await harness.artifact(mine.workspaceId, mine.operationId, name, "not a diff");
    }
    await harness.finish(mine.workspaceId, mine.operationId, "SUCCEEDED");
    harness.s3.send.mockClear();
    const { task } = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${mine.taskId}`)).body as { task: Record<string, unknown> };
    expect(task.status).toBe("SUCCEEDED");
    expect(task).not.toHaveProperty("changedFiles");
    expect(getKeys(harness)).toEqual([]);
  });

  it("refuses an artifact record whose object key points into another workspace", async () => {
    const harness = await createDeveloperTaskBroker();
    const other = await startRunning(harness, "the other task");
    await harness.artifact(other.workspaceId, other.operationId, "workspace.diff", DIFF);
    const otherKey = String(harness.db.find((item) => item.entityType === "ARTIFACT" && item.workspaceId === other.workspaceId)[0]?.objectKey);
    const mine = await startRunning(harness, "my task");
    const owner = String((harness.db.get(`DEVTASK#${mine.taskId}`, "META") as { ownerKey: string }).ownerKey);
    // A record naming the diff, with a key into the other workspace, or climbing out of this one.
    for (const [index, objectKey] of [otherKey, `private/${owner}/${mine.workspaceId}/${mine.operationId}/../../${other.workspaceId}/${other.operationId}/x`].entries()) {
      harness.db.set({
        pk: `WORKSPACE#${mine.workspaceId}`, sk: `ARTIFACT#forged-${index}`, entityType: "ARTIFACT", id: `forged-${index}`, workspaceId: mine.workspaceId,
        operationId: mine.operationId, ownerKey: owner, name: "workspace.diff", mediaType: "text/plain", objectKey, size: 1, createdAt: new Date().toISOString(),
      });
    }
    await harness.finish(mine.workspaceId, mine.operationId, "SUCCEEDED");
    harness.s3.send.mockClear();
    const { task } = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${mine.taskId}`)).body as { task: Record<string, unknown> };
    expect(task.status).toBe("SUCCEEDED");
    expect(task).not.toHaveProperty("changedFiles");
    expect(getKeys(harness)).toEqual([]);
  });
});

describe("the index row follows the task (R4)", () => {
  it("records a read status in the index, so WORKSPACE_LIMIT stops listing a closed task", async () => {
    const harness = await createDeveloperTaskBroker();
    const ids: string[] = [];
    for (const title of ["one", "two", "three"]) {
      ids.push(((await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: title })).body.task as { taskId: string }).taskId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const limited = async () => {
      const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "four" });
      expect(response.body.error).toMatchObject({ code: "WORKSPACE_LIMIT" });
      return String((response.body.error as { message: string }).message);
    };
    expect(await limited()).toContain(ids[0]);
    const record = harness.db.get(`DEVTASK#${ids[0]}`, "META") as { createdAt: string };
    harness.db.set({ ...record, closedAt: new Date().toISOString() });
    expect(((await harness.dev(MAYA, "GET", `/v1/dev/tasks/${ids[0]}`)).body.task as { status: string }).status).toBe("CLOSED");
    expect(harness.db.get(`DEVELOPER#${MAYA.developerId}`, `TASK#${record.createdAt}#${ids[0]}`)).toMatchObject({ status: "CLOSED" });
    const message = await limited();
    expect(message).not.toContain(ids[0]);
    expect(message).toContain(ids[1]);
    expect(message).toContain(ids[2]);
  });

  it("writes a failed prepare's status to the index on a read of the task", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "one" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const record = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; createdAt: string };
    const prepareId = String((harness.db.get(`WORKSPACE#${record.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await harness.finish(record.workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    expect(harness.db.get(`DEVELOPER#${MAYA.developerId}`, `TASK#${record.createdAt}#${taskId}`)).toMatchObject({ status: "STARTING" });
    expect(((await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string }).status).toBe("FAILED");
    expect(harness.db.get(`DEVELOPER#${MAYA.developerId}`, `TASK#${record.createdAt}#${taskId}`)).toMatchObject({ status: "FAILED" });
  });
});

describe("the task list's cursor", () => {
  async function three() {
    const harness = await createDeveloperTaskBroker({ memberLimit: 5 });
    const ids: string[] = [];
    for (const title of ["one", "two", "three"]) {
      ids.push(((await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: title })).body.task as { taskId: string }).taskId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const list = async (who: typeof MAYA, query: string) => (await harness.dev(who, "GET", `/v1/dev/tasks${query}`)).body as { tasks?: Array<{ title: string }>; nextCursor?: string; error?: { code: string } };
    return { ...harness, ids, list };
  }

  it("pages through the caller's tasks, newest first, and ends without a cursor", async () => {
    const { list } = await three();
    const first = await list(MAYA, "?limit=2");
    expect(first.tasks?.map((task) => task.title)).toEqual(["three", "two"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await list(MAYA, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.tasks?.map((task) => task.title)).toEqual(["one"]);
    expect(second).not.toHaveProperty("nextCursor");
    expect(await list(MAYA, "?limit=3")).not.toHaveProperty("nextCursor");
  });

  it("never lists another developer's tasks through a cursor", async () => {
    const { list, db, ids } = await three();
    const first = await list(MAYA, "?limit=1");
    expect(await list(OMAR, `?cursor=${encodeURIComponent(first.nextCursor!)}`)).toMatchObject({ tasks: [] });
    const { createdAt } = db.get(`DEVTASK#${ids[2]}`, "META") as { createdAt: string };
    const forged = (value: unknown) => encodeURIComponent(Buffer.from(JSON.stringify(value)).toString("base64url"));
    const copied = await list(OMAR, `?cursor=${forged({ sk: `TASK#${createdAt}#${ids[2]}` })}`);
    expect(copied).toMatchObject({ tasks: [] });
    expect(copied).not.toHaveProperty("nextCursor");
    for (const cursor of [forged({ pk: `DEVELOPER#${MAYA.developerId}`, sk: `TASK#${createdAt}#${ids[2]}` }), forged({ sk: "META" }), forged("x"), "not base64 !", "x".repeat(600)]) {
      const response = await list(OMAR, `?cursor=${cursor}`);
      expect(response.error?.code, cursor).toBe("CONFIG_INVALID");
      expect(JSON.stringify(response)).not.toMatch(/one|two|three/);
    }
  });
});

describe("no developer task code reads the deployment mode (FR-024)", () => {
  const files = (path: string): string[] => statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => files(join(path, name))) : path.endsWith(".ts") ? [path] : [];
  it.each([
    "packages/broker/src/aws/developer-tasks.ts",
    "packages/broker/src/aws/developer-task-actions.ts",
    "packages/broker/src/developer/task-records.ts",
    "packages/broker/src/developer/limits.ts",
  ])("%s", (path) => {
    expect(readFileSync(path, "utf8")).not.toMatch(/deploymentMode|ec2-ebs|agentcore/i);
  });
  it.skipIf(!existsSync("packages/mcp/src"))("the MCP package", () => {
    for (const path of files("packages/mcp/src")) expect(readFileSync(path, "utf8"), path).not.toMatch(/deploymentMode|ec2-ebs|agentcore/i);
  });
});
