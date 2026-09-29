// Spec 025 C5, C24: POST /v1/dev/tasks/{taskId}/share, and a close ending the shared thread.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, OMAR, createDeveloperTaskBroker, markThreadPosted, registerRevision } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

async function privateTask(options: Parameters<typeof createDeveloperTaskBroker>[0] = {}) {
  const harness = await createDeveloperTaskBroker(options);
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const share = (body: Record<string, unknown> = {}, who = MAYA) => harness.dev(who, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), ...body });
  const record = () => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { share?: Record<string, unknown>; shareVersion?: number };
  const shareRecords = () => harness.db.find((item) => item.pk === `TASK#${taskId}` && item.action === "share");
  return { ...harness, taskId, share, record, shareRecords };
}

/** Fails the task's setup, so a close needs no preflight and finishes at once. */
async function failSetup(harness: Awaited<ReturnType<typeof privateTask>>) {
  const task = harness.db.get(`DEVTASK#${harness.taskId}`, "META") as { workspaceId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await harness.finish(task.workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
}

const THREAD = `SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000100`;

describe("POST /v1/dev/tasks/{taskId}/share (C5)", () => {
  it("shares a private task in the default mode, and audits it (US3 scenario 9, Q9)", async () => {
    const { share, record, shareRecords } = await privateTask();
    const response = await share();
    expect(response.status).toBe(200);
    expect(response.body.task).toMatchObject({ shared: true, share: { mode: "view", channelId: SLACK_CHANNEL, sharedReason: "requested" } });
    expect(record()).toMatchObject({ shared: true, shareVersion: 1, share: { teamId: SLACK_TEAM, mode: "view" } });
    expect(shareRecords()).toEqual([expect.objectContaining({ origin: "ai_tool", action: "share", phase: "accepted", outcome: "accepted" })]);
  });

  it("switches a shared thread's mode, on the task and on the thread's record (US3 scenario 7)", async () => {
    const { db, share, record, taskId } = await privateTask();
    await share({ shareMode: "continue" });
    markThreadPosted(db, taskId);
    const switched = await share({ shareMode: "view" });
    expect(switched.body.task).toMatchObject({ share: { mode: "view", threadUrl: `https://slack.com/archives/${SLACK_CHANNEL}/p1695500000000100` } });
    expect(record().share).toMatchObject({ mode: "view", threadTs: "1695500000.000100" });
    expect(db.get(THREAD, "META")).toMatchObject({ mode: "view" });
  });

  it("keeps view, and says why, when the latest revision does not allow continue (D5)", async () => {
    const { handler, share } = await privateTask();
    await share();
    await registerRevision(handler, 2, { shareMode: { default: "view", allowContinue: false } });
    const answer = await share({ shareMode: "continue" });
    expect(answer.body.task).toMatchObject({ share: { mode: "view", modeReason: "continue_not_allowed" } });
  });

  it("refuses to move a shared task to another channel", async () => {
    const { share } = await privateTask();
    await share();
    const moved = await share({ channel: "C0SECOND001" });
    expect(moved.body.error).toMatchObject({ code: "CONFIG_INVALID", message: `this task is already shared in #payments-dev; its channel cannot change` });
  });

  it("answers a repeated request_id with the task as it is and writes nothing; another use conflicts", async () => {
    const { share, shareRecords, dev, taskId } = await privateTask();
    const requestId = randomUUID();
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId, shareMode: "continue" });
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId, shareMode: "continue" });
    expect(shareRecords()).toHaveLength(1);
    const other = await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId, shareMode: "view" });
    expect(other.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await share({ shareMode: "continue" })).status).toBe(200);
    expect(shareRecords()).toHaveLength(1);
  });

  it("is the task owner's alone on the developer route (FR-036; an admin uses C25's route)", async () => {
    const { share } = await privateTask();
    expect((await share({}, OMAR)).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("wins a race with the notifier's write by reading the task again (C1)", async () => {
    const { db, share, taskId, record } = await privateTask();
    await share({ shareMode: "continue" });
    const original = db.send;
    let raced = false;
    db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("shareVersion = :current")) {
        raced = true;
        markThreadPosted(db, taskId);
      }
      return original(command);
    };
    const answer = await share({ shareMode: "view" });
    expect(raced).toBe(true);
    expect(answer.status).toBe(200);
    expect(record().share).toMatchObject({ mode: "view", threadTs: "1695500000.000100" });
    expect(db.get(THREAD, "META")).toMatchObject({ mode: "view" });
  });

  it("refuses a closed task, and a close marks its thread's record closed (C24)", async () => {
    const harness = await privateTask();
    const { db, share, taskId, dev } = harness;
    await share();
    markThreadPosted(db, taskId);
    await failSetup(harness);
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() })).body).toMatchObject({ closed: true });
    expect(db.get(THREAD, "META")).toMatchObject({ closedAt: expect.any(String) as string });
    expect((await share({ shareMode: "continue" })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("marks the thread closed when the notifier records it after the close read the task (ruling F4)", async () => {
    const harness = await privateTask();
    const { db, share, taskId, dev, record } = harness;
    await share();
    await failSetup(harness);
    const original = db.send;
    let raced = false;
    db.send = async (command) => {
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("shareVersion = :sv")) {
        raced = true;
        markThreadPosted(db, taskId);
      }
      return original(command);
    };
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() })).body).toMatchObject({ closed: true });
    expect(raced).toBe(true);
    expect(record()).toMatchObject({ closedAt: expect.any(String) as string, share: { threadTs: "1695500000.000100" } });
    expect(db.get(THREAD, "META")).toMatchObject({ closedAt: expect.any(String) as string });
  });
});
