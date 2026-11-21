// tests/contract/slack-limit-tasks.test.ts
// Spec 025 C16 (25b owner decision 10): a member whose AI-tool tasks fill the limit is told so.
import { randomUUID } from "node:crypto";
import { SLACK_FORMAT } from "../../packages/slack-service/src/slack-format.js";
import { describe, expect, it } from "vitest";
import { limitMessage } from "../../packages/slack-service/src/messages.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, serviceCall } from "../support/slack-broker.js";

const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" };
const TODAY = "You already have 3 AgentX workspaces, the most one person can have, so I can't start a new one. Continue in one of your existing threads instead:";

/** Every broker answer carries the request's requestId beside the result's own fields: the result alone. */
function result(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId, ...rest } = body;
  expect(typeof requestId).toBe("string");
  return rest;
}




describe("the Slack limit refusal counts only the member's own tasks (C16)", () => {

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
    const text = limitMessage(refusal as never, SLACK_FORMAT);
    expect(text.split("\n")[0]).toBe(TODAY);
    expect(text).toBe(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: refusal.starterThreads as never }, SLACK_FORMAT));
    expect(text).not.toContain("AI tool");
  });
});

describe("limitMessage (C16)", () => {

  it("names the AI-tool tasks beside the threads, and says how to close one", () => {
    const text = limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [thread], openTaskCount: 2 }, SLACK_FORMAT);
    expect(text.split("\n")[0]).toBe(TODAY);
    expect(text.split("\n").at(-1)).toBe("You also have 2 tasks started from an AI tool; closing one there with agentx_close_task frees a workspace.");
  });

  it("says so plainly when the tasks are all there is", () => {
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [], openTaskCount: 3 }, SLACK_FORMAT)).toBe(
      "You already have 3 AgentX workspaces, the most one person can have, so I can't start a new one. 3 of them are tasks started from an AI tool; close one there with agentx_close_task to free a workspace.",
    );
    expect(limitMessage({ limit: "MEMBER", maximum: 3, starterThreads: [], openTaskCount: 1 }, SLACK_FORMAT)).toContain("One of them is a task started from an AI tool");
  });

});
