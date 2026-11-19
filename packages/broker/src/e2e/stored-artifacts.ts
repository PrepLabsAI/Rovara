// The parts of `aws/workflow-e2e-artifacts.ts` that touch no cloud client (types, constants, the pure checks and views). `aws/workflow-e2e-artifacts.ts` and `core/e2e` both import them from here, so the ports
// version loads no cloud SDK.
import { type E2EScenarioResults } from "@agentx/contracts";

export type WorkflowE2EArtifact = Readonly<{ sha256: string; bytes: Uint8Array; contentType: "image/jpeg" }>;

/** The results with a screenshot link kept only where its object was stored. */
export function resultsWithStoredArtifacts(results: E2EScenarioResults, stored: ReadonlySet<string>): E2EScenarioResults {
  const keep = (row: E2EScenarioResults["scenarios"][number]) => {
    if (row.screenshotRef === undefined || stored.has(row.screenshotRef.sha256)) return row;
    const { screenshotRef: _dropped, ...rest } = row;
    void _dropped;
    return rest;
  };
  return { scenarios: results.scenarios.map(keep), ...(results.baseline === undefined ? {} : { baseline: { ...results.baseline, scenarios: results.baseline.scenarios.map(keep) } }) };
}
