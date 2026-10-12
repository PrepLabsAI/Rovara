import { describe, expect, it } from "vitest";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { slackWorkflowCaller } from "../../packages/broker/src/aws/slack-workflow-caller.js";

describe("Slack workflow caller", () => {
  it("native_slack_and_slack_signin_page_mcp_share_owner_principal", () => {
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
