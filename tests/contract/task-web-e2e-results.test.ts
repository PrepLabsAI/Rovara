import { describe, expect, it } from "vitest";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { createTaskWeb, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { SHOT_SHA, failedBaseline, results, row } from "../support/e2e-scenario-results.js";

// M1.3 Task 3.7: the task page lists one row per scenario of the browser and API round, in its own section, and links a screenshot to the API route behind the session.

const taskId = "11111111-1111-4111-8111-111111111111";
const sessionId = "44444444-4444-4444-8444-444444444444";
const caller: DeveloperCaller = { developerId: "d".repeat(64), sessionId, amr: "slack", name: "Maya" };
const base: TaskDocumentView = {
  taskId, title: "Export orders", status: "Running the checks", nextStep: "Review", path: "QUICK", revision: 4, stage: "Checks", role: "owner", documents: [], checks: [], findings: [],
  pullRequests: [], history: [], access: { role: "owner", canComment: true, canSuggest: true, canDecide: true, canAsk: true },
};
const pageOf = async (view: TaskDocumentView) => {
  const request: AdaptedHttpRequest = { method: "GET", path: `/review/${taskId}/task`, requestId: "r", headers: { cookie: `__Host-agentx_review_session=${sessionId}` } };
  const web = createTaskWeb({ authenticateSession: async (id) => (id === sessionId ? caller : undefined), getTaskDocumentView: async () => view });
  return web(request, new URL(`https://agentx.example.test${request.path}`));
};

describe("the results section of the task page", () => {
  it("lists a row for each scenario, five here, with the baseline apart, between the checks and the review findings", async () => {
    const page = await pageOf({ ...base, e2eResults: results({ baseline: failedBaseline() }) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<section id="e2e-results"');
    expect(page.body.match(/<tr[^>]*data-e2e-row=/gu)?.length).toBe(5);
    expect(page.body.match(/<tr[^>]*data-e2e-baseline-row=/gu)?.length).toBe(5);
    expect(page.body).toContain("Browser and API checks: 4 passed, 1 failed, 0 incomplete");
    expect(page.body).toContain("Inventory service mocked");
    expect(page.body.indexOf('id="e2e-results"')).toBeLessThan(page.body.indexOf('id="findings"'));
  });

  it("links a screenshot to the API route of this task, behind the session, and still embeds no image (the page's policy allows none)", async () => {
    const page = await pageOf({ ...base, e2eResults: results() });
    expect(page.body).toContain(`href="/review/${taskId}/task/api/e2e/artifacts/${SHOT_SHA}"`);
    expect(page.body).not.toContain("<img");
    expect(page.headers["content-security-policy"]).toContain("img-src 'none'");
  });

  it("has no section when the task has no rows, and escapes what a row holds", async () => {
    expect((await pageOf(base)).body).not.toContain('id="e2e-results"');
    expect((await pageOf({ ...base, e2eResults: { scenarios: [] } })).body).not.toContain('id="e2e-results"');
    const hostile = await pageOf({ ...base, e2eResults: { scenarios: [row({ title: "<img src=x onerror=alert(1)>", status: "FAILED", reason: "expected <b>a</b>" })] } });
    expect(hostile.body).not.toContain("<img src=x");
    expect(hostile.body).not.toContain("<b>a</b>");
  });
});
