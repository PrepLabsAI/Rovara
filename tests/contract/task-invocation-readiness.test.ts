// Spec 051 Task 3 (P-1, Review Focus 5): the task invocation carries the project's current readiness commands, so the
// worker can rerun them, and a payload from an older broker, without them, still parses.
import { randomUUID } from "node:crypto";
import { WorkerInvocationSchema } from "@agentx/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall, SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const user = "U0123456789";
const check = (args: string[]) => ({ cwd: "repo/demo", executable: "npm", args, timeoutSeconds: 300 });

beforeAll(loadSlackBroker);

async function taskInvocation(registrations: Array<{ revision: number; readiness: unknown[] }>, prepareAfter = 1) {
  const { handler, db } = createBroker();
  let workspaceId = "";
  for (const registration of registrations) {
    await registerSlackProject(handler, registration);
    if (registration.revision === prepareAfter) {
      const workspace = await ensureWorkspace(handler, thread, user);
      workspaceId = workspace.body.workspaceId as string;
      markReady(db, workspaceId);
    }
  }
  const conversation = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
  const conversationId = (conversation.body.conversation as { id: string }).id;
  const task = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
  expect(task.status).toBe(202);
  const operationId = (task.body.operation as { id: string }).id;
  return db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { payload: Record<string, unknown> };
}

describe("the task invocation's readiness (spec 051)", () => {
  it("carries the project's readiness commands", async () => {
    const invocation = await taskInvocation([{ revision: 1, readiness: [check(["test"])] }]);
    expect(invocation.payload.readiness).toEqual([check(["test"])]);
    expect(WorkerInvocationSchema.parse(invocation)).toMatchObject({ payload: { readiness: [check(["test"])] } });
  });

  // Ruling J: the latest revision's checks, which publication gates on. The worker gives a check that preparation did
  // not run, and no task has run since, no before result, so one that already fails is never the agent's regression.
  it("carries the latest revision's readiness, as publication does, for a workspace pinned to an older one", async () => {
    const invocation = await taskInvocation([
      { revision: 1, readiness: [check(["test"])] },
      { revision: 2, readiness: [check(["run", "lint"]), check(["test"])] },
    ]);
    expect(invocation.payload.readiness).toEqual([check(["run", "lint"]), check(["test"])]);
  });

  it("carries no readiness for a project without any, so the dispatcher need not ask the worker", async () => {
    const invocation = await taskInvocation([{ revision: 1, readiness: [] }]);
    expect(invocation.payload).not.toHaveProperty("readiness");
  });

  it("a payload from an older broker, without readiness, still parses", async () => {
    const invocation = await taskInvocation([{ revision: 1, readiness: [check(["test"])] }]);
    const older = { ...invocation, payload: { ...invocation.payload } };
    delete older.payload.readiness;
    const parsed = WorkerInvocationSchema.parse(older);
    expect(parsed.kind === "task" && parsed.payload.readiness).toBeUndefined();
  });

  it("refuses a readiness entry that is not a project command", () => {
    const base = {
      protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
      callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "x" },
    };
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, readiness: [check(["test"])] } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, readiness: [{ cwd: "../x", executable: "npm", args: [], timeoutSeconds: 1 }] } }).success).toBe(false);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, readiness: Array.from({ length: 65 }, () => check(["test"])) } }).success).toBe(false);
  });
});
