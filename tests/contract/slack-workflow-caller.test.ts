import { describe, expect, it } from "vitest";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { slackWorkflowCaller } from "../../packages/broker/src/aws/slack-workflow-caller.js";

describe("Slack workflow caller", () => {
  it("uses AgentX's stable hashed developer identity while retaining Slack identity for access checks", () => {
    const caller = slackWorkflowCaller("U0BSPTAFNG2");

    expect(caller).toEqual({
      developerId: developerIdForSlackUser("U0BSPTAFNG2"),
      sessionId: "slack-workflow",
      amr: "slack",
      name: "Slack user U0BSPTAFNG2",
      slackUserId: "U0BSPTAFNG2",
    });
    expect(caller.developerId).toMatch(/^[a-f0-9]{64}$/);
  });
});
