import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { routeDeveloperTaskRequest } from "../../packages/broker/src/aws/developer-tasks.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

async function terminalPeopleTask() {
  const creator = "U0EREVIEW1";
  const coOwner = "U0EREVIEW2";
  const viewer = "U0VIEWER001";
  const h = await createDeveloperTaskBroker({
    channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
    developerExtra: {
      taskPeopleConfiguration: { peopleChangesEnabled: true },
      taskPersonProof: async (request) => ({ ok: true, user: { id: request.slackUserId, teamId: SLACK_TEAM, name: request.slackUserId }, memberOf: request.channelIds }),
    },
  });
  const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000081" };
  const started = await h.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: creator,
    instructions: "Terminal authorization fixture", workflowPath: "QUICK", requestId: randomUUID() });
  expect(started.statusCode).toBe(200);
  const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
  const stored = h.db.get(`DEVTASK#${taskId}`, "META")!;
  const people = [
    { slackUserId: creator, role: "owner" },
    { slackUserId: coOwner, role: "owner" },
    { slackUserId: viewer, role: "viewer" },
  ] as const;
  h.db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
    people: people.map(({ slackUserId, role }) => ({ developerId: developerIdForSlackUser(slackUserId), slackUserId, name: slackUserId, role })) });
  for (const { slackUserId } of people) {
    const developerId = developerIdForSlackUser(slackUserId);
    const personId = randomUUID();
    const createdAt = new Date().toISOString();
    h.db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId, slackUserId,
      name: slackUserId, method: "slack", issuer: "https://slack.com", subject: slackUserId, createdAt });
    h.db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${developerId}`, schemaVersion: 1, personId, developerId, createdAt });
  }
  h.db.set({ ...stored, workflow: { ...(stored.workflow as object), stage: "MERGED", state: "COMPLETE", outcome: "MERGED" } });
  return { h, taskId, thread, creator, coOwner, viewer };
}

describe("terminal task Slack authorization", () => {
  it("admits only current Owners to read authorization for a retired feedback card", async () => {
    const { h, taskId, thread, creator, coOwner, viewer } = await terminalPeopleTask();
    const sidecarBefore = h.db.get(`DEVTASK#${taskId}`, "PEOPLE");
    const decisionsBefore = h.db.find((item) => item.pk === `DEVTASK#${taskId}` && item.entityType === "WORKFLOW_DECISION");
    const authorize = (userId: string) => h.handler({ source: "agentx.slack-ingress", action: "task-people-authorize",
      taskAction: "feedback", taskId, userId, thread });

    expect((await authorize(creator)).statusCode).toBe(200);
    expect((await authorize(coOwner)).statusCode).toBe(200);
    expect((await authorize(viewer)).statusCode).not.toBe(200);
    expect(h.db.get(`DEVTASK#${taskId}`, "PEOPLE")).toEqual(sidecarBefore);
    expect(h.db.find((item) => item.pk === `DEVTASK#${taskId}` && item.entityType === "WORKFLOW_DECISION")).toEqual(decisionsBefore);
  });

  it("returns the closed-task refusal to current Owners on every legacy API mutation without effects", async () => {
    const { h, taskId, creator, coOwner } = await terminalPeopleTask();
    const beforeTask = structuredClone(h.db.get(`DEVTASK#${taskId}`, "META"));
    const beforePeople = structuredClone(h.db.get(`DEVTASK#${taskId}`, "PEOPLE"));
    const beforeOperations = h.db.find((item) => item.entityType === "OPERATION");
    const requests = [
      ["continue", { requestId: randomUUID(), instructions: "must be refused" }],
      ["cancel", { requestId: randomUUID() }],
      ["pull-requests", { requestId: randomUUID(), title: "must be refused" }],
      ["share", { requestId: randomUUID(), shareMode: "view" }],
    ] as const;

    for (const slackUserId of [creator, coOwner]) {
      const caller: DeveloperCaller = { developerId: developerIdForSlackUser(slackUserId), slackUserId, name: slackUserId, sessionId: `session-${slackUserId}`, amr: "slack" };
      const deps = developerTaskRouteDependencies({ documentClient: h.db, tableName: "state", developer: h.brokerInput.developer, now: Date.now, tasks: h.actions } as never, caller);
      for (const [route, body] of requests) {
        let refusal: unknown;
        try {
          await routeDeveloperTaskRequest(deps, caller, { method: "POST", path: `/v1/dev/tasks/${taskId}/${route}`, headers: {}, body: JSON.stringify(body), requestId: randomUUID() },
            new URL(`/v1/dev/tasks/${taskId}/${route}`, "https://agentx.invalid"));
        } catch (error) { refusal = error; }
        expect(refusal).toMatchObject({ code: "CONFIG_INVALID" });
        expect((refusal as Error).message).toContain("this task is closed; start a new one with agentx_start_task");
      }
    }
    expect(h.db.get(`DEVTASK#${taskId}`, "META")).toEqual(beforeTask);
    expect(h.db.get(`DEVTASK#${taskId}`, "PEOPLE")).toEqual(beforePeople);
    expect(h.db.find((item) => item.entityType === "OPERATION")).toEqual(beforeOperations);
  });
});
