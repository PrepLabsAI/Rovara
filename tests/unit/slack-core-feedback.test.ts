import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { coreKeepPullRequests } from "../../packages/broker/src/aws/slack-core-feedback.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { NOT_ON_THE_CORE_YET } from "../../packages/broker/src/core-host/dev-routes.js";
import type { CoreTaskEntry } from "../../packages/broker/src/aws/engine-boundary.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const event = { taskId, requestId: randomUUID(), expectedRevision: 9 };
const caller = { developerId: "a".repeat(64), sessionId: "slack", name: "Owner" };
function world(core = true) {
  const db = new FakeDynamoDb();
  if (core) db.set({ ...engineStampKey(taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "on", stampedAt: "2026-11-22T00:00:00.000Z" } });
  return { documentClient: db, tableName: "state" };
}

it("an unstamped task keeps its existing Slack path without asking for a caller or core route", async () => {
  const identify = vi.fn(async () => caller);
  const route = vi.fn(async () => undefined);
  expect(await coreKeepPullRequests(world(false), { route }, event, identify)).toBeUndefined();
  expect(identify).not.toHaveBeenCalled();
  expect(route).not.toHaveBeenCalled();
});

it("a served Keep receives the documented body and live linked caller and returns its exact envelope", async () => {
  const result = { task: { taskId, workflow: { revision: 10 } } };
  const seen: unknown[] = [];
  const entry: CoreTaskEntry = { route: async (request, identity) => {
    seen.push({ method: request.method, path: request.path, body: JSON.parse(request.body!) as unknown, identity });
    return { statusCode: 200, headers: {}, body: JSON.stringify(result) };
  } };
  expect(await coreKeepPullRequests(world(), entry, event, async () => caller)).toEqual(result);
  expect(seen).toEqual([{ method: "POST", path: `/v1/dev/tasks/${taskId}/workflow/keep-pull-requests`,
    body: { requestId: event.requestId, expectedRevision: 9 }, identity: caller }]);
});

it.each(["missing-entry", "unreadable", "failed-read"])("%s never discloses availability or dispatches legacy work", async kind => {
  const entry: CoreTaskEntry | undefined = kind === "missing-entry" ? undefined : { route: async request => {
    if (kind === "failed-read" && request.method === "GET") throw new Error("read failed");
    return undefined;
  } };
  const result = coreKeepPullRequests(world(), entry, event, async () => caller);
  if (kind === "failed-read") await expect(result).rejects.toThrow("read failed");
  else await expect(result).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
});

it("only a caller allowed to read the core task sees the unserved action refusal", async () => {
  const entry: CoreTaskEntry = { route: async request => request.method !== "GET" ? undefined
    : { statusCode: 200, headers: {}, body: JSON.stringify({ task: { taskId } }) } };
  await expect(coreKeepPullRequests(world(), entry, event, async () => caller)).rejects.toMatchObject({ code: "NOT_FOUND", message: `NOT_FOUND: ${NOT_ON_THE_CORE_YET}` });
});

it("failed linked identity resolution never reaches a served route", async () => {
  const route = vi.fn(async () => undefined);
  await expect(coreKeepPullRequests(world(), { route }, event, async () => { throw new Error("link revoked"); })).rejects.toThrow("link revoked");
  expect(route).not.toHaveBeenCalled();
});

it("Slack Keep on an unstamped task (an old workflow card) gets the fixed retired-button answer, not the old owner refusal (D1-2)", async () => {
  const { createDeveloperTaskBroker, MAYA } = await import("../support/developer-task-broker.js");
  const { SLACK_TEAM, SLACK_CHANNEL } = await import("../support/slack-broker.js");
  const w = await createDeveloperTaskBroker();
  const answer = await w.handler({ source: "agentx.slack-ingress", action: "workflow-keep-pull-requests", taskId,
    userId: MAYA.slackUserId, thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000100" },
    requestId: randomUUID(), expectedRevision: 9 });
  expect(JSON.parse(answer.body)).toMatchObject({ refused: true, code: "SLACK_BUTTON_RETIRED", message: "That button is out of date. Use the latest message in this thread." });
});
