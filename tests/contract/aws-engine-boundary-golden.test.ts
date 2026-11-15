// Lane E2 golden: with the core switch off and no core task on the table, every AWS developer route answers byte for byte as it did before the engine boundary, and writes the same
// rows. The boundary is switched out here (every owner question answers "workflow" without reading anything), which is exactly the code before it; each request is then made with it
// in and out on the same table, and the answers and writes compared whole.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import type * as Boundary from "../../packages/broker/src/aws/engine-boundary.js";

const bypass = vi.hoisted(() => ({ on: false }));
vi.mock("../../packages/broker/src/aws/engine-boundary.js", async (importOriginal) => {
  const real = await importOriginal<typeof Boundary>();
  return {
    ...real,
    ownerOfTaskId: async (...args: Parameters<typeof real.ownerOfTaskId>) => (bypass.on ? "workflow" : await real.ownerOfTaskId(...args)),
    ownerOfExistingTask: async (...args: Parameters<typeof real.ownerOfExistingTask>) => (bypass.on ? "workflow" : await real.ownerOfExistingTask(...args)),
    ownerOfWorkspace: async (...args: Parameters<typeof real.ownerOfWorkspace>) => (bypass.on ? "workflow" : await real.ownerOfWorkspace(...args)),
  };
});

beforeAll(async () => { await loadSlackBroker(); });

const DIFF = ["## demo", "", "### status", " M src/retry.ts", "### diff", "diff --git a/src/retry.ts b/src/retry.ts", "--- a/src/retry.ts", "+++ b/src/retry.ts", "@@ -1 +1,2 @@", "-old", "+new", "+more", ""].join("\n");

async function finishedTask() {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  const active = () => String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await harness.finish(workspaceId, active(), "SUCCEEDED");
  const operationId = active();
  await harness.events(workspaceId, operationId, [{ type: "lifecycle", payload: { status: "RUNNING" } }, { type: "progress", payload: { message: "step 1" } }]);
  await harness.artifact(workspaceId, operationId, "workspace.diff", DIFF);
  await harness.finish(workspaceId, operationId, "SUCCEEDED");
  return { ...harness, taskId, workspaceId };
}

/** The broker stamps each answer with its own request id (a fresh one per request); everything else is compared byte for byte. */
const withoutRequestId = (text: string) => text.replace(/"requestId":"[0-9a-f-]{36}"/gu, "\"requestId\":\"<request>\"");

/** One request with the boundary out, then in, on the same table: the answers and the writes each made. Reads that settle state first are made once before. */
async function both<T>(db: { onWrite(listener: (change: unknown) => void): () => void }, request: () => Promise<T>) {
  bypass.on = true;
  await request();
  const run = async (on: boolean) => {
    bypass.on = on;
    const writes: string[] = [];
    const stop = db.onWrite((change) => writes.push(JSON.stringify(change)));
    try { return { answer: withoutRequestId(JSON.stringify(await request()) ?? "undefined"), writes }; } finally { stop(); bypass.on = false; }
  };
  const before = await run(true);
  const after = await run(false);
  return { before, after };
}

describe("no core task, switch off: the AWS developer routes are byte-identical to before the boundary", () => {
  it("task read, events, plan, people, list, and a stranger's and a malformed id's refusals", async () => {
    const { dev, db, taskId } = await finishedTask();
    const missingId = randomUUID();
    const requests: Array<[string, () => Promise<unknown>]> = [
      ["read", () => dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)],
      ["read events=3", () => dev(MAYA, "GET", `/v1/dev/tasks/${taskId}?events=3`)],
      ["events", () => dev(MAYA, "GET", `/v1/dev/tasks/${taskId}/events?limit=5`)],
      ["plan", () => dev(MAYA, "GET", `/v1/dev/tasks/${taskId}/plan`)],
      ["people", () => dev(MAYA, "GET", `/v1/dev/tasks/${taskId}/people`)],
      ["readers", () => dev(MAYA, "GET", `/v1/dev/tasks/${taskId}/readers`)],
      ["list", () => dev(MAYA, "GET", "/v1/dev/tasks")],
      ["list RUNNING", () => dev(MAYA, "GET", "/v1/dev/tasks?status=RUNNING&limit=1")],
      ["stranger", () => dev(OMAR, "GET", `/v1/dev/tasks/${taskId}`)],
      ["missing", () => dev(MAYA, "GET", `/v1/dev/tasks/${missingId}`)],
      ["malformed", () => dev(MAYA, "GET", "/v1/dev/tasks/not-a-task")],
      ["unknown suffix", () => dev(MAYA, "GET", `/v1/dev/tasks/${taskId}/nope`)],
    ];
    for (const [name, request] of requests) {
      const { before, after } = await both(db, request);
      expect(after.answer, name).toBe(before.answer);
      expect(after.writes, name).toEqual(before.writes);
    }
  });

  it("an action on the task (close) answers and writes the same", async () => {
    const first = await finishedTask();
    const second = await finishedTask();
    bypass.on = true;
    const beforeWrites: string[] = [];
    const stopBefore = first.db.onWrite((change) => beforeWrites.push(Object.keys(change).join()));
    const before = await first.dev(MAYA, "POST", `/v1/dev/tasks/${first.taskId}/close`, { requestId: "11111111-1111-4111-8111-111111111111" });
    stopBefore();
    bypass.on = false;
    const afterWrites: string[] = [];
    const stopAfter = second.db.onWrite((change) => afterWrites.push(Object.keys(change).join()));
    const after = await second.dev(MAYA, "POST", `/v1/dev/tasks/${second.taskId}/close`, { requestId: "11111111-1111-4111-8111-111111111111" });
    stopAfter();
    const scrub = (value: unknown, ...ids: string[]) => ids.reduce((text, id) => text.replaceAll(id, "<id>"), withoutRequestId(JSON.stringify(value))).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, "<time>");
    expect(scrub(after, second.taskId, second.workspaceId)).toBe(scrub(before, first.taskId, first.workspaceId));
    expect(afterWrites).toEqual(beforeWrites);
  });

  it("the task actions answer a workflow workspace the same", async () => {
    const { actions, db, workspaceId } = await finishedTask();
    for (const [name, request] of [
      ["workspace", () => actions.workspace(workspaceId)], ["operations", () => actions.operations(workspaceId)], ["pull requests", () => actions.pullRequests(workspaceId)],
      ["artifacts", async () => actions.artifacts(workspaceId, (await actions.operations(workspaceId)).at(-1)!.id)],
      ["workflow binding", async () => actions.workflowBinding(workspaceId, (await actions.operations(workspaceId)).at(-1)!.id)],
      ["candidate digest", async () => actions.workflowCandidateSourceExportDigest(workspaceId, (await actions.operations(workspaceId)).at(-1)!.id)],
      ["missing operation", async () => actions.workflowBinding(workspaceId, "missing-operation").catch((error: unknown) => String(error))],
    ] as Array<[string, () => Promise<unknown>]>) {
      const { before, after } = await both(db, request);
      expect(after.answer, name).toBe(before.answer);
      expect(after.writes, name).toEqual(before.writes);
    }
  });
});
