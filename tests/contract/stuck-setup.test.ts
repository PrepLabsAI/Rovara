// tests/contract/stuck-setup.test.ts
// Spec 025 FR-055, D21, C17, C18: a developer task's setup is failed 50 minutes after it started.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STUCK_SETUP_MESSAGE, STUCK_SETUP_MS, sweepStuckSetups } from "../../packages/broker/src/aws/stuck-setup.js";
import { noticesFromStream } from "../../packages/broker/src/developer/notifications.js";
import { MAYA, createDeveloperTaskBroker, recordStream } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";

const INSTRUCTIONS = "Fix it PLANTED-INSTRUCTIONS-5c1e";

async function starting(body: Record<string, unknown> = {}) {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: INSTRUCTIONS, client: "claude-code", ...body });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const workspaceId = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const prepareId = String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const watches = () => harness.db.find((item) => item.pk === "SETUP_WATCH");
  const minutesLater = (minutes: number) => new Date(Date.now() + minutes * 60_000);
  const logs: Array<Record<string, unknown>> = [];
  const sweepAt = (at: Date) => sweepStuckSetups(harness.db, "state", at, (entry) => { logs.push(entry); });
  const sweep = (minutes: number) => sweepAt(minutesLater(minutes));
  return { ...harness, taskId, workspaceId, prepareId, watches, sweep, sweepAt, minutesLater, logs };
}

describe("the setup watch (C17)", () => {

  it("is 50 minutes, as the owner decided", () => {
    expect(STUCK_SETUP_MS).toBe(3_000_000);
    expect(STUCK_SETUP_MESSAGE).toBe("setup did not finish within 50 minutes; close this task and start a new one");
  });
});

describe("the sweep (FR-055)", () => {

  it("gives a shared task's thread the setup-failed notice, stamped with the sweep's time (F7)", async () => {
    const { db, sweepAt, minutesLater, workspaceId, prepareId } = await starting({ shareToChannel: true });
    const stream = recordStream(db);
    const at = minutesLater(51);
    await sweepAt(at);
    expect(noticesFromStream(stream.take())).toEqual([expect.objectContaining({ kind: "setup_failed", workspaceId, operationId: prepareId, at: at.toISOString() })]);
  });

  it("lets a result that lands during the sweep win, and drops the watch on the next run", async () => {
    const { db, sweep, workspaceId, prepareId, watches, finish } = await starting();
    const original = db.send;
    let raced = false;
    db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes(STUCK_SETUP_MESSAGE)) {
        raced = true;
        db.send = original;
        await finish(workspaceId, prepareId, "SUCCEEDED");
      }
      return original(command);
    };
    expect(await sweep(51)).toEqual({ failed: [], dropped: 0, kept: 1 });
    expect(raced).toBe(true);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(watches()).toHaveLength(1);
    expect(await sweep(52)).toEqual({ failed: [], dropped: 1, kept: 0 });
    expect(watches()).toEqual([]);
  });

  it("answers a late SUCCEEDED result for a swept prepare and queues nothing (Review Focus 4)", async () => {
    const { db, sweep, handler, dev, taskId, workspaceId, prepareId } = await starting();
    await sweep(51);
    // Final review M9: the callback is answered 200 (so the worker stops retrying), with the swept record.
    const capability = (db.find((item) => item.entityType === "OUTBOX" && item.operationId === prepareId)[0]!.invocation as { callbackCapability: string }).callbackCapability;
    const late = await call(handler, {
      method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${prepareId}/result`,
      headers: { "x-agentx-callback-capability": capability }, body: { operationId: prepareId, status: "SUCCEEDED" },
    });
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ operation: { id: prepareId, status: "FAILED", error: STUCK_SETUP_MESSAGE } });
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "task")).toHaveLength(0);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "FAILED", error: STUCK_SETUP_MESSAGE });
    // The developer still reads setup_failed after the late result.
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body).toMatchObject({ task: { status: "FAILED", failure: { category: "setup_failed", message: STUCK_SETUP_MESSAGE } } });
  });
});
