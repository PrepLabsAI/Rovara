// tests/contract/shared-task-reread.test.ts
// 25c live-check note 1 (owner answer, 2026-09-30, option A): a shared task's channel turns and AI-tool
// turns keep separate sessions, so each turn on a shared task tells the agent to read a file again
// before it changes it. The line is added after the request hash, so a repeated requestId still matches.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SHARED_WORKSPACE_REREAD, hashJson } from "../../packages/broker/src/aws/broker-shared.js";
import { MAYA, createDeveloperTaskBroker, markThreadPosted, teammate } from "../support/developer-task-broker.js";

const PRIYA = "U0PRIYA001";
const LINE = "Other people also change this workspace between your turns. Read a file again before you change it.";

async function task(share: boolean) {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", {
    requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code",
    ...(share ? { shareToChannel: true, shareMode: "continue" } : {}),
  });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const meta = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; conversationId: string };
  const active = () => String((harness.db.get(`WORKSPACE#${meta.workspaceId}`, "META") as { activeOperationId: string | null }).activeOperationId);
  await harness.finish(meta.workspaceId, active(), "SUCCEEDED");
  await harness.finish(meta.workspaceId, active(), "SUCCEEDED");
  const prompt = () => {
    const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === active())[0];
    return (outbox?.invocation as { payload: { prompt: string } }).payload.prompt;
  };
  const cont = (body: Record<string, unknown>) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, body);
  return { ...harness, taskId, ...meta, active, prompt, cont };
}

describe("the re-read line on a shared task (25c note 1)", () => {
  it("is the fixed sentence the owner approved", () => {
    expect(SHARED_WORKSPACE_REREAD).toBe(LINE);
  });

  it("follows the developer's instructions on a shared task's continue", async () => {
    const h = await task(true);
    expect((await h.cont({ requestId: randomUUID(), instructions: "keep going" })).status).toBe(200);
    expect(h.prompt()).toBe(`keep going\n\n${LINE}`);
  });

  it("follows a teammate's request in the shared thread", async () => {
    const h = await task(true);
    const subject = markThreadPosted(h.db, h.taskId);
    const conversation = await teammate(h.handler, subject, PRIYA, "POST", `/v1/service/workspaces/${h.workspaceId}/conversations`, {});
    const conversationId = String((conversation.body.conversation as { id: string }).id);
    const accepted = await teammate(h.handler, subject, PRIYA, "POST", `/v1/service/workspaces/${h.workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "run the linter" });
    expect(accepted.status).toBe(202);
    expect(h.prompt()).toBe(`run the linter\n\n${LINE}`);
  });

  it("is not sent for a private task", async () => {
    const h = await task(false);
    await h.cont({ requestId: randomUUID(), instructions: "keep going" });
    expect(h.prompt()).toBe("keep going");
  });

  it("leaves the request hash alone, so a repeated requestId is the same request", async () => {
    const h = await task(true);
    const requestId = randomUUID();
    await h.cont({ requestId, instructions: "keep going" });
    const operationId = h.active();
    const expected = hashJson({ conversationId: h.conversationId, prompt: "keep going" });
    expect(h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ payloadHash: expected });
    expect(h.db.find((item) => item.entityType === "IDEMPOTENCY" && item.operationId === operationId)).toEqual([expect.objectContaining({ payloadHash: expected })]);
    const repeat = await h.cont({ requestId, instructions: "keep going" });
    expect(repeat.status).toBe(200);
    expect(h.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === h.workspaceId && item.kind === "task")).toHaveLength(2);
  });

  it("is left out when it would take the prompt past the worker's limit", async () => {
    const h = await task(true);
    const long = "x".repeat(65_536 - LINE.length - 1);
    expect((await h.cont({ requestId: randomUUID(), instructions: long })).status).toBe(200);
    expect(h.prompt()).toBe(long);
  });
});
