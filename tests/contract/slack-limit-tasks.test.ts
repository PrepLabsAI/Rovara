// tests/contract/slack-limit-tasks.test.ts
// Spec 025 C16 (25b owner decision 10): a member whose AI-tool tasks fill the limit is told so.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { limitMessage } from "../../packages/slack-service/src/messages.js";
import { MAYA, createDeveloperTaskBroker, grantProject, type Developer } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, serviceCall } from "../support/slack-broker.js";

const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" };
const TODAY = "You already have 3 AgentX workspaces, the most one person can have, so I can't start a new one. Continue in one of your existing threads instead:";

/** Every broker answer carries the request's requestId beside the result's own fields: the result alone. */
function result(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId, ...rest } = body;
  expect(typeof requestId).toBe("string");
  return rest;
}

async function fullOfTasks() {
  const harness = await createDeveloperTaskBroker({ memberLimit: 3 });
  const titles: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    titles.push(`Secret task title ${index}`);
    await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: `Task ${index}`, title: titles[index], client: "claude-code" });
  }
  return { ...harness, titles, subject: `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000009` };
}

describe("the Slack limit refusal (C16)", () => {
  it("counts the member's open AI-tool tasks for a service that asks", async () => {
    const { handler, subject } = await fullOfTasks();
    const asked = await serviceCall(handler, subject, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), includeOpenTaskCount: true });
    expect(result(asked.body)).toEqual({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [], openTaskCount: 3 });
    const older = await serviceCall(handler, subject, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace", { requestId: randomUUID() });
    expect(result(older.body)).toEqual({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [] });
  });

  it("gives only a count: no task's title, ID or instructions reaches the channel", async () => {
    const { handler, subject, titles, db } = await fullOfTasks();
    const asked = await serviceCall(handler, subject, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), includeOpenTaskCount: true });
    const text = JSON.stringify(asked.body);
    const taskIds = db.find((item) => item.entityType === "DEVELOPER_TASK").map((item) => String(item.taskId));
    expect(taskIds).toHaveLength(3);
    for (const secret of [...titles, ...taskIds, "Task 0"]) expect(text).not.toContain(secret);
    expect(text + limitMessage(asked.body as never)).not.toContain("Secret task title");
  });

  it("counts them on the prepare route too, for a lazily created thread", async () => {
    const harness = await createDeveloperTaskBroker({ memberLimit: 3 });
    const subject = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000010`;
    const created = await serviceCall(harness.handler, subject, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), lazyPreparation: true });
    expect(created.body).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED" });
    for (let index = 0; index < 3; index += 1) {
      await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: `Task ${index}`, client: "claude-code" });
    }
    const asked = await serviceCall(harness.handler, subject, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID(), includeOpenTaskCount: true });
    expect(result(asked.body)).toEqual({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [], openTaskCount: 3 });
    const older = await serviceCall(harness.handler, subject, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });
    expect(result(older.body)).toEqual({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [] });
  });
});

describe("the Slack limit refusal counts only the member's own tasks (C16)", () => {
  const PRIYA: Developer = { developerId: "f".repeat(64), name: "Priya Rao", provider: "slack", sessionId: "s-priya", slackUserId: "U0PRIYA001" };

  it("leaves another member's AI-tool tasks out of the count", async () => {
    const harness = await createDeveloperTaskBroker({ memberLimit: 3 });
    harness.db.set({ pk: `SESSION#${PRIYA.sessionId}`, sk: "META", sessionId: PRIYA.sessionId, developerId: PRIYA.developerId, amr: "slack", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    harness.db.set({ pk: `DEVELOPER#${PRIYA.developerId}`, sk: "META", developerId: PRIYA.developerId, provider: "slack", displayName: PRIYA.name, slackUserId: PRIYA.slackUserId, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    grantProject(harness.db, PRIYA);
    for (let index = 0; index < 2; index += 1) {
      const started = await harness.dev(PRIYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: `Priya ${index}`, client: "claude-code" });
      expect(started.status).toBe(200);
    }
    await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Maya 0", client: "claude-code" });
    for (const threadTs of ["1695500000.000011", "1695500000.000012"]) {
      const opened = await serviceCall(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/${threadTs}`, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace", { requestId: randomUUID() });
      expect(opened.body).toMatchObject({ outcome: "WORKSPACE", created: true });
    }
    const asked = await serviceCall(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000013`, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), includeOpenTaskCount: true });
    expect(result(asked.body)).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, openTaskCount: 1 });
    expect(harness.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${PRIYA.slackUserId}`)).toMatchObject({ count: 2 });
  });

  it("shows no AI-tool tasks and today's words when Slack threads alone fill the limit", async () => {
    const harness = await createDeveloperTaskBroker({ memberLimit: 3 });
    const threads = ["1695500000.000021", "1695500000.000022", "1695500000.000023"];
    for (const threadTs of threads) {
      const opened = await serviceCall(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/${threadTs}`, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace", { requestId: randomUUID() });
      expect(opened.body).toMatchObject({ outcome: "WORKSPACE", created: true });
    }
    const asked = await serviceCall(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000024`, MAYA.slackUserId!, "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), includeOpenTaskCount: true });
    const refusal = result(asked.body);
    expect(refusal).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, openTaskCount: 0 });
    expect(refusal.starterThreads).toHaveLength(3);
    const text = limitMessage(refusal as never);
    expect(text.split("\n")[0]).toBe(TODAY);
    expect(text).toBe(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: refusal.starterThreads as never }));
    expect(text).not.toContain("AI tool");
  });
});

describe("limitMessage (C16)", () => {
  it("keeps today's words exactly when no AI-tool task is open", () => {
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread], openTaskCount: 0 }).split("\n")[0]).toBe(TODAY);
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread] })).toBe(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread], openTaskCount: 0 }));
  });

  it("names the AI-tool tasks beside the threads, and says how to close one", () => {
    const text = limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread], openTaskCount: 2 });
    expect(text.split("\n")[0]).toBe(TODAY);
    expect(text.split("\n").at(-1)).toBe("You also have 2 tasks started from an AI tool; closing one there with agentx_close_task frees a workspace.");
  });

  it("says so plainly when the tasks are all there is", () => {
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [], openTaskCount: 3 })).toBe(
      "You already have 3 AgentX workspaces, the most one person can have, so I can't start a new one. 3 of them are tasks started from an AI tool; close one there with agentx_close_task to free a workspace.",
    );
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [], openTaskCount: 1 })).toContain("One of them is a task started from an AI tool");
  });

  it("uses no em dash", () => {
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread], openTaskCount: 2 })).not.toContain("—");
  });
});
