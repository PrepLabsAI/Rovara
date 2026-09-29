// tests/contract/stuck-setup.test.ts
// Spec 025 FR-055, D21, C17, C18: a developer task's setup is failed 50 minutes after it started.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STUCK_SETUP_MESSAGE, STUCK_SETUP_MS, setupWatchKey, sweepStuckSetups } from "../../packages/broker/src/aws/stuck-setup.js";
import { noticesFromStream } from "../../packages/broker/src/developer/notifications.js";
import { MAYA, createDeveloperTaskBroker, recordStream } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

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
  it("is written with the start, naming the prepare, and only for a developer task (Q4)", async () => {
    const { db, watches, prepareId, taskId, workspaceId, handler } = await starting();
    const createdAt = String(db.get(`WORKSPACE#${workspaceId}`, "META")!.createdAt);
    expect(watches()).toEqual([expect.objectContaining({ pk: "SETUP_WATCH", sk: `${createdAt}#${workspaceId}`, entityType: "SETUP_WATCH", workspaceId, operationId: prepareId, taskId, createdAt })]);
    // F14: the State table has no TTL, so the watch carries no expiry; the sweep removes it.
    expect(watches()[0]).not.toHaveProperty("expiresAt");
    // The clock starts with the prepare, which is the task's start (Q5).
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ createdAt });
    await ensureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`, "U0PRATIK01");
    expect(watches()).toHaveLength(1);
  });

  it("is 50 minutes, as the owner decided", () => {
    expect(STUCK_SETUP_MS).toBe(3_000_000);
    expect(STUCK_SETUP_MESSAGE).toBe("setup did not finish within 50 minutes; close this task and start a new one");
  });
});

describe("the sweep (FR-055)", () => {
  it("fails a prepare still running 50 minutes after it started, whatever the instance's health", async () => {
    const { db, sweep, workspaceId, prepareId, watches, dev, taskId } = await starting();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", entityType: "SESSION", workspaceId, state: "READY", sessionState: "READY", generation: 1 });
    expect(await sweep(51)).toEqual({ failed: [workspaceId], dropped: 0, kept: 0 });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "FAILED", error: STUCK_SETUP_MESSAGE });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect(db.get(`WORKSPACE#${workspaceId}`, "DEVELOPER_TASK")).not.toHaveProperty("pendingPrompt");
    expect(watches()).toEqual([]);
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "FAILED", failure: { category: "setup_failed", message: STUCK_SETUP_MESSAGE } });
    // F20: the sweep does not release the slot; closing the task frees it (FR-020), as for any failed setup.
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 1 });
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() })).body).toMatchObject({ closed: true });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 0 });
  });

  it("stamps the failed operation with the sweep's time, so the notifier does not drop its notice (F7)", async () => {
    const { db, sweepAt, minutesLater, workspaceId, prepareId } = await starting();
    const before = String(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)!.updatedAt);
    const at = minutesLater(51);
    await sweepAt(at);
    const updatedAt = String(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)!.updatedAt);
    expect(updatedAt).toBe(at.toISOString());
    expect(updatedAt > before).toBe(true);
  });

  it("gives a shared task's thread the setup-failed notice, stamped with the sweep's time (F7)", async () => {
    const { db, sweepAt, minutesLater, workspaceId, prepareId } = await starting({ shareToChannel: true });
    const stream = recordStream(db);
    const at = minutesLater(51);
    await sweepAt(at);
    expect(noticesFromStream(stream.take())).toEqual([expect.objectContaining({ kind: "setup_failed", workspaceId, operationId: prepareId, at: at.toISOString() })]);
  });

  it("never logs the task's instructions", async () => {
    const { sweep, logs, workspaceId, taskId, prepareId } = await starting();
    await sweep(51);
    expect(logs).toEqual([{ event: "stuck_setup.failed", workspaceId, taskId, operationId: prepareId }]);
    expect(JSON.stringify(logs)).not.toContain("PLANTED-INSTRUCTIONS");
  });

  it("leaves a younger prepare alone", async () => {
    const { db, sweep, workspaceId, watches } = await starting();
    expect(await sweep(49)).toEqual({ failed: [], dropped: 0, kept: 0 });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING" });
    expect(watches()).toHaveLength(1);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const { db, sweep, workspaceId, prepareId } = await starting();
    await sweep(51);
    const operation = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`);
    const workspace = db.get(`WORKSPACE#${workspaceId}`, "META");
    expect(await sweep(52)).toEqual({ failed: [], dropped: 0, kept: 0 });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toEqual(operation);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toEqual(workspace);
  });

  it("drops the watch of a setup that finished, and changes nothing else", async () => {
    const { db, sweep, finish, workspaceId, prepareId, watches } = await starting();
    await finish(workspaceId, prepareId, "SUCCEEDED");
    const before = db.get(`WORKSPACE#${workspaceId}`, "META");
    expect(await sweep(51)).toEqual({ failed: [], dropped: 1, kept: 0 });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toEqual(before);
    expect(watches()).toEqual([]);
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

  it("fails a prepare whose cancel was asked but never answered", async () => {
    const { db, sweep, workspaceId, prepareId } = await starting();
    db.set({ ...db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)!, status: "CANCEL_REQUESTED" });
    expect(await sweep(51)).toEqual({ failed: [workspaceId], dropped: 0, kept: 0 });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "FAILED", error: STUCK_SETUP_MESSAGE });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
  });

  it("drops the watch of a workspace that was closed, and changes nothing else", async () => {
    const { db, sweep, workspaceId, prepareId, watches } = await starting();
    db.set({ ...db.get(`WORKSPACE#${workspaceId}`, "META")!, status: "CLOSED", closedAt: new Date().toISOString() });
    const workspace = db.get(`WORKSPACE#${workspaceId}`, "META");
    const operation = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`);
    expect(await sweep(51)).toEqual({ failed: [], dropped: 1, kept: 0 });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toEqual(workspace);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toEqual(operation);
    expect(watches()).toEqual([]);
  });

  it("drops the watch of a workspace another operation now holds, and fails neither", async () => {
    const { db, sweep, workspaceId, prepareId, watches } = await starting();
    const other = randomUUID();
    db.set({ ...db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)!, sk: `OPERATION#${other}`, id: other });
    db.set({ ...db.get(`WORKSPACE#${workspaceId}`, "META")!, activeOperationId: other });
    const workspace = db.get(`WORKSPACE#${workspaceId}`, "META");
    expect(await sweep(51)).toEqual({ failed: [], dropped: 1, kept: 0 });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toEqual(workspace);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${other}`)).not.toMatchObject({ status: "FAILED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).not.toMatchObject({ status: "FAILED" });
    expect(watches()).toEqual([]);
  });

  it("handles more than one page of old watches over two runs", async () => {
    const { db, sweep, workspaceId, watches } = await starting();
    const old = new Date(Date.now() - 60 * 60_000);
    for (let index = 0; index < 100; index += 1) {
      const stale = randomUUID();
      const createdAt = new Date(old.getTime() - index * 1_000).toISOString();
      db.set({ ...setupWatchKey(createdAt, stale), entityType: "SETUP_WATCH", workspaceId: stale, operationId: randomUUID(), taskId: randomUUID(), createdAt });
    }
    expect(watches()).toHaveLength(101);
    // The 100 older, gone workspaces come first; the live task's watch is the 101st.
    expect(await sweep(51)).toEqual({ failed: [], dropped: 100, kept: 0 });
    expect(watches()).toHaveLength(1);
    expect(await sweep(51)).toEqual({ failed: [workspaceId], dropped: 0, kept: 0 });
    expect(watches()).toEqual([]);
  });

  it("answers a late SUCCEEDED result for a swept prepare and queues nothing (Review Focus 4)", async () => {
    const { db, sweep, finish, workspaceId, prepareId } = await starting();
    await sweep(51);
    await expect(finish(workspaceId, prepareId, "SUCCEEDED")).resolves.toBeDefined();
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "task")).toHaveLength(0);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "FAILED", error: STUCK_SETUP_MESSAGE });
  });
});
