import { describe, expect, it } from "vitest";
import { closedApplicationResults, unavailableApplicationView } from "../../packages/broker/src/core-host/e2e-results.js";
import { results } from "../support/e2e-scenario-results.js";

const TASK = "11111111-1111-4111-8111-111111111111";
describe("application eligibility and historical projection", () => {
  it("retains open-task eligibility wording and marks closed eligibility UNKNOWN", () => {
    const open = unavailableApplicationView();
    expect(open.e2e.workflowPhase).not.toBe("closed");
    expect(open.e2e.label).not.toContain("task closed");
    expect(unavailableApplicationView(true).e2e).toMatchObject({ status: "UNKNOWN", workflowPhase: "closed", label: "Current eligibility unavailable: task closed." });
  });
  it("projects an empty history without attempting to read a historical view", () => {
    const read = closedApplicationResults(TASK, undefined);
    expect(read.presentation.shared.e2e.status).toBe("UNKNOWN");
    expect(read.presentation.pageHtml).not.toContain("Recorded historical E2E result");
    expect(read).not.toHaveProperty("scenarioResults");
  });
  it("keeps a supplied capture visibly historical and forwards its scenario rows", () => {
    const scenarioResults = results();
    const capturedAt = "2026-11-22T00:00:00.000Z";
    const read = closedApplicationResults(TASK, { view: unavailableApplicationView(), capturedAt, candidateDigest: "a".repeat(64), roundId: "round", scenarioResults });
    expect(read.presentation.shared.e2e).toMatchObject({ status: "UNKNOWN", workflowPhase: "closed" });
    expect(read.presentation.pageHtml).toContain("Recorded historical E2E result");
    expect(read.presentation.pageHtml).toContain(capturedAt);
    expect(read.scenarioResults).toEqual(scenarioResults);
  });
});
