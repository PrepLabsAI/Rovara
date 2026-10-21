import { describe, expect, it } from "vitest";
import { E2EDisplayScenarioSchema, E2EScenarioResultsSchema } from "@agentx/contracts";
import {
  e2eMockedBadge, e2eScenarioSummary, renderE2EScenarioRowsHtml, renderE2EScenarioSlackBlocks,
} from "../../packages/broker/src/e2e-presentation.js";
import { OTHER_SHOT_SHA, SHOT_SHA, failedBaseline, failedViewerRow, fiveScenarios, results, row } from "../support/e2e-scenario-results.js";

// M1.3 Task 3.7: one row per scenario on the task page, and a text-only summary in Slack (at most 3000 characters): the counts, the first failed row, what was mocked,
// the baseline and a link to the page. Neither shows an email or a credential, and neither says anything the rows do not.

const URL_OF_PAGE = "https://agentx.test/review/11111111-1111-4111-8111-111111111111/task";
const textOf = (blocks: ReturnType<typeof renderE2EScenarioSlackBlocks>) => blocks.map((block) => block.text.text).join("\n");
const artifactPath = (sha256: string) => `/review/11111111-1111-4111-8111-111111111111/task/api/e2e/artifacts/${sha256}`;

describe("the row and results schemas", () => {
  it("accept the rows the broker derives and refuse an email as an account label, an oversized value or an unknown field", () => {
    expect(E2EScenarioResultsSchema.safeParse(results({ baseline: failedBaseline() })).success).toBe(true);
    const bad = [
      { ...row(), accountLabel: "viewer@tenant-a.example" },
      { ...row(), title: "x".repeat(121) },
      { ...failedViewerRow(), failedAssertion: { kind: "visible", expected: "x".repeat(201), actual: "visible" } },
      { ...failedViewerRow(), traceRef: { sha256: SHOT_SHA } },
      { ...failedViewerRow(), screenshotRef: { sha256: SHOT_SHA, bytes: 600_000, contentType: "image/jpeg" } },
      { ...failedViewerRow(), screenshotRef: { sha256: SHOT_SHA, bytes: 10, contentType: "text/html" } },
      { ...row(), status: "PASS" },
    ];
    for (const value of bad) expect(E2EDisplayScenarioSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("holds a baseline that could not run to no rows", () => {
    expect(E2EScenarioResultsSchema.safeParse(results({ baseline: { status: "UNAVAILABLE", scenarios: [] } })).success).toBe(true);
    expect(E2EScenarioResultsSchema.safeParse(results({ baseline: { status: "UNAVAILABLE", scenarios: [row()] } })).success).toBe(false);
  });
});

describe("the Slack summary of the scenario results", () => {
  it("is the counts, the first failed row, what was mocked and the task page, in that order", () => {
    const lines = textOf(renderE2EScenarioSlackBlocks(results(), { taskPageUrl: URL_OF_PAGE })).split("\n");
    expect(lines[0]).toBe("Browser and API checks: 4 passed, 1 failed, 0 incomplete");
    expect(lines[1]).toBe("Viewer can't export — failed: expected hidden, was visible (orders-viewer)");
    expect(lines[2]).toBe("Mocked: inventory-v1");
    expect(lines[3]).toContain(`<${URL_OF_PAGE}|`);
    expect(lines).toHaveLength(4);
  });

  it("adds what the unchanged code did, after what was mocked", () => {
    const lines = textOf(renderE2EScenarioSlackBlocks(results({ baseline: failedBaseline() }), { taskPageUrl: URL_OF_PAGE })).split("\n");
    expect(lines[3]).toBe("Before the change: 2 of 5 failed, as expected for new behaviour.");
    expect(lines[4]).toContain(`<${URL_OF_PAGE}|`);
  });

  it("says plainly when the unchanged code could not be checked, and nothing else about it", () => {
    const text = textOf(renderE2EScenarioSlackBlocks(results({ baseline: { status: "UNAVAILABLE", scenarios: [] } }), { taskPageUrl: URL_OF_PAGE }));
    expect(text).toContain("Couldn't run the checks on the unchanged code.");
    expect(text).not.toContain("Before the change");
  });

  it("reports a baseline that passed or could not be decided without the 'as expected' words", () => {
    const passed = { status: "PASSED" as const, scenarios: fiveScenarios().map((item) => ({ ...item, status: "PASSED" as const })) };
    expect(textOf(renderE2EScenarioSlackBlocks(results({ baseline: passed })))).toContain("Before the change: all 5 passed.");
    const incomplete = { status: "UNKNOWN" as const, scenarios: [row({ status: "UNKNOWN", reason: "the checks have not finished" }), row({ scenarioId: "b" })] };
    const text = textOf(renderE2EScenarioSlackBlocks(results({ baseline: incomplete })));
    expect(text).toContain("Before the change: 1 of 2 could not be checked.");
    expect(text).not.toContain("as expected");
  });

  it("names the first incomplete row when nothing failed, and has no failure line for an all-passed round", () => {
    const incomplete = textOf(renderE2EScenarioSlackBlocks({ scenarios: [row(), row({ scenarioId: "b-check", title: "B check", status: "UNKNOWN", reason: "called a service that has no approved mock" })] }));
    expect(incomplete).toContain("Browser and API checks: 1 passed, 0 failed, 1 incomplete");
    expect(incomplete).toContain("B check — incomplete: called a service that has no approved mock (orders-owner)");
    const passed = textOf(renderE2EScenarioSlackBlocks({ scenarios: [row()] }));
    expect(passed.split("\n")).toEqual(["Browser and API checks: 1 passed, 0 failed, 0 incomplete"]);
  });

  it("stays within 3000 characters and escapes Slack markup, whatever the rows hold", () => {
    const many = Array.from({ length: 64 }, (_, index) => row({ scenarioId: `check-${index}`, title: `<!channel> *bold* ${"t".repeat(100)}`, status: "FAILED",
      reason: `expected ${"<a>".repeat(90)}`, mockedOrigins: Array.from({ length: 32 }, (_, origin) => `origin-with-a-long-name-${index}-${origin}`) }));
    const blocks = renderE2EScenarioSlackBlocks({ scenarios: many, baseline: { status: "FAILED", scenarios: many } }, { taskPageUrl: URL_OF_PAGE });
    for (const block of blocks) expect(textOf([block]).length).toBeLessThanOrEqual(3000);
    const text = textOf(blocks);
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain(`<${URL_OF_PAGE}|`);
  });

  it("shows no email and no credential even if a row somehow carried one in a field the schema bounds", () => {
    const rows = [row({ status: "FAILED", reason: "expected a, received ops@tenant-a.example", accountLabel: "orders-owner" })];
    // The renderer never trusts a stored row to be clean: it scrubs what it prints.
    const text = textOf(renderE2EScenarioSlackBlocks({ scenarios: rows }));
    expect(text).not.toContain("ops@tenant-a.example");
  });

  it("is a mocked badge in words: the service name from the origin reference", () => {
    expect(e2eMockedBadge("inventory-v1")).toBe("Inventory service mocked");
    expect(e2eMockedBadge("orders_api")).toBe("Orders api service mocked");
    expect(e2eMockedBadge("v2")).toBe("V2 service mocked");
  });

  it("counts passed, failed and incomplete rows", () => {
    expect(e2eScenarioSummary(fiveScenarios())).toBe("Browser and API checks: 4 passed, 1 failed, 0 incomplete");
    expect(e2eScenarioSummary([row({ status: "UNKNOWN" }), row({ status: "UNKNOWN", scenarioId: "b" })])).toBe("Browser and API checks: 0 passed, 0 failed, 2 incomplete");
  });
});

describe("the rows on the task page", () => {
  const html = renderE2EScenarioRowsHtml(results({ baseline: failedBaseline() }), { artifactPath });
  const rowsOf = (markup: string, attribute: string) => markup.match(new RegExp(`<tr[^>]*${attribute}`, "gu")) ?? [];

  it("lists one row per scenario, five here, and five more for the baseline", () => {
    expect(rowsOf(html, "data-e2e-row=").length).toBe(5);
    expect(rowsOf(html, "data-e2e-baseline-row=").length).toBe(5);
    expect(html).toContain("Browser and API checks: 4 passed, 1 failed, 0 incomplete");
  });

  it("shows each row's status, account label, kind and the failure in the words of the Slack line", () => {
    const failed = html.match(/<tr[^>]*data-e2e-row="viewer-cant-export"[\s\S]*?<\/tr>/u)?.[0] ?? "";
    expect(failed).toContain('data-status="FAILED"');
    expect(failed).toContain("Viewer can&#39;t export");
    expect(failed).toContain("orders-viewer");
    expect(failed).toContain("Failed");
    expect(failed).toContain("expected hidden, was visible");
    expect(failed).toContain("Browser");
    const api = html.match(/<tr[^>]*data-e2e-row="tenant-isolation"[\s\S]*?<\/tr>/u)?.[0] ?? "";
    expect(api).toContain("API");
    expect(api).toContain("Passed");
  });

  it("badges a mocked origin as '<service> mocked' on the rows that used it, and only those", () => {
    const owner = html.match(/<tr[^>]*data-e2e-row="owner-export"[\s\S]*?<\/tr>/u)?.[0] ?? "";
    expect(owner).toContain("Inventory service mocked");
    expect(html.match(/Inventory service mocked/gu)?.length).toBe(1);
  });

  it("links a row's screenshot, as a link to the artifact route and never as an inline image", () => {
    expect(html).toContain(`href="${artifactPath(SHOT_SHA)}"`);
    expect(html).toContain(`href="${artifactPath(OTHER_SHOT_SHA)}"`);
    expect(html).not.toContain("<img");
    expect(html).toContain("View screenshot");
  });

  it("says the unchanged code could not be checked, with no rows for it", () => {
    const unavailable = renderE2EScenarioRowsHtml(results({ baseline: { status: "UNAVAILABLE", scenarios: [] } }), { artifactPath });
    expect(unavailable).toContain("Couldn&#39;t run the checks on the unchanged code.");
    expect(rowsOf(unavailable, "data-e2e-baseline-row=").length).toBe(0);
  });

  it("labels the baseline as information only", () => {
    expect(html).toContain("Before the change: 2 of 5 failed, as expected for new behaviour.");
    expect(html).toMatch(/for information only/u);
  });

  it("escapes everything a row holds and prints no email", () => {
    const hostile = renderE2EScenarioRowsHtml({ scenarios: [row({ title: "<script>alert(1)</script>", status: "FAILED", reason: 'expected "a", received ops@tenant-a.example', accountLabel: "orders-owner" })] }, { artifactPath });
    expect(hostile).not.toContain("<script>");
    expect(hostile).not.toContain("ops@tenant-a.example");
    expect(hostile).toContain("&lt;script&gt;");
  });

  it("prints nothing for no rows", () => {
    expect(renderE2EScenarioRowsHtml({ scenarios: [] }, { artifactPath })).toBe("");
  });
});
