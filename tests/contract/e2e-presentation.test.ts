import { describe, expect, it } from "vitest";
import type { E2ESharedView } from "../../packages/contracts/src/e2e-view.js";
import { renderE2EMcpProjection, renderE2EPageHtml, renderE2ESlackBlocks, renderE2EUnavailableSlackBlock } from "../../packages/broker/src/e2e-presentation.js";

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
      expect(surface).toContain("mock");
    }
    expect(html).toContain("auth-mock");
    expect(html).toContain("native-auth");
    expect(html).toContain("connect-runtime");
    expect(slack).toContain("Mocks 1 declared · 0 independently observed");
    expect(slack).toContain("0 independently observed");
    expect(html).toContain("Observed mock consumption IDs (0)");
    expect(mcp.view).toEqual(view);
    expect(JSON.stringify(mcp)).toContain("\"observedMockedComponentIds\":[]");
    expect(mcp.scope).toContain("Browser, native, live-service");
  });

  it("bounds Slack section sizes after escaping contract-maximal lists and long text", () => {
    const oversized: E2ESharedView = {
      ...view,
      setup: { ...view.setup, selectedTargetIds: Array.from({ length: 12 }, (_, i) => `${"<target&".repeat(20)}-${i}`), blockingInputIds: Array.from({ length: 128 }, (_, i) => `${"input&".repeat(20)}-${i}`), mockSubstitutableInputIds: Array.from({ length: 128 }, (_, i) => `${"mock&".repeat(20)}-${i}`) },
      e2e: { ...view.e2e, label: "PASS ".repeat(500), mockedComponentIds: Array.from({ length: 200 }, (_, i) => `${"component&".repeat(20)}-${i}`), observedMockedComponentIds: Array.from({ length: 200 }, (_, i) => `${"observed&".repeat(20)}-${i}`), requiredUnexercisedCriteriaIds: Array.from({ length: 64 }, (_, i) => `${"criterion&".repeat(20)}-${i}`), unexercisedBehaviors: Array.from({ length: 256 }, (_, i) => `${"behavior&".repeat(30)}-${i}`) },
    };
    const blocks = renderE2ESlackBlocks(oversized);
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.every((block) => block.type === "context"
      ? block.elements.length === 1 && block.elements[0]!.text.length <= 3000
      : block.text.text.length <= 3000)).toBe(true);
    const text = blocks.map((block) => block.type === "context" ? block.elements.map((element) => element.text).join("\n") : block.text.text).join("\n");
    expect(text).toContain("PASS");
    expect(text).toContain("Mocks 200 declared · 200 independently observed");
    expect(text).toContain("shortened");
    expect(text).toContain("Browser, native, live-service");
    const contextBlock = blocks.at(-1);
    expect(contextBlock?.type).toBe("context");
    if (contextBlock?.type === "context") {
      expect(contextBlock.elements).toHaveLength(1);
      expect(contextBlock.elements[0]?.type).toBe("mrkdwn");
      expect(contextBlock.elements[0]?.text).toContain("Browser, native, live-service");
    }
  });

  it("renders FAILED and viewer projections without turning proposals into controls", () => {
    const failed: E2ESharedView = { ...view, e2e: { ...view.e2e, status: "FAILED", label: "Checks failed" }, actions: [] };
    const slack = JSON.stringify(renderE2ESlackBlocks(failed));
    const html = renderE2EPageHtml(failed);
    expect(slack).toContain("FAILED");
    expect(slack).toContain("advisory owner proposals 0");
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
  it("says the tests have not run yet, never a status, when no round has started", () => {
    const text = renderE2EUnavailableSlackBlock(page, false).text.text;
    expect(text).toBe(`Browser and API tests haven't run yet. <${page}|Open the task page for status.>`);
    expect(text).not.toMatch(/UNKNOWN|PASS|FAIL|Manifest|status:/i);
  });

  it("says the results could not be shown, never a verdict, once a round has started", () => {
    const text = renderE2EUnavailableSlackBlock(page, true).text.text;
    expect(text).toBe(`I couldn't show the test results here. <${page}|Open the task page for the latest status.>`);
    expect(text).not.toMatch(/UNKNOWN|PASS|Manifest/);
  });

  it("falls back to plain words with no task page, and treats an unstated round as started", () => {
    expect(renderE2EUnavailableSlackBlock(undefined, false).text.text).toBe("Browser and API tests haven't run yet. Open the task page for status.");
    expect(renderE2EUnavailableSlackBlock(undefined, true).text.text).toBe("I couldn't show the test results here. Open the task page for the latest status.");
    expect(renderE2EUnavailableSlackBlock(page).text.text).toContain("I couldn't show the test results here.");
  });
});
