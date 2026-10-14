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
    expect(slack).toContain("Observed mock consumption IDs (0)");
    expect(html).toContain("Observed mock consumption IDs (0)");
    expect(mcp.view).toEqual(view);
    expect(JSON.stringify(mcp)).toContain("\"observedMockedComponentIds\":[]");
    expect(mcp.scope).toContain("does not establish app, native");
  });

  it("bounds Slack section sizes after escaping contract-maximal lists and long text", () => {
    const oversized: E2ESharedView = {
      ...view,
      setup: { ...view.setup, selectedTargetIds: Array.from({ length: 12 }, (_, i) => `${"<target&".repeat(20)}-${i}`), blockingInputIds: Array.from({ length: 128 }, (_, i) => `${"input&".repeat(20)}-${i}`), mockSubstitutableInputIds: Array.from({ length: 128 }, (_, i) => `${"mock&".repeat(20)}-${i}`) },
      e2e: { ...view.e2e, label: "PASS ".repeat(500), mockedComponentIds: Array.from({ length: 200 }, (_, i) => `${"component&".repeat(20)}-${i}`), observedMockedComponentIds: Array.from({ length: 200 }, (_, i) => `${"observed&".repeat(20)}-${i}`), requiredUnexercisedCriteriaIds: Array.from({ length: 64 }, (_, i) => `${"criterion&".repeat(20)}-${i}`), unexercisedBehaviors: Array.from({ length: 256 }, (_, i) => `${"behavior&".repeat(30)}-${i}`) },
    };
    const blocks = renderE2ESlackBlocks(oversized);
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.every((block) => block.text.text.length <= 3000)).toBe(true);
    const text = blocks.map((block) => block.text.text).join("\n");
    expect(text).toContain("PASS");
    expect(text).toContain("total 200");
    expect(text).toContain("shortened");
    expect(text).toContain("does not establish app, native");
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
    expect(slackBlocks.map((block) => block.text.text).join("\n")).toContain("\\*bold\\*");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(renderE2EMcpProjection(partial).view).toEqual(partial);
  });
});
