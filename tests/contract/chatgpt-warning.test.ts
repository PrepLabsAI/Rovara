// #342: a task that left its owner's ChatGPT plan for the default model says so in its thread when
// it ends, once, addressed to the plan's owner. The notifier reads the ended operation from the stream.
import { describe, expect, it } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { chatGptFallbackText } from "../../packages/broker/src/chatgpt/fallback-notice.js";
import { readStream, type Notice } from "../../packages/broker/src/developer/notifications.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { recordStream } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { StrictSlackWeb } from "../support/strict-slack.js";

const MAYA = "U0MAYA0001";
const TEAMMATE = "U0SAM00001";
const THREAD = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const WS = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";

function harness() {
  const db = new FakeDynamoDb();
  const stream = recordStream(db);
  const slack = new StrictSlackWeb({ briefLimit: 1_200 });
  const queue: Notice[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const handle = createNotifierHandler({
    documentClient: db, tableName: "state",
    enqueue: async (notices) => { queue.push(...notices); },
    retryLater: async () => undefined,
    post: async (input) => ({ ts: slack.post(input).ts }),
    now: () => Date.now(), log: (entry) => logs.push(entry), deliveryFailed: () => undefined,
  });
  /** The stream into notices, then the ChatGPT ones delivered (as the queue would bring them back). */
  const pump = async () => {
    await handle({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const notices = queue.splice(0).filter((notice) => notice.kind === "chatgpt_fallback");
    await handle({ Records: notices.map((notice, index) => ({ eventSource: "aws:sqs", messageId: `m${index}`, receiptHandle: `r${index}`, body: JSON.stringify(notice) })) });
    return notices;
  };
  const operation = (fields: Record<string, unknown>) => db.set({
    pk: `WORKSPACE#${WS}`, sk: `OPERATION#${OP}`, entityType: "OPERATION", id: OP, workspaceId: WS, kind: "task", status: "RUNNING", fence: 1, ...fields,
  });
  const end = async () => {
    await db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${WS}`, sk: `OPERATION#${OP}` }, UpdateExpression: "SET #status = :done", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":done": "SUCCEEDED" } }));
  };
  return { db, slack, logs, pump, operation, end, handle };
}

describe("the warning a ChatGPT task's thread gets when it fell back (#342)", () => {
  it("routes fallback and People notices independently when People delivery is off", async () => {
    const h = harness();
    const taskId = "33333333-3333-4333-8333-333333333333";
    const requestId = "44444444-4444-4444-8444-444444444444";
    h.operation({ status: "SUCCEEDED", requestedBy: { teamId: THREAD.teamId, userId: MAYA },
      chatgptDeveloperId: developerIdForSlackUser(MAYA), chatgptThread: THREAD, chatgptFallback: "limit" });
    h.db.set({ pk: `DEVTASK#${taskId}`, sk: `PEOPLE_NOTIFY#${requestId}`, entityType: "TASK_PEOPLE_NOTIFICATION", schemaVersion: 1,
      taskId, requestId, targetDeveloperId: "d".repeat(64), slackUserId: TEAMMATE, role: "viewer", peopleRevision: 1,
      status: "PENDING", attempts: 0, createdAt: new Date().toISOString() });
    const at = new Date().toISOString();
    const notices: Notice[] = [
      { id: `${taskId}:people:${requestId}`, kind: "people_dm", taskId, peopleRequestId: requestId, at },
      { id: `${OP}:chatgpt_fallback`, kind: "chatgpt_fallback", workspaceId: WS, operationId: OP, at },
    ];

    await h.handle({ Records: notices.map((notice, index) => ({ eventSource: "aws:sqs", messageId: `coexist-${index}`,
      receiptHandle: `coexist-${index}`, body: JSON.stringify(notice), attributes: { ApproximateReceiveCount: "1" } })) });

    expect(h.db.get(`DEVTASK#${taskId}`, `PEOPLE_NOTIFY#${requestId}`)).toMatchObject({ status: "CANCELLED" });
    expect(h.slack.posts).toEqual([expect.objectContaining({ channel: THREAD.channelId, threadTs: THREAD.threadTs,
      text: chatGptFallbackText("limit", MAYA) })]);
    expect(h.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "people_dm", outcome: "suppressed" }),
      expect.objectContaining({ kind: "chatgpt_fallback", outcome: "posted" }),
    ]));
  });

  it("is posted once in the Slack thread the task was asked from, to the plan's owner, when the task ends", async () => {
    const h = harness();
    h.operation({ requestedBy: { teamId: THREAD.teamId, userId: MAYA }, chatgptDeveloperId: developerIdForSlackUser(MAYA), chatgptThread: THREAD });
    await h.pump();
    // Falling back is told when the task ends, not before.
    await h.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `WORKSPACE#${WS}`, sk: `OPERATION#${OP}` }, UpdateExpression: "SET chatgptFallback = :reason", ExpressionAttributeValues: { ":reason": "limit" } }));
    expect(await h.pump()).toEqual([]);
    await h.end();
    expect(await h.pump()).toHaveLength(1);
    expect(h.slack.posts).toEqual([expect.objectContaining({ channel: THREAD.channelId, threadTs: THREAD.threadTs, text: chatGptFallbackText("limit", MAYA) })]);
    expect(h.slack.posts[0]!.text).toContain(`<@${MAYA}>, your ChatGPT plan reached its usage limit, so I finished this on this Rovara's default model.`);
    // A redelivered notice says nothing more.
    const again = { id: `${OP}:chatgpt_fallback`, kind: "chatgpt_fallback", workspaceId: WS, operationId: OP, at: new Date().toISOString() };
    await createNotifierHandler({ documentClient: h.db, tableName: "state", enqueue: async () => undefined, retryLater: async () => undefined,
      post: async (input) => ({ ts: h.slack.post(input).ts }), now: () => Date.now(), log: () => undefined, deliveryFailed: () => undefined,
    })({ Records: [{ eventSource: "aws:sqs", messageId: "again", receiptHandle: "again", body: JSON.stringify(again) }] });
    expect(h.slack.posts).toHaveLength(1);
  });

  it("is posted in a developer task's shared thread, to the task's owner, even when a teammate's turn fell back", async () => {
    const h = harness();
    const owner = "d".repeat(64);
    h.db.set({ ...taskPointerKey(WS), entityType: "DEVELOPER_TASK_POINTER", taskId: "task-1", workspaceId: WS });
    h.db.set({ ...taskKey("task-1"), entityType: "DEVELOPER_TASK", taskId: "task-1", developerId: owner, slackUserId: MAYA, workspaceId: WS,
      share: { teamId: THREAD.teamId, channelId: THREAD.channelId, mode: "continue", sharedReason: "requested", sharedAt: "2026-10-11T12:00:00.000Z", threadTs: THREAD.threadTs } });
    h.operation({ requestedBy: { teamId: THREAD.teamId, userId: TEAMMATE }, chatgptDeveloperId: owner, chatgptFallback: "revoked" });
    await h.pump();
    await h.end();
    await h.pump();
    expect(h.slack.posts).toEqual([expect.objectContaining({ channel: THREAD.channelId, threadTs: THREAD.threadTs, text: chatGptFallbackText("revoked", MAYA) })]);
  });

  it("is not posted for a task that stayed on its plan, or that has no thread to post in", async () => {
    const stayed = harness();
    stayed.operation({ requestedBy: { teamId: THREAD.teamId, userId: MAYA }, chatgptDeveloperId: developerIdForSlackUser(MAYA), chatgptThread: THREAD });
    await stayed.end();
    expect(await stayed.pump()).toEqual([]);
    const privateTask = harness();
    privateTask.operation({ requestedBy: { kind: "developer", developerId: "d".repeat(64), provider: "oidc" }, chatgptDeveloperId: "d".repeat(64), chatgptFallback: "model" });
    await privateTask.end();
    expect(await privateTask.pump()).toHaveLength(1);
    expect(privateTask.slack.posts).toEqual([]);
    expect(privateTask.logs).toContainEqual(expect.objectContaining({ kind: "chatgpt_fallback", outcome: "not_shared" }));
  });
});

