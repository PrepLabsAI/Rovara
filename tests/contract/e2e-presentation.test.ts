import { describe, expect, it } from "vitest";
import type { E2ESharedView } from "../../packages/contracts/src/e2e-view-node.js";
import { renderE2EMcpProjection, renderE2EPageHtml, renderE2ESlackBlocks, renderE2EUnavailableSlackBlock } from "../../packages/broker/src/e2e-presentation.js";

const view: E2ESharedView = {
  schemaVersion: 1,
  setup: { status: "mock-ready", selectedTargetIds: ["web<target>"], executionPlanDigest: "plan-123", blockingInputIds: ["native-auth"], mockSubstitutableInputIds: ["native-auth"] },
  e2e: { status: "PASS", label: "Checks passed with mocks", executionPlanDigest: "plan-123", expectedGroups: 3, receivedGroups: 3, executedCases: 8, qualifiedCriteria: 4, requiredCriteria: 4, unavailableCriteria: 0, optionalUnavailableCriteria: 1, mockedComponentIds: ["auth-mock"], observedMockedComponentIds: [], unexercisedBehaviors: ["native login"], policyPresence: "present", workflowPhase: "e2e", requiredUnexercisedCriteriaIds: ["native-auth"] },
  actions: ["connect-runtime"],
};

describe("E2E presentation adapters", () => {

  it("keeps UNKNOWN and partial groups visible and escapes untrusted text", () => {
    const partial: E2ESharedView = { ...view, setup: { ...view.setup, selectedTargetIds: ["<script>alert('x')&</script>", "<@U123> *bold*"] }, e2e: { ...view.e2e, status: "UNKNOWN", label: "Checks <incomplete> & pending", receivedGroups: 1, expectedGroups: 3, requiredUnexercisedCriteriaIds: ["criterion-1"] }, actions: [] };
    const slackBlocks = renderE2ESlackBlocks(partial);
    const slack = JSON.stringify(slackBlocks);
    const html = renderE2EPageHtml(partial);
    expect(slack).toContain("UNKNOWN");
    expect(slack).toContain("1/3");
    expect(slack).toContain("&lt;incomplete&gt;");
    expect(slack).not.toContain("Checks <incomplete>");
    expect(slack).not.toContain("<script>alert");
    expect(slack).not.toContain("<@U123>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(renderE2EMcpProjection(partial).view).toEqual(partial);
  });
});

describe("the E2E fallback when no display projection can be shown", () => {
  const page = "https://agentx.example.test/review/t1/task";

  it("falls back to plain words with no task page, and treats an unstated round as started", () => {
    expect(renderE2EUnavailableSlackBlock(undefined, false).text.text).toBe("Browser and API tests haven't run yet. Open the task page for status.");
    expect(renderE2EUnavailableSlackBlock(undefined, true).text.text).toBe("I couldn't show the test results here. Open the task page for the latest status.");
    expect(renderE2EUnavailableSlackBlock(page).text.text).toContain("I couldn't show the test results here.");
  });
});
