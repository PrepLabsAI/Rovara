// The test environment page without a machine section is byte-identical to what it was before the machine size (TE-C5 part B): a golden of the rendered HTML.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderTestEnvironment, type PageContext } from "../../packages/broker/src/core/local-pages/pages.js";
import type { TestEnvironmentPageView } from "../../packages/broker/src/core/local-pages/views.js";

const context: PageContext = { base: "/s/token", nonce: "nonce", sessionId: "session", formToken: () => "form-token" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const view: TestEnvironmentPageView = {
  project: "payments",
  approved: { revision: 2, approvedAt: "2026-11-14T10:00:00.000Z", approvedBy: "owner", lines: ["Tier: sandbox", "Round budget: 30 minutes"], checks: [{ id: "unit", label: "Unit tests", kind: "test" }] },
  proposal: { digest: "a".repeat(64), proposedAt: "2026-11-15T10:00:00.000Z", risk: "medium", lessSafe: [], changes: ["roundBudgetMin: 30 -> 45"], proved: true },
  approval: { requestId: "11111111-1111-4111-8111-111111111111", revision: 3, artifactDigest: "a".repeat(64), kind: "test-environment", risk: "medium" },
  extra: ["Saved environments are on."],
};

describe("the test environment page", () => {
  it("is byte-identical with no machine section (golden)", () => {
    expect(sha(renderTestEnvironment(context, view))).toBe("8374f6ac9b12b5d38546facce7bfc66c85634fb5c627aa76bf8aeae317ccaaec");
    expect(renderTestEnvironment(context, { ...view, machine: [] })).toBe(renderTestEnvironment(context, view));
  });
  it("adds one section with the lines as plain text when there is a machine card", () => {
    const html = renderTestEnvironment(context, { ...view, machine: ["Suggested machine: ARM, 4 vCPU, 16 GB", "Why: <b>x</b>"] });
    expect(html).toContain("Suggested machine: ARM, 4 vCPU, 16 GB");
    expect(html).not.toContain("<b>x</b>");
    expect(html.indexOf("Machine size")).toBeGreaterThan(html.indexOf("Waiting for approval"));
  });
});