describe("the stream's ended operations (#342)", () => {
  const ended = (fields: Record<string, unknown>) => readStream([{
    eventID: "e1", eventName: "MODIFY",
    dynamodb: {
      OldImage: { entityType: { S: "OPERATION" }, id: { S: OP }, workspaceId: { S: WS }, kind: { S: "task" }, status: { S: "RUNNING" } },
      NewImage: { entityType: { S: "OPERATION" }, id: { S: OP }, workspaceId: { S: WS }, kind: { S: "task" }, status: { S: "SUCCEEDED" }, ...fields },
    },
  }]).notices.map((notice) => notice.kind);

  it("gives a fallback notice whoever asked, and keeps a developer's own notices as they were", () => {
    expect(ended({ chatgptFallback: { S: "limit" }, requestedBy: { M: { teamId: { S: THREAD.teamId }, userId: { S: MAYA } } } })).toEqual(["chatgpt_fallback"]);
    expect(ended({ chatgptFallback: { S: "limit" }, requestedBy: { M: { kind: { S: "developer" } } } })).toEqual(["chatgpt_fallback", "ended"]);
    expect(ended({ requestedBy: { M: { kind: { S: "developer" } } } })).toEqual(["ended"]);
    expect(ended({ requestedBy: { M: { teamId: { S: THREAD.teamId }, userId: { S: MAYA } } } })).toEqual([]);
  });
});

describe("the warning's words (#342)", () => {
  it("names the reason and what happens next, and addresses no one when the owner's Slack user is unknown", () => {
    expect(chatGptFallbackText("limit")).toMatch(/^The ChatGPT plan this task ran on reached its usage limit/);
    expect(chatGptFallbackText("limit", MAYA)).toContain("<https://chatgpt.com/settings/usage|chatgpt.com/settings/usage>");
    expect(chatGptFallbackText("revoked", MAYA)).toBe(`<@${MAYA}>, your ChatGPT connection no longer works (it was revoked or expired), so I finished this on this Rovara's default model. Mention me with \`connect chatgpt\` to connect again.`);
    expect(chatGptFallbackText("model")).toBe("The ChatGPT plan this task ran on no longer allows the model this task was using, so I finished it on this Rovara's default model. The next task picks a model the plan allows.");
  });
});
