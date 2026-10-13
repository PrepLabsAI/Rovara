import { describe, expect, it } from "vitest";
import { buildE2ESharedView } from "../../packages/contracts/src/e2e-view.js";

describe("complete shared E2E view", () => {
  it("keeps absent setup and current-round evidence visibly unavailable", () => {
    const view = buildE2ESharedView({ plan: null, currentRound: null, results: [], setup: null, actor: "viewer" });
    expect(view.setup.status).toBe("unavailable");
    expect(view.e2e.status).toBe("UNKNOWN");
    expect(view.e2e.executedCases).toBe(0);
    expect(view.actions).toEqual([]);
  });

  it("never offers owner actions to a viewer when a run is unavailable", () => {
    const view = buildE2ESharedView({ plan: null, currentRound: null, results: [], setup: { status: "needs-input", selectedTargetIds: [], executionPlanDigest: null, blockingInputIds: ["auth"], mockSubstitutableInputIds: [] }, actor: "viewer" });
    expect(view.setup.status).toBe("needs-input");
    expect(view.actions).toEqual([]);
  });
});
