// Spec 025 Task 10: reading and listing developer tasks (FR-016, FR-025, FR-036, R4, R18, FR-024, SC-004).
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEXT_STEPS } from "../../packages/mcp/src/index.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { taskView } from "../../packages/broker/src/aws/developer-tasks.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

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
      // The broker names what is wrong; the MCP server adds "run agentx_list_tasks" once, as its next step.
      expect((response.body.error as { message: string }).message).toBe(id === "not-a-task" ? "that is not a task ID of yours" : `no task ${id} of yours`);
      expect(NEXT_STEPS.TASK_NOT_FOUND).toContain("agentx_list_tasks");
    }
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

describe("artifacts are read only from the task's own workspace (R18)", () => {

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

  it("a closed task its counter still holds (an older record) is given back by a start that meets the limit, once", async () => {
    const harness = await createDeveloperTaskBroker();
    const ids: string[] = [];
    for (const title of ["one", "two", "three"]) {
      ids.push(((await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: title })).body.task as { taskId: string }).taskId);
    }
    const record = harness.db.get(`DEVTASK#${ids[0]}`, "META") as { charge: { member: { pk: string; sk: string }; organization: { pk: string; sk: string } } };
    harness.db.set({ ...record, closedAt: new Date().toISOString() });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "four" });
    const fourth = (started.body.task as { taskId: string }).taskId;
    const member = harness.db.get(record.charge.member.pk, record.charge.member.sk)!;
    expect({ count: member.count, tasks: [...(member.tasks as Set<string>)].sort() }).toEqual({ count: 3, tasks: [ids[1], ids[2], fourth].sort() });
    expect(harness.db.get(record.charge.organization.pk, record.charge.organization.sk)?.count).toBe(3);
    // The limit is reached again by open tasks: nothing more is given back.
    const refused = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "five" });
    expect(refused.body.error).toMatchObject({ code: "WORKSPACE_LIMIT" });
    expect(harness.db.get(record.charge.member.pk, record.charge.member.sk)?.count).toBe(3);
  });

});

describe("query parameters are plain whole numbers", () => {
  it.each(["1e1"])("refuses %j", async (value) => {
    const { read, dev } = await running();
    expect(((await read(`?events=${encodeURIComponent(value)}`)) as { error?: { code: string } }).error?.code).toBe("CONFIG_INVALID");
    expect(((await dev(MAYA, "GET", `/v1/dev/tasks?limit=${encodeURIComponent(value)}`)).body as { error?: { code: string } }).error?.code).toBe("CONFIG_INVALID");
  });
});

describe("the fake DynamoDB start key", () => {
  const table = () => {
    const db = new FakeDynamoDb();
    for (const sk of ["TASK#a", "TASK#b", "TASK#c", "ZZZ#d"]) db.set({ pk: "P", sk });
    return db;
  };
  const query = (db: FakeDynamoDb, start: Record<string, unknown>) => db.send({
    constructor: { name: "QueryCommand" },
    input: { KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": "P", ":prefix": "TASK#" }, ExclusiveStartKey: start },
  });
  it("resumes after a start key in range", async () => {
    expect(await query(table(), { pk: "P", sk: "TASK#a" })).toEqual({ Items: [{ pk: "P", sk: "TASK#b" }, { pk: "P", sk: "TASK#c" }] });
  });
  it.each([[{ pk: "P" }], [{ pk: "P", sk: "ZZZ#d" }], [{ pk: "Q", sk: "TASK#a" }]])("refuses %j like DynamoDB", async (start) => {
    await expect(query(table(), start)).rejects.toMatchObject({ name: "ValidationException" });
  });
});

describe("result details survive storage trouble (R18)", () => {
  it("answers the ended task without changed files, and still syncs the index, when the diff cannot be read", async () => {
    const harness = await createDeveloperTaskBroker();
    const task = await startRunning(harness, "my task");
    await harness.artifact(task.workspaceId, task.operationId, "workspace.diff", DIFF);
    await harness.finish(task.workspaceId, task.operationId, "SUCCEEDED");
    const original = harness.s3.send.getMockImplementation()!;
    harness.s3.send.mockImplementation(async (command) => {
      if (command.constructor.name === "GetObjectCommand") throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
      return original(command);
    });
    const response = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`);
    expect(response.status).toBe(200);
    const view = (response.body as { task: Record<string, unknown> }).task;
    expect(view).toMatchObject({ status: "SUCCEEDED", artifacts: [{ name: "workspace.diff" }] });
    expect(view).not.toHaveProperty("changedFiles");
    const { createdAt } = harness.db.get(`DEVTASK#${task.taskId}`, "META") as { createdAt: string };
    expect(harness.db.get(`DEVELOPER#${MAYA.developerId}`, `TASK#${createdAt}#${task.taskId}`)).toMatchObject({ status: "SUCCEEDED" });
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

// A People co-owner is still a viewer of the stored owner's money.
it("withholds legacy spend from real reader and co-owner roles while retaining the owner's spend", async () => {
 const h = await running(), companyId = "org_aaaaaaaaaaaaaaaaaaaa";
 const task = { ...h.db.get(`DEVTASK#${h.taskId}`, "META"), companyId, spentUsd: 28.4812, spentRuns: 1, workflow: { path: "FULL", decisions: [], artifacts: [], reviews: [], designReview: { status: "done", spentUsd: 2.83, capUsd: 17.43, estimateUsd: 3.91, rounds: [{ reviewers: [{ costUsd: 0.87 }] }], approvals: [{ kind: "spend", approvedUsd: 5.67 }, { kind: "raise_cap", fromUsd: 9.73, capUsd: 18.61 }], earlierReviews: [{ spentUsd: 1.81 }] } } } as unknown as Parameters<typeof taskView>[1];
 for (const [developerId, actor, visible] of [[MAYA.developerId, "owner", true], [OMAR.developerId, "viewer", false], [OMAR.developerId, "owner", false]] as const) {
  const caller = { ...MAYA, developerId, amr: "slack" as const };
  const deps = developerTaskRouteDependencies({ documentClient: h.db, tableName: "test", tasks: h.actions, now: Date.now, developer: { issuer: "https://example.test", signInTableName: "signin" }, companies: { membershipOf: async () => ({ companyId, role: "member" }) } } as unknown as Parameters<typeof developerTaskRouteDependencies>[0], caller);
  const view = await taskView(deps, task, { events: 0, details: false, actor });
  if (visible) expect(view).toMatchObject({ spent: { usd: 28.4812 }, workflow: { designReview: { spentUsd: 2.83 } } });
  else {
    expect(view).not.toHaveProperty("spent");
    // #1287: the view's timestamps are blanked first: "...01:57:01.815Z" contains 1.81. Any other text still counts, so a figure leaking as "$2.83" fails.
    const text = JSON.stringify(view).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/gu, "<time>");
    for (const figure of [28.4812, 2.83, 17.43, 3.91, 0.87, 5.67, 9.73, 18.61, 1.81]) expect(text).not.toContain(String(figure));
  }
 }
});

