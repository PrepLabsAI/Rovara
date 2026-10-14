import { describe, expect, it } from "vitest";
import type { E2ESharedView } from "../../packages/contracts/src/e2e-view.js";
import { renderE2EMcpProjection, renderE2EPageHtml, renderE2ESlackBlocks } from "../../packages/broker/src/e2e-presentation.js";

const view: E2ESharedView = {
  schemaVersion: 1,
  setup: { status: "mock-ready", selectedTargetIds: ["web<target>"], executionPlanDigest: "plan-123", blockingInputIds: ["native-auth"], mockSubstitutableInputIds: ["native-auth"] },
  e2e: { status: "PASS", label: "Checks passed with mocks", executionPlanDigest: "plan-123", expectedGroups: 3, receivedGroups: 3, executedCases: 8, qualifiedCriteria: 4, requiredCriteria: 4, unavailableCriteria: 0, optionalUnavailableCriteria: 1, mockedComponentIds: ["auth-mock"], observedMockedComponentIds: [], unexercisedBehaviors: ["native login"], policyPresence: "present", workflowPhase: "e2e", requiredUnexercisedCriteriaIds: ["native-auth"] },
  actions: ["connect-runtime"],
};

describe("E2E presentation adapters", () => {
  it("preserves scoped mock-pass counts, declared versus observed mocks, gaps, and read-only proposals on every surface", () => {
    const slack = JSON.stringify(renderE2ESlackBlocks(view));
    const html = renderE2EPageHtml(view);
    const mcp = renderE2EMcpProjection(view);
    for (const surface of [slack, html]) {
      expect(surface).toContain("PASS");
      expect(surface).toContain("Checks passed with mocks");
      expect(surface).toContain("8");
      expect(surface).toContain("4/4");
      expect(surface).toContain("auth-mock");
      expect(surface).toContain("native-auth");
      expect(surface).toContain("connect-runtime");
      expect(surface).toContain("mock");
    }
    expect(slack).toContain("0 observed");
    expect(html).toContain("Observed mock consumption IDs (0)");
    expect(mcp.view).toEqual(view);
    expect(JSON.stringify(mcp)).toContain("\"observedMockedComponentIds\":[]");
    expect(mcp.scope).toContain("does not establish app, native");
  });

  it("renders FAILED and viewer projections without turning proposals into controls", () => {
    const failed: E2ESharedView = { ...view, e2e: { ...view.e2e, status: "FAILED", label: "Checks failed" }, actions: [] };
    const slack = JSON.stringify(renderE2ESlackBlocks(failed));
    const html = renderE2EPageHtml(failed);
    expect(slack).toContain("FAILED");
    expect(slack).toContain("Owner action proposals (read-only): none");
    expect(html).toContain("Checks failed");
    expect(html).not.toContain("<button");
  });

  it("keeps UNKNOWN and partial groups visible and escapes untrusted text", () => {
    const partial: E2ESharedView = { ...view, setup: { ...view.setup, selectedTargetIds: ["<script>alert('x')&</script>", "<@U123> *bold*"] }, e2e: { ...view.e2e, status: "UNKNOWN", label: "Checks <incomplete> & pending", receivedGroups: 1, expectedGroups: 3, requiredUnexercisedCriteriaIds: ["criterion-1"] }, actions: [] };
    const slackBlocks = renderE2ESlackBlocks(partial);
    const slack = JSON.stringify(slackBlocks);
    const html = renderE2EPageHtml(partial);
    expect(slack).toContain("UNKNOWN");
    expect(slack).toContain("1/3");
    expect(slack).toContain("&lt;script&gt;");
    expect(slack).toContain("&lt;@U123&gt;");
    expect(slackBlocks[0]!.text.text).toContain("\\*bold\\*");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(renderE2EMcpProjection(partial).view).toEqual(partial);
  });
});
